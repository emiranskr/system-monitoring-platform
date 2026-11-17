using System.Diagnostics;
using System.IO.Pipes;
using SysMon.Agent.Sensors;

// YALNIZ TEST. Uretim yardimcisiyla ayni katı argumanlar; davranis SYSMON_TEST_MODE ortam degiskeniyle secilir.
// Modlar: ok | crash | hang | garbage | spawn
if (!HelperArgs.TryParse(args, out var a) || a is null) return 2;
var mode = Environment.GetEnvironmentVariable("SYSMON_TEST_MODE") ?? "ok";

switch (mode)
{
    case "crash":
        return 5;

    case "spawn":
    {
        // cocuk surec olusturmayi dener: Job Object ActiveProcessLimit=1 ile engellenmeli
        try
        {
            using var child = Process.Start(new ProcessStartInfo("cmd.exe", "/c exit 7") { UseShellExecute = false, CreateNoWindow = true });
            if (child is null) return 99;
            child.WaitForExit(5000);
            return child.HasExited ? child.ExitCode : 98;
        }
        catch (Exception) { return 99; }
    }

    case "hang":
    {
        // pipe'i acar (baglanti kabul edilebilir) ama ASLA cevap vermez
        var s = new SensorPipeServer(a.PipeName, new NullSensorProvider(), a.AllowedSid, null, TimeSpan.FromSeconds(3));
        s.Start();
        await Task.Delay(Timeout.Infinite);
        return 0;
    }

    case "garbage":
    {
        // dogru PID ile baglanilir ama yanit 4 KiB siniri asar
        await using var raw = new NamedPipeServerStream(a.PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        await raw.WaitForConnectionAsync();
        var req = new byte[2];
        await raw.ReadExactlyAsync(req);
        await raw.WriteAsync(BitConverter.GetBytes((uint)SensorProtocol.MaxPayloadBytes + 1));
        await raw.FlushAsync();
        await Task.Delay(Timeout.Infinite);
        return 0;
    }

    default: // ok
    {
        var server = new SensorPipeServer(a.PipeName, new FixedProvider(), a.AllowedSid, a.ParentPid, TimeSpan.FromSeconds(3));
        server.Start();
        await server.RunAsync(CancellationToken.None);
        return 0;
    }
}

sealed class FixedProvider : ISensorProvider
{
    public string Name => "fixed";
    public Task<IReadOnlyList<SensorReading>> ReadAllAsync(CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<SensorReading>>([new SensorReading(SensorId.CpuPackageTempC, SensorStatus.Ok, 61.0)]);
}
