using Revalue.Server.Data;

namespace Revalue.Server.Features.Foundation.Counting;

public enum CountMetric
{
    /// <summary>可能性レポートまで進んだ人。</summary>
    ReachedReport,

    /// <summary>案を選んだ人。</summary>
    ChoseOption,
}

public sealed record StatsDto(long ReachedReport, long ChoseOption);

/// <summary>その人の「数えたしるし」。人ごとに 1 回だけ数えるために、その人のパーティションに置く。</summary>
public sealed record CountedMarkItem : Item;

public interface ICounter
{
    /// <summary>その人をその指標で一度だけ数える。何度呼んでも 1 回だけ増える。</summary>
    Task CountOnceAsync(string userKey, CountMetric metric, CancellationToken ct);

    Task<StatsDto> GetAsync(CancellationToken ct);
}

/// <summary>
/// 人と結びつかない数。数のアイテムは global に置き、利用者キーも日時も持たない。
/// 全部消しても減らない（しるしは消えるが、数は残る）。
/// </summary>
public sealed class Counter(IDataStore store) : ICounter
{
    public async Task CountOnceAsync(string userKey, CountMetric metric, CancellationToken ct)
    {
        // しるしを読んでから書くと、同時に呼ばれたときにどれもしるしがないと読んで、何度も数えてしまう。
        // しるしは「なければ作る」で置き、作れた 1 回だけ数を増やす
        var mark = new CountedMarkItem { Id = $"counted-{MetricName(metric)}", UserKey = userKey, Type = "counted" };
        if (await store.TryCreateAsync(mark, ct))
        {
            await store.IncrementAsync(DataConstants.GlobalPartition, $"count-{MetricName(metric)}", "count", null, ct);
        }
    }

    public async Task<StatsDto> GetAsync(CancellationToken ct) => new(
        await ReadAsync(CountMetric.ReachedReport, ct),
        await ReadAsync(CountMetric.ChoseOption, ct));

    private async Task<long> ReadAsync(CountMetric metric, CancellationToken ct) =>
        (await store.GetAsync<CountItem>(DataConstants.GlobalPartition, $"count-{MetricName(metric)}", ct))?.Count ?? 0;

    private static string MetricName(CountMetric metric) => metric switch
    {
        CountMetric.ReachedReport => "reached-report",
        CountMetric.ChoseOption => "chose-option",
        _ => throw new ArgumentOutOfRangeException(nameof(metric)),
    };
}
