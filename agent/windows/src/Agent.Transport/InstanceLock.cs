namespace SysMon.Agent.Transport;

/// <summary>
/// Veri dizini basina tek ornek: konsol modu ile servis (veya iki servis) ayni spool ve state.json dosyalarina
/// ayni anda yazip onlari bozmasin. Dosya kilidi surec olunce isletim sistemi tarafindan birakilir.
/// </summary>
public sealed class InstanceLock : IDisposable
{
    private readonly FileStream _stream;

    private InstanceLock(FileStream stream) => _stream = stream;

    /// <summary>Kilit alinamazsa (baska ornek calisiyor) null.</summary>
    public static InstanceLock? TryAcquire(string dataDir)
    {
        Directory.CreateDirectory(dataDir);
        try
        {
            var fs = new FileStream(Path.Combine(dataDir, "agent.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            return new InstanceLock(fs);
        }
        catch (IOException)
        {
            return null;
        }
    }

    public void Dispose() => _stream.Dispose();
}
