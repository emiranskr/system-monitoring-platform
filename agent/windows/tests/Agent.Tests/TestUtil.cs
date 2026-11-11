namespace Agent.Tests;

public static class TestUtil
{
    /// <summary>Sabit sure beklemek yerine kosul saglanana kadar bekler (yuk altinda kararsiz zamanlama testlerini onler).</summary>
    public static async Task WaitUntil(Func<bool> condition, int timeoutMs = 20_000, string? because = null)
    {
        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (!condition())
        {
            if (DateTime.UtcNow > deadline)
                throw new TimeoutException($"Kosul {timeoutMs} ms icinde saglanmadi. {because}");
            await Task.Delay(20);
        }
    }
}
