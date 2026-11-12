using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace SysMon.Agent.Transport;

public sealed record Sample(DateTimeOffset Ts, Dictionary<string, double?> M);

public sealed record Batch(Guid Epoch, long Seq, DateTimeOffset CreatedAt, IReadOnlyList<Sample> Samples);

/// <summary>Sinirlar: toplam bayt VE yas; hangisi once dolarsa en eski segment atilir (tek segment asla atilmaz).</summary>
public sealed record SpoolLimits(long MaxBytes, TimeSpan MaxAge, long SegmentBytes);

/// <summary>Batch'leri kalici olarak kabul eden hedef (hatti spool'dan ayirir; hata enjeksiyonu icin de kullanilir).</summary>
public interface IBatchSink
{
    Batch Enqueue(IReadOnlyList<Sample> samples);
}

/// <summary>
/// Disk uzerinde JSON-lines segmentleri + atomik yazilan durum dosyasi.
/// Her batch kendi (epoch, seq) degerini tasir; durum dosyasi bozulursa yeni epoch uretilir,
/// eski batch'ler kendi epoch'lariyla okunmaya ve gonderilmeye devam eder.
/// Yalnizca aktif (son) segment duz metindir ve eklenir; dolan segmentler gzip'lenip muhurlenir (ADR 0003).
/// BELLEK: bellekte yalnizca batch INDEKSI (epoch, seq, olusma zamani) tutulur; batch icerigi, gonderilecegi
/// zaman en eski segmentten diske okunur (inceleme K3: tum spool'un RAM'de tutulmasi 24 saatlik kesintide GB'lara cikabilirdi).
/// </summary>
public sealed partial class Spool : IBatchSink
{
    private sealed record State(Guid Epoch, long NextSeq, Guid AckedEpoch, long AckedSeq, long ClockOffsetMs);

    private sealed record BatchRef(Guid Epoch, long Seq, DateTimeOffset CreatedAt);

    private sealed class Segment
    {
        public required int Index { get; init; }
        public required string Path { get; set; }
        public bool Sealed { get; set; }
        public List<BatchRef> Refs { get; } = [];
        public long Bytes { get; set; }
    }

    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };

    [GeneratedRegex(@"^seg-(\d{8})\.jsonl(\.gz)?$")]
    private static partial Regex SegmentName();

    private readonly string _dir;
    private readonly SpoolLimits _limits;
    private readonly Func<DateTimeOffset> _now;
    private readonly Action<int>? _onDropped;
    private readonly object _gate = new();
    private readonly List<Segment> _segments = [];
    private State _state;
    private int _nextSegmentIndex;
    private (int SegmentIndex, List<Batch> Batches)? _headCache;

    public long DroppedBatches { get; private set; }

    public Spool(string dir, SpoolLimits limits, Func<DateTimeOffset> now, Action<int>? onDropped = null)
    {
        _dir = dir;
        _limits = limits;
        _now = now;
        _onDropped = onDropped;
        Directory.CreateDirectory(dir);
        _state = LoadState();
        LoadSegments();
    }

    public int PendingCount
    {
        get { lock (_gate) return _segments.Sum(s => s.Refs.Count); }
    }

    public long TotalBytes
    {
        get { lock (_gate) return _segments.Sum(s => s.Bytes); }
    }

    public TimeSpan ClockOffset
    {
        get { lock (_gate) return TimeSpan.FromMilliseconds(_state.ClockOffsetMs); }
    }

    public void SetClockOffset(TimeSpan offset)
    {
        lock (_gate)
        {
            _state = _state with { ClockOffsetMs = (long)offset.TotalMilliseconds };
            SaveState();
        }
    }

    public Batch Enqueue(IReadOnlyList<Sample> samples)
    {
        lock (_gate)
        {
            var batch = new Batch(_state.Epoch, _state.NextSeq, _now(), samples);

            var last = _segments.Count > 0 ? _segments[^1] : null;
            Segment seg;
            if (last is { Sealed: false } && last.Bytes < _limits.SegmentBytes)
            {
                seg = last;
            }
            else
            {
                if (last is { Sealed: false }) SealSegment(last);
                seg = NewSegment();
            }

            // Once yaz (fsync), SONRA seq ilerlet: yazma basarisiz olursa seq bosluğu olusmaz.
            // Yazma sonrasi cokersek state.json geride kalir; acilista NextSeq segmentlerden uzlastirilir.
            var line = JsonSerializer.Serialize(batch, Json) + "\n";
            var bytes = Encoding.UTF8.GetBytes(line);
            AppendDurably(seg, bytes);
            seg.Bytes += bytes.Length;
            seg.Refs.Add(new BatchRef(batch.Epoch, batch.Seq, batch.CreatedAt));
            if (_headCache?.SegmentIndex == seg.Index) _headCache = null;

            _state = _state with { NextSeq = _state.NextSeq + 1 };
            try { SaveState(); }
            catch (IOException) { /* acilista NextSeq uzlastirilir */ }

            EnforceLimits();
            return batch;
        }
    }

    /// <summary>
    /// Satiri segmentin SON GECERLI sinirina (seg.Bytes) ekler ve fsync eder. Onceki basarisiz bir yazmadan kalan
    /// '\n'siz kalinti varsa once kirpilir (I-2): aksi halde yeni satir kalintiya yapisip gecersiz JSON olur ve batch kaybolur.
    /// Yazma hatasinda dosya yine son gecerli boyuta geri kirpilir (en iyi caba) ve istisna yeniden firlatilir.
    /// </summary>
    private static void AppendDurably(Segment seg, byte[] bytes)
    {
        using var fs = new FileStream(seg.Path, FileMode.OpenOrCreate, FileAccess.Write, FileShare.Read);
        try
        {
            if (fs.Length != seg.Bytes) fs.SetLength(seg.Bytes);
            fs.Seek(seg.Bytes, SeekOrigin.Begin);
            fs.Write(bytes);
            fs.Flush(true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            try { fs.SetLength(seg.Bytes); } catch (Exception) { /* sonraki Enqueue ayni kirpmayi yeniden dener */ }
            throw;
        }
    }

    /// <summary>Gonderilecek en eski batch (icerigi diskten okunur). Diskte bulunamayan indeks girdileri atlanir, SAYILIR ve bildirilir.</summary>
    public Batch? PeekOldest()
    {
        lock (_gate)
        {
            while (true)
            {
                var seg = _segments.FirstOrDefault(s => s.Refs.Count > 0);
                if (seg is null) return null;
                var head = seg.Refs[0];

                var batches = GetHeadBatches(seg);
                var found = batches.FirstOrDefault(b => b.Epoch == head.Epoch && b.Seq == head.Seq);
                if (found is not null) return found;

                // Indeks var ama veri okunamiyor (silinmis/bozuk): bu girdiyi dusur ve siradakine gec.
                seg.Refs.RemoveAt(0);
                _headCache = null;
                DroppedBatches++;
                try { _onDropped?.Invoke(1); }
                catch (Exception) { /* bildirim hatasi spool'u etkilemez */ }
                if (seg.Refs.Count == 0) DeleteSegment(seg);
            }
        }
    }

    /// <summary>
    /// Verilen batch dahil, dosya sirasina gore ondeki tum batch'leri siler.
    /// Batch kuyrukta YOKSA (ornegin ucustayken limit nedeniyle atildi) hicbir seye dokunmaz.
    /// </summary>
    public void Ack(Batch acked)
    {
        lock (_gate)
        {
            var segIdx = _segments.FindIndex(s => s.Refs.Any(r => r.Epoch == acked.Epoch && r.Seq == acked.Seq));
            if (segIdx < 0) return;

            for (var i = 0; i < segIdx; i++) _segments[i].Refs.Clear();
            var seg = _segments[segIdx];
            var refIdx = seg.Refs.FindIndex(r => r.Epoch == acked.Epoch && r.Seq == acked.Seq);
            seg.Refs.RemoveRange(0, refIdx + 1);
            _headCache = null;

            _state = _state with { AckedEpoch = acked.Epoch, AckedSeq = acked.Seq };
            SaveState();
            foreach (var s in _segments.Where(s => s.Refs.Count == 0).ToList()) DeleteSegment(s);
        }
    }

    private List<Batch> GetHeadBatches(Segment seg)
    {
        if (_headCache is { } c && c.SegmentIndex == seg.Index) return c.Batches;
        var list = new List<Batch>();
        foreach (var line in ReadLines(seg.Path, seg.Sealed))
        {
            try
            {
                var b = JsonSerializer.Deserialize<Batch>(line, Json);
                if (b is not null) list.Add(b);
            }
            catch (JsonException) { /* bozuk satir atlanir */ }
        }
        _headCache = (seg.Index, list);
        return list;
    }

    private void EnforceLimits()
    {
        // Tek segment asla atilmaz: yeni yazilan veri korunur (saat atlamasi/yanlis RTC yuzunden yeni batch'in
        // silinmesini onler). Tek segment en fazla SegmentBytes kadardir, bayt siniri zaten korunur.
        while (_segments.Count > 1)
        {
            var oldest = _segments[0];
            var tooOld = oldest.Refs.Count > 0 && _now() - oldest.Refs[0].CreatedAt > _limits.MaxAge;
            var tooBig = _segments.Sum(s => s.Bytes) > _limits.MaxBytes;
            if (!tooOld && !tooBig) break;
            var n = oldest.Refs.Count;
            DroppedBatches += n;
            DeleteSegment(oldest);
            if (n > 0)
            {
                try { _onDropped?.Invoke(n); }
                catch (Exception) { /* bildirim hatasi spool'u etkilemez */ }
            }
        }
    }

    private Segment NewSegment()
    {
        var index = _nextSegmentIndex++;
        var seg = new Segment { Index = index, Path = System.IO.Path.Combine(_dir, $"seg-{index:D8}.jsonl") };
        _segments.Add(seg);
        return seg;
    }

    /// <summary>
    /// Duz segmenti gzip'ler: once .gz.tmp'ye yaz, sonra .gz'ye tasi, en son duz dosyayi sil.
    /// Herhangi bir adimda cokme olursa acilista tutarli hale getirilir (bkz. LoadSegments).
    /// </summary>
    private void SealSegment(Segment seg)
    {
        var gzPath = seg.Path + ".gz";
        var tmp = gzPath + ".tmp";
        using (var src = new FileStream(seg.Path, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var dst = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            using (var gz = new GZipStream(dst, CompressionLevel.Optimal, leaveOpen: true)) src.CopyTo(gz);
            dst.Flush(true);
        }
        File.Move(tmp, gzPath, overwrite: true);
        File.Delete(seg.Path);
        seg.Path = gzPath;
        seg.Sealed = true;
        seg.Bytes = new FileInfo(gzPath).Length;
        if (_headCache?.SegmentIndex == seg.Index) _headCache = null;
    }

    private void DeleteSegment(Segment seg)
    {
        _segments.Remove(seg);
        if (_headCache?.SegmentIndex == seg.Index) _headCache = null;
        try { File.Delete(seg.Path); } catch (IOException) { /* sonraki acilista yeniden okunur */ }
    }

    private void LoadSegments()
    {
        foreach (var tmp in Directory.GetFiles(_dir, "seg-*.tmp"))
        {
            try { File.Delete(tmp); } catch (IOException) { /* sonraki acilista tekrar denenir */ }
        }

        var byIndex = new SortedDictionary<int, (string? Raw, string? Gz)>();
        foreach (var path in Directory.GetFiles(_dir, "seg-*"))
        {
            var m = SegmentName().Match(System.IO.Path.GetFileName(path));
            if (!m.Success) continue;
            var idx = int.Parse(m.Groups[1].Value);
            byIndex.TryGetValue(idx, out var cur);
            byIndex[idx] = m.Groups[2].Success ? (cur.Raw, path) : (path, cur.Gz);
        }

        foreach (var (idx, files) in byIndex)
        {
            string path;
            var isGz = files.Gz is not null;
            if (isGz)
            {
                path = files.Gz!;
                // Sikistirma tamamlanmis ama duz dosya silinmeden cokulmus: gz gecerli, duz dosya fazlalik.
                if (files.Raw is not null)
                {
                    try { File.Delete(files.Raw); } catch (IOException) { /* tekrar denenir */ }
                }
            }
            else
            {
                path = files.Raw!;
            }

            var seg = new Segment { Index = idx, Path = path, Sealed = isGz, Bytes = new FileInfo(path).Length };
            // Akis halinde oku; yalnizca indeks tut (batch nesneleri hemen birakilir).
            foreach (var line in ReadLines(path, isGz))
            {
                try
                {
                    var b = JsonSerializer.Deserialize<Batch>(line, Json);
                    if (b is not null) seg.Refs.Add(new BatchRef(b.Epoch, b.Seq, b.CreatedAt));
                }
                catch (JsonException) { /* yarim yazilmis/bozuk satir atlanir */ }
            }
            _nextSegmentIndex = Math.Max(_nextSegmentIndex, idx + 1);
            _segments.Add(seg);
        }

        // Yalnizca en yuksek indeksli segment aktif olabilir; onceki duz segmentler muhurlanir.
        foreach (var seg in _segments.Take(Math.Max(0, _segments.Count - 1)).Where(s => !s.Sealed).ToList())
            SealSegment(seg);

        // Cokmeden kalan yarim satir: aktif segment '\n' ile bitmiyorsa sonraki ekleme son satira yapismasin.
        if (_segments.Count > 0 && _segments[^1] is { Sealed: false } active && EndsWithoutNewline(active.Path))
        {
            File.AppendAllText(active.Path, "\n");
            active.Bytes += 1;
        }

        // NextSeq uzlastirma: eski/kayip state.json ayni epoch'ta seq'i geri sarmasin (yinelenen seq sunucuda sessizce atilirdi).
        var maxSeq = _segments.SelectMany(s => s.Refs).Where(r => r.Epoch == _state.Epoch).Select(r => r.Seq).DefaultIfEmpty(-1).Max();
        if (maxSeq + 1 > _state.NextSeq)
        {
            _state = _state with { NextSeq = maxSeq + 1 };
            SaveState();
        }

        // Ack isaretini uygula: isaretli batch dahil oncekiler gonderilmis sayilir.
        var all = _segments.SelectMany(s => s.Refs.Select(r => (s, r))).ToList();
        var ackIdx = all.FindIndex(x => x.r.Epoch == _state.AckedEpoch && x.r.Seq == _state.AckedSeq);
        if (ackIdx >= 0)
        {
            var acked = new HashSet<BatchRef>(all.Take(ackIdx + 1).Select(x => x.r));
            foreach (var seg in _segments) seg.Refs.RemoveAll(acked.Contains);
            foreach (var seg in _segments.Where(s => s.Refs.Count == 0).ToList()) DeleteSegment(seg);
        }
    }

    private static bool EndsWithoutNewline(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        if (fs.Length == 0) return false;
        fs.Seek(-1, SeekOrigin.End);
        return fs.ReadByte() != '\n';
    }

    private static IEnumerable<string> ReadLines(string path, bool gz)
    {
        FileStream fs;
        try
        {
            fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
        {
            yield break; // dosya diskten kaybolmus
        }

        using (fs)
        {
            Stream stream = gz ? new GZipStream(fs, CompressionMode.Decompress) : fs;
            using var sr = new StreamReader(stream);
            while (true)
            {
                string? l;
                try { l = sr.ReadLine(); }
                catch (InvalidDataException) { yield break; } // bozuk/kesik gzip: okunabilen kismi kullan
                if (l is null) yield break;
                yield return l;
            }
        }
    }

    private string StatePath => System.IO.Path.Combine(_dir, "state.json");

    private State LoadState()
    {
        try
        {
            if (File.Exists(StatePath))
            {
                var s = JsonSerializer.Deserialize<State>(File.ReadAllText(StatePath), Json);
                if (s is not null && s.Epoch != Guid.Empty) return s;
            }
        }
        catch (JsonException) { /* bozuk durum: yeni epoch */ }
        var fresh = new State(Guid.NewGuid(), 0, Guid.Empty, -1, 0);
        _state = fresh;
        SaveState();
        return fresh;
    }

    /// <summary>Atomik ve kalici yazim: gecici dosyaya yaz, fsync, sonra uzerine tasi.</summary>
    private void SaveState()
    {
        var tmp = StatePath + ".tmp";
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(_state, Json));
        using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            fs.Write(bytes);
            fs.Flush(true);
        }
        File.Move(tmp, StatePath, overwrite: true);
    }
}
