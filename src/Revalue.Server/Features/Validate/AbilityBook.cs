using System.Text.Json.Serialization;
using Revalue.Server.Data;
using Revalue.Server.Features.Discover;

namespace Revalue.Server.Features.Validate;

/// <summary>利用者ごとの力の状態が変わった理由（03-validate.md の「力の状態」）。</summary>
[JsonConverter(typeof(JsonStringEnumConverter<ChangeReason>))]
public enum ChangeReason
{
    /// <summary>話した内容から確かめた。</summary>
    [JsonStringEnumMemberName("talk")]
    Talk,

    /// <summary>訂正を受けて確かめ直した。</summary>
    [JsonStringEnumMemberName("correction")]
    Correction,

    /// <summary>場面を残さずに別の話にした。</summary>
    [JsonStringEnumMemberName("skip")]
    Skip,

    /// <summary>本人が外した。</summary>
    [JsonStringEnumMemberName("exclude")]
    Exclude,

    /// <summary>本人が戻した。</summary>
    [JsonStringEnumMemberName("restore")]
    Restore,

    /// <summary>
    /// つらい状態のサインが出て、その場面を力の確かめに使わないことにした（03-validate.md の「力の状態」）。
    /// 打ち明けた直後に、見立てが下がったと読める行を出さないよう、画面では状態の移り変わりを書かず、理由だけを穏やかに出す（Claude の判断）。
    /// </summary>
    [JsonStringEnumMemberName("setAside")]
    SetAside,
}

/// <summary>利用者ごとの力の状態の履歴 1 件。外す・戻すでは、From と To はどちらもそのときの状態。</summary>
public sealed record AbilityChange(DateTimeOffset At, Ability Ability, AbilityState From, AbilityState To, ChangeReason Reason, string? EpisodeId);

/// <summary>
/// 利用者ごとの力の状態（見えた力）、外した力、履歴。利用者ごとに id の決まった 1 件。
/// 状態は保存してある場面から計算し直したもの（<see cref="AbilityBook.RecomputeAsync"/>）。
/// </summary>
public sealed record AbilityBookItem : Item
{
    public const string ItemId = "ability-book";
    public const string ItemType = "abilityBook";

    /// <summary>力ごとの状態。ない力は未確認。</summary>
    public IReadOnlyDictionary<Ability, AbilityState> States { get; init; } = new Dictionary<Ability, AbilityState>();

    /// <summary>本人が外した力（<see cref="Ability"/> の順、重なりなし）。System.Text.Json が読み戻せる形にするため、集合ではなく並びで持つ。</summary>
    public IReadOnlyList<Ability> Excluded { get; init; } = [];

    /// <summary>状態の変わった履歴。古い順。<see cref="AbilityBook.MaxHistory"/> 件まで。</summary>
    public IReadOnlyList<AbilityChange> History { get; init; } = [];

    public AbilityState StateOf(Ability ability) => States.GetValueOrDefault(ability, AbilityState.NotYet);
}

/// <summary>見えた力の画面と API に渡す、力ごとの中身。</summary>
/// <param name="Shown">根拠。その状態の場面のうち、新しい場面のもの。未確認では空。</param>
/// <param name="EpisodeId">根拠を取った場面の id。未確認では null。</param>
/// <param name="Hints">足りない行動の手がかり。要確認のときだけ。</param>
public sealed record AbilityView(
    Ability Ability, AbilityState State, IReadOnlyList<Evidence> Shown, string? EpisodeId, IReadOnlyList<string> Hints, bool Excluded);

/// <summary>
/// 利用者ごとの力の状態を、保存してある場面から計算し直し、変わった力の履歴を残す（03-validate.md の「力の状態」）。
/// 保存は読んだときから変わっていないときだけ書き、ほかの要求が先に書いていたら読み直してやり直す。
/// </summary>
public static class AbilityBook
{
    /// <summary>履歴の上限。超えたら古いものから捨てる（Claude の判断）。</summary>
    public const int MaxHistory = 100;

    /// <summary>
    /// その人の場面（力の確かめに使わない印のないもの）から、力ごとにいちばん進んだ状態を出し、前と違う力だけ履歴に足して保存する。
    /// 了解の記録がない（全部消したあと）ときは、何も書かずに <see cref="ConsentMissingException"/> を投げる。
    /// </summary>
    public static Task<AbilityBookItem> RecomputeAsync(
        IDataStore store, string userKey, ChangeReason reason, string? episodeId, TimeProvider time, CancellationToken ct) =>
        RecomputeCoreAsync(store, userKey, reason, episodeId, deletedEpisode: false, time, ct);

    /// <summary>
    /// 場面を消して飛ばしたあとに計算し直す（03-validate.md の「力の状態」）。理由は「場面を残さずに別の話にした」。
    /// 消した場面の「つらい状態のサインが出て、その場面を確かめに使わないことにした」履歴を外す。サインの出た時が、
    /// 本人が残さないと選んだ場面のあとに残らないようにするため。外した行のぶんの状態の移り変わりは、
    /// 外した行がなかったときの状態から、いまの状態への「場面を残さずに別の話にした」として残す（履歴の前と後がつながるように。Claude の判断）。
    /// </summary>
    public static Task<AbilityBookItem> RecomputeAfterDeletingAsync(
        IDataStore store, string userKey, string episodeId, TimeProvider time, CancellationToken ct) =>
        RecomputeCoreAsync(store, userKey, ChangeReason.Skip, episodeId, deletedEpisode: true, time, ct);

    /// <summary>
    /// <see cref="RecomputeAsync"/> を呼び、失敗しても例外にしない。1 往復の返事や、飛ばす・訂正の保存は成功のままにするため（Claude の判断）。
    /// ログには種類だけを書く。
    /// </summary>
    public static Task TryRecomputeAsync(
        IDataStore store, string userKey, ChangeReason reason, string? episodeId, TimeProvider time, ILogger logger, CancellationToken ct) =>
        TryAsync(() => RecomputeAsync(store, userKey, reason, episodeId, time, ct), logger);

    /// <summary><see cref="RecomputeAfterDeletingAsync"/> を呼び、失敗しても例外にしない（<see cref="TryRecomputeAsync"/> と同じ）。</summary>
    public static Task TryRecomputeAfterDeletingAsync(
        IDataStore store, string userKey, string episodeId, TimeProvider time, ILogger logger, CancellationToken ct) =>
        TryAsync(() => RecomputeAfterDeletingAsync(store, userKey, episodeId, time, ct), logger);

    private static async Task<AbilityBookItem> RecomputeCoreAsync(
        IDataStore store, string userKey, ChangeReason reason, string? episodeId, bool deletedEpisode, TimeProvider time, CancellationToken ct)
    {
        for (var attempt = 0; attempt < DataStoreExtensions.MaxUpdateAttempts; attempt++)
        {
            var read = await store.GetVersionedAsync<AbilityBookItem>(userKey, AbilityBookItem.ItemId, ct);
            var episodes = await store.ListByTypeAsync<EpisodeItem>(userKey, EpisodeItem.ItemType, ct);
            var states = Enum.GetValues<Ability>().ToDictionary(a => a, a => Best(episodes, a)?.Result.State ?? AbilityState.NotYet);

            var current = read?.Item ?? New(userKey);
            var forgotten = deletedEpisode && episodeId is not null ? ForgetSetAside(current, episodeId) : null;
            var history = forgotten?.History ?? current.History;
            var recorded = forgotten?.Recorded ?? current.States;
            var now = time.GetUtcNow();
            var changes = states
                .Where(s => recorded.GetValueOrDefault(s.Key, AbilityState.NotYet) != s.Value)
                .OrderBy(s => s.Key)
                .Select(s => new AbilityChange(now, s.Key, recorded.GetValueOrDefault(s.Key, AbilityState.NotYet), s.Value, reason, episodeId))
                .ToList();
            if (read is not null && changes.Count == 0 && forgotten is null)
            {
                return read.Item;
            }

            var next = current with { States = states, History = Trim([.. history, .. changes]) };
            var written = read is null
                ? await store.TryCreateAsync(next, ct)
                : await store.TryReplaceAsync(next, read.ETag, ct);
            if (written)
            {
                return next;
            }
        }

        throw new InvalidOperationException($"Could not update the ability book after {DataStoreExtensions.MaxUpdateAttempts} attempts.");
    }

    /// <summary>
    /// 消した場面の「確かめに使わないことにした」履歴を外す。外す行がなければ null。
    /// 外した力ごとに、外した行のあとの同じ力の外す・戻すの行は、外した行がなかったときの状態（外した行の前の状態）に書き直し、
    /// 履歴が最後に示す状態（<c>Recorded</c>）もその状態にする。外した行のあとに、ほかの場面からその力の移り変わりがあれば、
    /// そこから先は書き直さず、本の状態のままにする（Claude の判断）。
    /// </summary>
    private static (List<AbilityChange> History, Dictionary<Ability, AbilityState> Recorded)? ForgetSetAside(AbilityBookItem book, string episodeId)
    {
        if (!book.History.Any(h => IsForgotten(h, episodeId)))
        {
            return null;
        }

        var history = new List<AbilityChange>(book.History.Count);
        var recorded = Enum.GetValues<Ability>().ToDictionary(a => a, book.StateOf);
        var rewriting = new Dictionary<Ability, AbilityState>();
        foreach (var change in book.History)
        {
            if (IsForgotten(change, episodeId))
            {
                rewriting.TryAdd(change.Ability, change.From);
                recorded[change.Ability] = change.From;
                continue;
            }

            if (rewriting.TryGetValue(change.Ability, out var before))
            {
                if (change.Reason is ChangeReason.Exclude or ChangeReason.Restore)
                {
                    history.Add(change with { From = before, To = before });
                    continue;
                }

                rewriting.Remove(change.Ability);
                recorded[change.Ability] = book.StateOf(change.Ability);
            }

            history.Add(change);
        }

        return (history, recorded);
    }

    private static bool IsForgotten(AbilityChange change, string episodeId) =>
        change.Reason == ChangeReason.SetAside && change.EpisodeId == episodeId;

    private static async Task TryAsync(Func<Task> recompute, ILogger logger)
    {
        try
        {
            await recompute();
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogWarning("Recomputing the ability book failed: {ErrorType}.", e.GetType().Name);
        }
    }

    /// <summary>
    /// 力を外す（<paramref name="excluded"/> が true）か戻す。変わったときだけ履歴に残す。From と To はそのときの状態。
    /// 本がまだなければ、先に場面から計算し直して作る。
    /// </summary>
    public static async Task<AbilityBookItem> SetExcludedAsync(
        IDataStore store, string userKey, Ability ability, bool excluded, TimeProvider time, CancellationToken ct)
    {
        for (var attempt = 0; attempt < DataStoreExtensions.MaxUpdateAttempts; attempt++)
        {
            var read = await store.GetVersionedAsync<AbilityBookItem>(userKey, AbilityBookItem.ItemId, ct);
            if (read is null)
            {
                await RecomputeAsync(store, userKey, ChangeReason.Talk, null, time, ct);
                continue;
            }

            var book = read.Item;
            if (book.Excluded.Contains(ability) == excluded)
            {
                return book;
            }

            var state = book.StateOf(ability);
            var change = new AbilityChange(
                time.GetUtcNow(), ability, state, state, excluded ? ChangeReason.Exclude : ChangeReason.Restore, null);
            var others = book.Excluded.Where(a => a != ability);
            var set = (excluded ? others.Append(ability) : others).Distinct().Order().ToList();
            var next = book with { Excluded = set, History = Trim([.. book.History, change]) };
            if (await store.TryReplaceAsync(next, read.ETag, ct))
            {
                return next;
            }
        }

        throw new InvalidOperationException($"Could not update the ability book after {DataStoreExtensions.MaxUpdateAttempts} attempts.");
    }

    /// <summary>
    /// 力ごとの中身を <see cref="Ability"/> の順で返す。状態は場面から出し（本と同じ決め方）、外したかは本から読む。
    /// </summary>
    public static IReadOnlyList<AbilityView> View(IReadOnlyList<EpisodeItem> episodes, AbilityBookItem? book) =>
        Enum.GetValues<Ability>().Select(ability =>
        {
            var excluded = book?.Excluded.Contains(ability) ?? false;
            if (Best(episodes, ability) is not { } best)
            {
                return new AbilityView(ability, AbilityState.NotYet, [], null, [], excluded);
            }

            var hints = EpisodeInsights.Hints(best.Episode, best.Result);
            return new AbilityView(ability, best.Result.State, best.Result.Shown, best.Episode.Id, hints, excluded);
        }).ToList();

    /// <summary>
    /// 力の確かめに使える場面のうち、その力がいちばん進んだ状態の場面（同じなら <see cref="EpisodeItem.StartedAt"/> が新しいもの）。
    /// どの場面でも未確認なら null。
    /// </summary>
    private static (EpisodeItem Episode, AbilityResult Result)? Best(IReadOnlyList<EpisodeItem> episodes, Ability ability) =>
        episodes
            .Where(e => !e.ExcludedFromValidation)
            .Select(e => (Episode: e, Result: AbilityStates.Evaluate(e.Evidence).Single(r => r.Ability == ability)))
            .Where(x => x.Result.State != AbilityState.NotYet)
            .OrderByDescending(x => x.Result.State)
            .ThenByDescending(x => x.Episode.StartedAt)
            .Select(x => ((EpisodeItem, AbilityResult)?)x)
            .FirstOrDefault();

    private static AbilityBookItem New(string userKey) => new()
    {
        Id = AbilityBookItem.ItemId,
        UserKey = userKey,
        Type = AbilityBookItem.ItemType,
    };

    private static List<AbilityChange> Trim(List<AbilityChange> history) =>
        history.Count <= MaxHistory ? history : history.GetRange(history.Count - MaxHistory, MaxHistory);
}
