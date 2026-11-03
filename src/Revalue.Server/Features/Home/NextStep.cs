using System.Text.Json.Serialization;
using Revalue.Server.Data;
using Revalue.Server.Features.Deepen;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Home;

/// <summary>次にできること（00-common.md の「次にできること」）。</summary>
[JsonConverter(typeof(NamedEnumConverter<NextStepKind>))]
public enum NextStepKind
{
    /// <summary>話している途中の場面の続きを話す。</summary>
    [JsonStringEnumMemberName("continue")]
    Continue,

    /// <summary>最近のある一日のことを話す（新しい場面）。</summary>
    [JsonStringEnumMemberName("talk")]
    Talk,

    /// <summary>使える時間と場所を、5 つの記録に入れる。</summary>
    [JsonStringEnumMemberName("conditions")]
    Conditions,

    /// <summary>仕事の選択肢を見て、一つ選ぶか保留する。</summary>
    [JsonStringEnumMemberName("options")]
    Options,

    /// <summary>選んだ案を深める。</summary>
    [JsonStringEnumMemberName("deepen")]
    Deepen,

    /// <summary>可能性レポートで、ここまでのまとめを見る。</summary>
    [JsonStringEnumMemberName("report")]
    Report,
}

/// <summary>次にできること一つ。<paramref name="EpisodeId"/> は <see cref="NextStepKind.Continue"/> のときだけ、その場面の id。</summary>
public sealed record NextStepResult(NextStepKind Step, string? EpisodeId);

/// <summary>
/// いまの記録から、次にできることを一つだけ決める。AI は呼ばない。進み具合の点数や割合にはしない（芯 5（本人が選ぶ）。どこから進めてもよい）。
/// </summary>
public static class NextStep
{
    /// <summary>
    /// 上から順に、最初に当たるものを返す（Claude の判断）。
    /// 1. 話している途中の場面がある → 続きを話す
    /// 2. 話し終えた場面がない → 話す
    /// 3. 条件が入っていない → 条件を入れる
    /// 4. 使える力がない（本人が外した力だけのときも）→ 話す。外したのは本人が決めたことなので、外した見立てに戻すことは勧めない
    ///    （芯 5（本人が選ぶ）。戻す道は見えた力の画面と仕事の選択肢の画面に残す）
    /// 5. まだ選んでいない → 仕事の選択肢
    /// 6. 選んでいて、いまの案で深めた中身がない（または古い）→ 深める
    /// 7. それ以外（保留、深めた中身がある）→ レポート
    /// </summary>
    public static NextStepResult Decide(
        string? talkingEpisodeId, bool hasFinishedEpisode, Readiness readiness, DeepenReadiness deepenReadiness, bool deepened)
    {
        if (talkingEpisodeId is not null)
        {
            return new(NextStepKind.Continue, talkingEpisodeId);
        }

        var step =
            !hasFinishedEpisode ? NextStepKind.Talk
            : readiness == Readiness.NeedsConditions ? NextStepKind.Conditions
            : readiness is Readiness.NeedsAbility or Readiness.OnlyExcluded ? NextStepKind.Talk
            : deepenReadiness is DeepenReadiness.NoChoice or DeepenReadiness.NeedsConditions ? NextStepKind.Options
            : deepenReadiness == DeepenReadiness.Ready && !deepened ? NextStepKind.Deepen
            : NextStepKind.Report;
        return new(step, null);
    }

    /// <summary>記録を一度ずつ読んで決める。深めた中身が古いかは、07 report と同じく、いまの選んだ案の指紋と比べる。</summary>
    public static async Task<NextStepResult> ReadAsync(IDataStore store, string userKey, JobCatalog catalog, CancellationToken ct)
    {
        var episodes = await store.ListByTypeAsync<EpisodeItem>(userKey, EpisodeItem.ItemType, ct);
        // 途中の場面は 1 つだけのはずだが、もし複数あれば、いちばん新しく始めたもの（Claude の判断）
        var talking = episodes
            .Where(e => e.Status == EpisodeStatus.Talking)
            .OrderByDescending(e => e.StartedAt)
            .FirstOrDefault();
        if (talking is not null)
        {
            return Decide(talking.Id, false, Readiness.NeedsConditions, DeepenReadiness.NoChoice, false);
        }

        var profile = await store.GetAsync<ProfileItem>(userKey, ProfileItem.ItemId, ct);
        var book = await store.GetAsync<AbilityBookItem>(userKey, AbilityBookItem.ItemId, ct);
        var options = await store.GetAsync<OptionsItem>(userKey, OptionsItem.ItemId, ct);
        var deepen = await store.GetAsync<DeepenItem>(userKey, DeepenItem.ItemId, ct);

        var inputs = OptionsInputsReader.From(profile, episodes, AbilityBook.View(episodes, book), book);
        var (deepenReadiness, target) = DeepenTargetReader.From(options, inputs.Conditions, catalog);
        var deepened = target is not null && deepen?.Content is { } c && c.Basis == target.Basis;

        return Decide(null, inputs.HasFinishedEpisode, OptionsInputsReader.Check(inputs), deepenReadiness, deepened);
    }
}
