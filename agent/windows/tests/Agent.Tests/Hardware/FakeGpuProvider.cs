using SysMon.Agent.Hardware;

namespace Agent.Tests.Hardware;

/// <summary>Testler icin sahte GPU saglayicisi (NVML/PDH/LHM olmadan HAL davranislarini sinar).</summary>
public sealed class FakeGpuProvider(string id, int priority, IReadOnlyList<GpuDevice> devices) : IGpuProvider
{
    public string Id { get; } = id;
    public int Priority { get; } = priority;
    public IReadOnlyList<GpuDevice> Devices { get; } = devices;
    public bool Available { get; set; } = true;
    public GpuSample Sample { get; set; } = new();
    public GpuCapabilities Caps { get; set; } = GpuCapabilities.All;
    public bool BlockForever { get; set; }
    public bool IgnoreToken { get; set; }
    public Exception? ThrowOnRead { get; set; }
    public Exception? ThrowOnDiscover { get; set; }

    private int _discoverCalls;
    public int DiscoverCalls => _discoverCalls;

    public bool IsAvailable() => Available;

    public Task<IReadOnlyList<GpuDevice>> DiscoverAsync(CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        Interlocked.Increment(ref _discoverCalls);
        if (ThrowOnDiscover is not null) throw ThrowOnDiscover;
        return Task.FromResult<IReadOnlyList<GpuDevice>>(Available ? Devices : []);
    }

    public async Task<GpuSample> ReadAsync(GpuDevice d, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (ThrowOnRead is not null) throw ThrowOnRead;
        if (BlockForever) await Task.Delay(Timeout.Infinite, IgnoreToken ? CancellationToken.None : ct);
        return Sample;
    }

    public GpuCapabilities Capabilities(GpuDevice d) => Caps;
}
