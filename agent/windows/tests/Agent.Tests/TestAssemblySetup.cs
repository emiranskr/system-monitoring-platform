using System.Runtime.CompilerServices;

namespace Agent.Tests;

/// <summary>
/// Bazi testler is parcacigi havuzu iscilerini bilerek bloke eder (Thread.Sleep, ManualResetEvent.Wait, senkron gercek
/// dosya/ag G/C'si) ve xUnit test siniflarini paralel kosturur. Havuz varsayilan minimum iscide kalirsa yeni isci eklemeyi
/// ~500 ms'de bir yapar: ayni surecteki zamana bagimli testler (Task.Run + kisa zaman asimi) aralikli kiriliyordu.
/// Bunu bir kez, test derlemesi duzeyinde gideririz; uretim koduna dokunmaz.
/// </summary>
internal static class TestAssemblySetup
{
    [ModuleInitializer]
    internal static void RaiseThreadPoolMinimum()
    {
        ThreadPool.GetMinThreads(out var worker, out var io);
        ThreadPool.SetMinThreads(Math.Max(worker, 64), Math.Max(io, 64));
    }
}
