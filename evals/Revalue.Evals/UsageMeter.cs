using Revalue.Server.Ai;

namespace Revalue.Evals;

/// <summary>呼び出しの種類ごとに合計したトークン数。</summary>
public sealed record UsageTotal(string Call, int Calls, long InputTokens, long CacheReadTokens, long CacheWriteTokens, long OutputTokens);

/// <summary>評価で使ったトークン数を、呼び出しの種類（read、reply、judge）ごとに足し合わせる。</summary>
public sealed class UsageMeter : IAiUsageMeter
{
    private readonly object _gate = new();
    private readonly Dictionary<string, UsageTotal> _totals = new(StringComparer.Ordinal);

    public void Record(AiUsage usage)
    {
        lock (_gate)
        {
            var current = _totals.GetValueOrDefault(usage.Call) ?? new UsageTotal(usage.Call, 0, 0, 0, 0, 0);
            _totals[usage.Call] = current with
            {
                Calls = current.Calls + 1,
                InputTokens = current.InputTokens + usage.InputTokens,
                CacheReadTokens = current.CacheReadTokens + usage.CacheReadTokens,
                CacheWriteTokens = current.CacheWriteTokens + usage.CacheWriteTokens,
                OutputTokens = current.OutputTokens + usage.OutputTokens,
            };
        }
    }

    public IReadOnlyList<UsageTotal> Totals
    {
        get
        {
            lock (_gate)
            {
                return _totals.Values.OrderBy(t => t.Call, StringComparer.Ordinal).ToList();
            }
        }
    }
}
