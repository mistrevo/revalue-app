using Revalue.Server.Data;
using Revalue.Server.Features.Discover;

namespace Revalue.Server.Features.Report;

/// <summary>
/// 本人が場面を飛ばしたときに、飛ばしたやりとりのあいだに作ったレポートの版を捨てる（07-report.md の「版を残す」）。
/// 版は根拠の言葉を写さないが、力の名前は残す。飛ばしたやりとりからだけ出た力の名前を、前の版に残さないため。
/// </summary>
public static class ReportScrub
{
    /// <summary>
    /// 飛ばしたやりとりが始まった時点。続きを話していた場面なら続きの問いを足した時点、そうでなければ場面を始めた時点。
    /// </summary>
    public static DateTimeOffset SkippedSince(EpisodeItem skipped) =>
        skipped.BeforeResume is { } point && point.TurnCount < skipped.Turns.Count
            ? skipped.Turns[point.TurnCount].At
            : skipped.StartedAt;

    /// <summary>飛ばしたやりとりが始まった時点より後の版を捨てる。失敗しても、飛ばすのは成功のまま（ログには種類だけを書く）。</summary>
    public static async Task TryAfterSkipAsync(
        IDataStore store, string userKey, EpisodeItem skipped, TimeProvider time, ILogger logger, CancellationToken ct)
    {
        try
        {
            var since = SkippedSince(skipped);
            await ReportStore.UpdateAsync(store, userKey, item => item.WithoutVersionsAfter(since), time, ct);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogWarning("Removing the report versions after a skip failed with {ErrorType}.", e.GetType().Name);
        }
    }
}
