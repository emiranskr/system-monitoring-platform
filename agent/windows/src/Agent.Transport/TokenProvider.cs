namespace SysMon.Agent.Transport;

/// <summary>
/// Token okuma durumunu izler ve YALNIZCA durum degisiminde loglar (inceleme I-4): yok / okunamadi / yuklendi.
/// Token DEGERI hicbir zaman loglanmaz. Okunamazsa bos doner (eski deger bellekte tutulup kullanilmaz);
/// cagiran bos token ile sunucuya istek GONDERMEMELIDIR.
/// </summary>
public sealed class TokenProvider(
    string path, Func<(bool Ok, string? Token)> load, Func<bool> exists, Action<string> info, Action<string> warn)
{
    private enum State { Unknown, Loaded, Missing, Unreadable }

    private readonly object _gate = new();
    private State _state = State.Unknown;

    public string Get()
    {
        string? token = null;
        var state = State.Missing;
        try
        {
            if (exists())
            {
                var (ok, t) = load();
                if (ok && !string.IsNullOrEmpty(t)) { token = t; state = State.Loaded; }
                else state = State.Unreadable;
            }
        }
        catch (Exception)
        {
            state = State.Unreadable;
        }

        Note(state);
        return token ?? "";
    }

    private void Note(State state)
    {
        lock (_gate)
        {
            if (state == _state) return;
            _state = state;
        }
        try
        {
            switch (state)
            {
                case State.Loaded:
                    info($"Token yuklendi: {path}");
                    break;
                case State.Missing:
                    warn($"Korumali token deposu yok: {path}. Yukleme token aktarilana kadar bekler (--import-token).");
                    break;
                default:
                    warn($"Korumali token okunamadi: {path} (bozuk, baska makineye ait veya erisim izni yok). Yukleme beklemede.");
                    break;
            }
        }
        catch (Exception) { /* log hatasi yukleme dongusunu durdurmaz */ }
    }
}
