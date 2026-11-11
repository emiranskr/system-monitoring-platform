using System.Text;
using Microsoft.Extensions.Logging;

namespace SysMon.Agent;

/// <summary>
/// Servis modunda teshis icin dosya gunlugu (olay gunlugu kaynagi kayitli degilse veya yazilamazsa hata gorunmez kalir).
/// Information ve ustu yazilir. Boyut asilinca agent.log -> agent.log.1 doner (tek yedek). Gunluk yazma hicbir
/// zaman istisna firlatmaz: gunlukleme basarisizligi agent'i durdurmamali.
/// </summary>
public sealed class FileLoggerProvider(string path, long maxBytes = 5_000_000) : ILoggerProvider
{
    private readonly object _gate = new();

    public ILogger CreateLogger(string categoryName) => new FileLogger(this, categoryName);

    public void Dispose()
    {
    }

    internal void Write(LogLevel level, string category, string message, Exception? ex)
    {
        var sb = new StringBuilder()
            .Append(DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"))
            .Append(" [").Append(level).Append("] ").Append(category).Append(": ").Append(message);
        if (ex is not null) sb.Append(Environment.NewLine).Append(ex);
        sb.AppendLine();

        lock (_gate)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                if (File.Exists(path) && new FileInfo(path).Length >= maxBytes)
                    File.Move(path, path + ".1", overwrite: true);
                File.AppendAllText(path, sb.ToString());
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
            {
                // Gunlukleme asla uygulamayi dusurmez.
            }
        }
    }

    private sealed class FileLogger(FileLoggerProvider owner, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Information;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel)) return;
            owner.Write(logLevel, category, formatter(state, exception), exception);
        }
    }
}
