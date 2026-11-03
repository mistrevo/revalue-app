using System.Diagnostics;
using Revalue.Server.Data;
using Revalue.Server.Features.Foundation.Auth;
using Revalue.Server.Features.Foundation.Consent;
using Revalue.Server.Features.Foundation.Counting;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Report;

/// <summary>確かめた力 1 つ。<paramref name="State"/> は "confirmed" か "needsCheck"（画面は呼び名を出さない）。</summary>
public sealed record ReportAbilityDto(string Key, string Name, AbilityState State, IReadOnlyList<QuoteDto> Quotes);

/// <summary>業務 1 つで、まだ確かめていないこと。<paramref name="AbilityName"/> は、まだ確かめていない力の名前（なければ null）。</summary>
public sealed record ReportTaskGapDto(string TaskName, string? AbilityName, IReadOnlyList<string> Knowledge);

/// <summary>まだ確かめていないこと。力は名前で返す。</summary>
public sealed record ReportNotYetDto(
    IReadOnlyList<string> NotHeard, IReadOnlyList<string> Checking, IReadOnlyList<ReportTaskGapDto> TaskGaps, bool HasExcluded);

/// <summary>5 つの記録（できることは確かめた力の欄と同じなので返さない）。</summary>
public sealed record ReportRecordsDto(
    IReadOnlyList<ProfileEntry> Preferences, IReadOnlyList<ProfileEntry> Wants, ProfileConditions? Conditions, string? Agency);

/// <summary>選んだ案。<paramref name="Kind"/> が null ならまだ選んでいない。<paramref name="Reason"/> と <paramref name="Ability"/> は、いまの記録で使えるときだけ。</summary>
public sealed record ReportChoiceDto(
    ChoiceKind? Kind,
    CardKind? Card,
    string? Title,
    string? Summary,
    IReadOnlyList<string> Tasks,
    string? Reason,
    ReportAbilityDto? Ability,
    MissingReason? Problem,
    bool OutsideConditions,
    bool DemandNotChecked,
    bool CardsStale);

/// <summary>いまの中身。<paramref name="Thinking"/> と <paramref name="Steps"/> は、いまの選んだ案で深めた中身がなければ null。</summary>
public sealed record ReportContentDto(
    IReadOnlyList<ReportAbilityDto> Abilities,
    ReportNotYetDto NotYet,
    ReportRecordsDto Records,
    ReportChoiceDto Choice,
    IReadOnlyList<ReportThought>? Thinking,
    IReadOnlyList<ReportStep>? Steps);

/// <summary>版の中の力。名前だけで、状態と根拠の言葉は持たない。</summary>
public sealed record ReportSnapshotAbilityDto(string Key, string Name);

/// <summary>版に残した中身。根拠の言葉と、選んだ案の理由と、力の状態は持たない。</summary>
public sealed record ReportSnapshotDto(
    IReadOnlyList<ReportSnapshotAbilityDto> Abilities,
    ReportNotYetDto NotYet,
    ReportRecordsDto Records,
    ReportChoiceSnapshot Choice,
    IReadOnlyList<ReportThought>? Thinking,
    IReadOnlyList<ReportStep>? Steps);

/// <summary>版 1 つ。<paramref name="Changed"/> は前の版から変わった欄（第 1 版は空）。</summary>
public sealed record ReportVersionDto(int Number, DateTimeOffset At, IReadOnlyList<ReportSection> Changed, ReportSnapshotDto Snapshot);

/// <summary>
/// レポートの API が返すもの。開けないとき（話し終えた場面がない）は <paramref name="Ready"/> が false で、ほかは空。
/// <paramref name="Current"/> はいちばん新しい版、<paramref name="Previous"/> はそれより前の版（新しいものから）。
/// </summary>
public sealed record ReportDto(bool Ready, ReportContentDto? Content, ReportVersionDto? Current, IReadOnlyList<ReportVersionDto> Previous);

/// <summary>/api/report の API（07-report.md）。AI は呼ばないので、1 日の送信回数は使わない。</summary>
public static class ReportEndpoints
{
    public static void Map(RouteGroupBuilder api)
    {
        var report = api.MapGroup("/report").RequireConsent();

        report.MapGet("/", async (
            HttpContext http, IDataStore store, JobCatalog catalog, ICounter counter, TimeProvider time, ILoggerFactory loggers, CancellationToken ct) =>
        {
            var userKey = http.User.GetUserKey()!;
            var watch = Stopwatch.StartNew();
            var (ready, content) = await ReportBuilder.BuildAsync(store, userKey, catalog, ct);
            if (!ready || content is null)
            {
                return TypedResults.Ok(new ReportDto(false, null, null, []));
            }

            // 中身が変わっていれば版を足す。同じ中身の版をほかの画面が先に書いていたら、増やさない
            var now = time.GetUtcNow();
            var saved = await ReportStore.UpdateAsync(store, userKey, item => item.WithVersion(content, now), time, ct);

            // 案を選ぶか保留したうえで開けたら数える。仕事の選択肢を通らずに開いただけでは数えない
            if (content.Choice.Kind is ChoiceKind.Card or ChoiceKind.Own or ChoiceKind.Hold)
            {
                await counter.CountOnceAsync(userKey, CountMetric.ReachedReport, ct);
            }

            var excluded = (await store.GetAsync<AbilityBookItem>(userKey, AbilityBookItem.ItemId, ct))?.Excluded ?? [];
            var versions = saved.Versions.Select(v => VersionDto(v, excluded)).ToList();

            // 件数と時間だけを書く。レポートの中身は書かない
            loggers.CreateLogger(typeof(ReportEndpoints)).LogInformation(
                "Report opened in {ElapsedMs} ms. Versions {VersionCount}. Latest {Number}.",
                watch.ElapsedMilliseconds,
                saved.Versions.Count,
                saved.Versions.Count > 0 ? saved.Versions[0].Number : 0);

            return TypedResults.Ok(new ReportDto(true, ContentDto(content), versions.FirstOrDefault(), versions.Skip(1).ToList()));
        });
    }

    private static ReportContentDto ContentDto(ReportContent content) =>
        new(
            content.Abilities.Select(AbilityDto).ToList(),
            NotYetDto(content.NotYet),
            RecordsDto(content.Records),
            new ReportChoiceDto(
                content.Choice.Kind,
                content.Choice.Card,
                content.Choice.Title,
                content.Choice.Summary,
                content.Choice.Tasks,
                content.Choice.Reason,
                content.Choice.Ability is { } a ? AbilityDto(a) : null,
                content.Choice.Problem,
                content.Choice.OutsideConditions,
                content.Choice.DemandNotChecked,
                content.Choice.CardsStale),
            content.Thinking,
            content.Steps);

    private static ReportVersionDto VersionDto(ReportVersion version, IReadOnlyList<Ability> excluded)
    {
        var snapshot = version.Snapshot.Without(excluded.ToList());
        return new ReportVersionDto(
            version.Number,
            version.At,
            version.Changed,
            new ReportSnapshotDto(
                snapshot.Abilities.Select(a => new ReportSnapshotAbilityDto(ActionRef.Key(a), AbilityText.Name(a))).ToList(),
                NotYetDto(snapshot.NotYet),
                RecordsDto(snapshot.Records),
                snapshot.Choice,
                snapshot.Thinking,
                snapshot.Steps));
    }

    private static ReportAbilityDto AbilityDto(ReportAbility ability) =>
        new(ActionRef.Key(ability.Ability), AbilityText.Name(ability.Ability), ability.State, QuoteDto.From(ability.Quotes));

    private static ReportNotYetDto NotYetDto(ReportNotYet notYet) =>
        new(
            notYet.NotHeard.Select(AbilityText.Name).ToList(),
            notYet.Checking.Select(AbilityText.Name).ToList(),
            notYet.TaskGaps.Select(g => new ReportTaskGapDto(g.TaskName, g.Ability is { } a ? AbilityText.Name(a) : null, g.Knowledge)).ToList(),
            notYet.HasExcluded);

    private static ReportRecordsDto RecordsDto(ReportRecords records) =>
        new(records.Preferences, records.Wants, records.Conditions, records.Agency);
}
