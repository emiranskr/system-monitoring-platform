using System.IO.Compression;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace SysMon.Agent.Transport;

public sealed record Sample(DateTimeOffset Ts, Dictionary<string, double?> M);

public sealed record Batch(Guid Epoch, long Seq, DateTimeOffset CreatedAt, IReadOnlyList<Sample> Samples);

/// <summary>Sinirlar: toplam bayt VE yas; hangisi once dolarsa en eski segment atilir.</summary>
public sealed record SpoolLimits(long MaxBytes, TimeSpan MaxAge, long SegmentBytes);

/// <summary>
/// Disk uzerinde JSON-lines segmentleri + atomik yazilan durum dosyasi.
/// Her batch kendi (epoch, seq) degerini tasir; durum dosyasi bozulursa yeni epoch uretilir,
/// eski batch'ler kendi epoch'lariyla okunmaya ve gonderilmeye devam eder.
/// Yalnizca aktif (son) segment duz metindir ve eklenir; dolan segmentler gzip'lenip muhurlenir
/// (ADR 0003: tekrarli metrik adlari nedeniyle yaklasik 10 kat kucultme).
/// </summary>
public sealed partial class Spool
{
    private sealed record State(Guid Epoch, long NextSeq, Guid AckedEpoch, long AckedSeq, long ClockOffsetMs);

    private sealed class Segment
    {
        public required int Index { get; init; }
        public required string Path { get; set; }
        public bool Sealed { get; set; }
        public List<Batch> Batches { get; } = [];
        public long Bytes { get; set; }
    }

    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };

    [GeneratedRegex(@"^seg-(\d{8})\.jsonl(\.gz)?$")]
    private static partial Regex SegmentName();

    private readonly string _dir;
    private readonly SpoolLimits _limits;
    private readonly Func<DateTimeOffset> _now;
    private readonly object _gate = new();
    private readonly List<Segment> _segments = [];
    private State _state;
    private int _nextSegmentIndex;

    public long DroppedBatches { get; private set; }

    public Spool(string dir, SpoolLimits limits, Func<DateTimeOffset> now)
    {
        _dir = dir;
        _limits = limits;
        _now = now;
        Directory.CreateDirectory(dir);
        _state = LoadState();
        LoadSegments();
    }

    public int PendingCount
    {
        get { lock (_gate) return _segments.Sum(s => s.Batches.Count); }
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
            // Once durumu ilerlet: yazma sirasinda coksek seq yeniden kullanilmasin.
            _state = _state with { NextSeq = _state.NextSeq + 1 };
            SaveState();

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

            var line = JsonSerializer.Serialize(batch, Json) + "\n";
            File.AppendAllText(seg.Path, line);
            seg.Bytes += System.Text.Encoding.UTF8.GetByteCount(line);
            seg.Batches.Add(batch);

            EnforceLimits();
            return batch;
        }
    }

    public Batch? PeekOldest()
    {
        lock (_gate) return _segments.SelectMany(s => s.Batches).FirstOrDefault();
    }

    /// <summary>Verilen batch dahil, dosya sirasina gore ondeki tum batch'leri siler.</summary>
    public void Ack(Batch acked)
    {
        lock (_gate)
        {
            var found = false;
            foreach (var seg in _segments.ToList())
            {
                var idx = seg.Batches.FindIndex(b => b.Epoch == acked.Epoch && b.Seq == acked.Seq);
                if (idx >= 0)
                {
                    seg.Batches.RemoveRange(0, idx + 1);
                    found = true;
                }
                else if (!found)
                {
                    seg.Batches.Clear();
                }
                if (found) break;
            }
            if (!found) return;
            _state = _state with { AckedEpoch = acked.Epoch, AckedSeq = acked.Seq };
            SaveState();
            foreach (var seg in _segments.Where(s => s.Batches.Count == 0).ToList()) DeleteSegment(seg);
        }
    }

    private void EnforceLimits()
    {
        while (_segments.Count > 0)
        {
            var oldest = _segments[0];
            var tooOld = oldest.Batches.Count > 0 && _now() - oldest.Batches[0].CreatedAt > _limits.MaxAge;
            var tooBig = _segments.Sum(s => s.Bytes) > _limits.MaxBytes;
            if (!tooOld && !tooBig) break;
            if (_segments.Count == 1 && !tooOld) break; // tek ve en yeni segmenti boyuttan dolayi atma
            DroppedBatches += oldest.Batches.Count;
            DeleteSegment(oldest);
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
    }

    private void DeleteSegment(Segment seg)
    {
        _segments.Remove(seg);
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
            foreach (var line in ReadLines(path, isGz))
            {
                try
                {
                    var b = JsonSerializer.Deserialize<Batch>(line, Json);
                    if (b is not null) seg.Batches.Add(b);
                }
                catch (JsonException) { /* yarim yazilmis/bozuk satir atlanir */ }
            }
            _nextSegmentIndex = Math.Max(_nextSegmentIndex, idx + 1);
            _segments.Add(seg);
        }

        // Yalnizca en yuksek indeksli segment aktif olabilir; onceki duz segmentler muhurlanir.
        foreach (var seg in _segments.Take(Math.Max(0, _segments.Count - 1)).Where(s => !s.Sealed).ToList())
            SealSegment(seg);

        // Ack isaretini uygula: isaretli batch dahil oncekiler gonderilmis sayilir.
        var all = _segments.SelectMany(s => s.Batches).ToList();
        var ackIdx = all.FindIndex(b => b.Epoch == _state.AckedEpoch && b.Seq == _state.AckedSeq);
        if (ackIdx >= 0)
        {
            var acked = new HashSet<Batch>(all.Take(ackIdx + 1), ReferenceEqualityComparer.Instance as IEqualityComparer<Batch>);
            foreach (var seg in _segments) seg.Batches.RemoveAll(acked.Contains);
            foreach (var seg in _segments.Where(s => s.Batches.Count == 0).ToList()) DeleteSegment(seg);
        }
    }

    private static IEnumerable<string> ReadLines(string path, bool gz)
    {
        if (!gz)
        {
            // Aktif segment baska bir sureci beklemez; yine de paylasimli oku.
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var sr = new StreamReader(fs);
            while (sr.ReadLine() is { } line) yield return line;
            yield break;
        }
        using var gfs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        using var gz2 = new GZipStream(gfs, CompressionMode.Decompress);
        using var gsr = new StreamReader(gz2);
        string? l;
        while (true)
        {
            try { l = gsr.ReadLine(); }
            catch (InvalidDataException) { yield break; } // bozuk/kesik gzip: okunabilen kismi kullan
            if (l is null) yield break;
            yield return l;
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

    /// <summary>Atomik yazim: gecici dosyaya yaz, sonra uzerine tasi.</summary>
    private void SaveState()
    {
        var tmp = StatePath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(_state, Json));
        File.Move(tmp, StatePath, overwrite: true);
    }
}
