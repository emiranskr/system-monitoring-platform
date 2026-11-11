using SysMon.Agent.Transport;

namespace Agent.Tests.Transport;

public sealed class InstanceLockTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "sysmon-lock-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, true);
    }

    [Fact]
    public void Ikinci_ornek_ayni_veri_dizinini_alamaz_birincisi_birakilinca_alabilir()
    {
        using (var first = InstanceLock.TryAcquire(_dir))
        {
            Assert.NotNull(first);
            Assert.Null(InstanceLock.TryAcquire(_dir)); // konsol + servis ayni dizinde calisamaz
        }
        using var again = InstanceLock.TryAcquire(_dir);
        Assert.NotNull(again);
    }
}
