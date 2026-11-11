using System.Text.Json;

namespace SysMon.Agent.Transport;

public sealed record Sample(DateTimeOffset Ts, Dictionary<string, double?> M);

public sealed record Batch(Guid Epoch, long Seq, DateTimeOffset CreatedAt, IReadOnlyList<Sample> Samples);

/// <summary>Sinirlar: toplam bayt VE yas; hangisi once dolarsa en eski segment atilir.</summary>
public sealed record SpoolLimits(long MaxBytes, TimeSpan MaxAge, long SegmentBytes);

/// <summary>
/// Disk uzerinde JSON-lines segmentleri + atomik yazilan durum dosyasi.
/// Her batch kendi (epoch, seq) degerini tasir; durum dosyasi bozulursa yeni epoch uretilir,
/// eski batch'ler kendi epoch'lariyla okunmaya ve gonderilmeye devam eder.
/// </summary>
public sealed class Spool
{
    private sealed record State(Guid Epoch, long NextSeq, Guid AckedEpoch, long AckedSeq, long ClockOffsetMs);

    private sealed class Segment
    {
        public required string Path { get; init; }
        public List<Batch> Batches { get; } = [];
        public long Bytes { get; set; }
    }

    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };

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

            var seg = _segments.Count > 0 && _segments[^1].Bytes < _limits.SegmentBytes
                ? _segments[^1]
                : NewSegment();
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
            if (!(tooOld || tooBig) || _segments.Count == 1 && !tooOld && !tooBig) break;
            if (_segments.Count == 1 && !tooOld) break; // tek ve en yeni segmenti boyuttan dolayi atma
            DroppedBatches += oldest.Batches.Count;
            DeleteSegment(oldest);
        }
    }

    private Segment NewSegment()
    {
        var seg = new Segment { Path = Path.Combine(_dir, $"seg-{_nextSegmentIndex++:D8}.jsonl") };
        _segments.Add(seg);
        return seg;
    }

    private void DeleteSegment(Segment seg)
    {
        _segments.Remove(seg);
        try { File.Delete(seg.Path); } catch (IOException) { /* sonraki acilista yeniden okunur */ }
    }

    private void LoadSegments()
    {
        foreach (var path in Directory.GetFiles(_dir, "seg-*.jsonl").OrderBy(p => p, StringComparer.Ordinal))
        {
            var seg = new Segment { Path = path, Bytes = new FileInfo(path).Length };
            foreach (var line in File.ReadLines(path))
            {
                try
                {
                    var b = JsonSerializer.Deserialize<Batch>(line, Json);
                    if (b is not null) seg.Batches.Add(b);
                }
                catch (JsonException) { /* yarim yazilmis/bozuk satir atlanir */ }
            }
            var n = int.Parse(Path.GetFileNameWithoutExtension(path)["seg-".Length..]);
            _nextSegmentIndex = Math.Max(_nextSegmentIndex, n + 1);
            _segments.Add(seg);
        }

        // Ack isaretini uygula: isaretli batch dahil oncekiler gonderilmis sayilir.
        var all = _segments.SelectMany((s, i) => s.Batches.Select(b => (s, b))).ToList();
        var ackIdx = all.FindIndex(x => x.b.Epoch == _state.AckedEpoch && x.b.Seq == _state.AckedSeq);
        if (ackIdx >= 0)
        {
            foreach (var seg in _segments) seg.Batches.RemoveAll(b => all.FindIndex(x => x.b == b) <= ackIdx);
            foreach (var seg in _segments.Where(s => s.Batches.Count == 0).ToList()) DeleteSegment(seg);
        }
    }

    private string StatePath => Path.Combine(_dir, "state.json");

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
