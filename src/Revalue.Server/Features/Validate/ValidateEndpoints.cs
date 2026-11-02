using System.Globalization;
using Revalue.Server.Ai;
using Revalue.Server.Data;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Foundation.Auth;
using Revalue.Server.Features.Foundation.Consent;
using Revalue.Server.Features.Foundation.Limits;

namespace Revalue.Server.Features.Validate;

/// <summary>
/// 根拠の本人の言葉。画面にそのまま出すので、何番目の答えかではなく引用の文字列を返す。
/// 選んだ答え（<paramref name="FromChoice"/>）では、<paramref name="LinkedText"/> に結びついた本人の言葉が入る。
/// </summary>
public sealed record QuoteDto(string Text, bool FromChoice, string? LinkedText)
{
    public static IReadOnlyList<QuoteDto> From(IEnumerable<Evidence> evidence) =>
        evidence.Select(e => new QuoteDto(e.Quote, e.FromChoice, e.LinkedQuote)).ToList();
}

/// <summary>
/// 見えた力の 1 つ。<paramref name="Life"/> は生活の中での状態、<paramref name="Work"/> は仕事での状態で、いまはいつも "notChecked"
/// （validate-9（生活での根拠と仕事での発揮を分ける））。
/// </summary>
public sealed record AbilityDto(
    string Key, string Name, AbilityState Life, IReadOnlyList<QuoteDto> Quotes, string? EpisodeId, IReadOnlyList<string> Hints, string Work, bool Excluded);

public sealed record AbilityChangeDto(
    DateTimeOffset At, string Key, string Name, AbilityState From, AbilityState To, ChangeReason Reason, string? EpisodeId);

/// <summary>見えた力の API が返すもの。履歴は新しい順。</summary>
public sealed record AbilitiesDto(IReadOnlyList<AbilityDto> Abilities, IReadOnlyList<AbilityChangeDto> History);

/// <summary>話し終えた場面の「この話から見えた力」の 1 つ（根拠あり）。</summary>
public sealed record SeenAbilityDto(string Key, string Name, IReadOnlyList<QuoteDto> Quotes);

/// <summary>「もう少し聞かせてほしいこと」の 1 つ（要確認）。<paramref name="Hints"/> は足りない行動の手がかり。</summary>
public sealed record MoreToHearDto(string Key, string Name, IReadOnlyList<QuoteDto> Quotes, IReadOnlyList<string> Hints);

/// <summary>「まだ聞けていない力」の 1 つ（未確認）。名前だけ。</summary>
public sealed record AbilityNameDto(string Key, string Name);

/// <summary>話し終えた場面から見えたこと（validate-7（見えた力と、もう少し聞きたいことを示す））。</summary>
public sealed record EpisodeInsightsDto(
    IReadOnlyList<SeenAbilityDto> Seen, IReadOnlyList<MoreToHearDto> MoreToHear, IReadOnlyList<AbilityNameDto> NotYet, bool CanResume);

/// <summary>訂正を送る API の本文。</summary>
public sealed record CorrectionRequest(string? Text);

/// <summary>場面ごとの「見えたこと」と、続きを話せるか（03-validate.md の「話し終えたとき」「続きを話す」）。</summary>
public static class EpisodeInsights
{
    /// <summary>続きの問いのターンの一手の名前。</summary>
    public const string ResumeMove = "resume";

    /// <summary>話し終えた場面で、力の確かめに使わない印がないときだけ返す。ほかは null。</summary>
    public static EpisodeInsightsDto? From(EpisodeItem episode)
    {
        if (!IsCheckable(episode))
        {
            return null;
        }

        var results = AbilityStates.Evaluate(episode.Evidence);
        return new EpisodeInsightsDto(
            results.Where(r => r.State == AbilityState.Confirmed)
                .Select(r => new SeenAbilityDto(ActionRef.Key(r.Ability), AbilityText.Name(r.Ability), QuoteDto.From(r.Shown)))
                .ToList(),
            results.Where(r => r.State == AbilityState.NeedsCheck)
                .Select(r => new MoreToHearDto(ActionRef.Key(r.Ability), AbilityText.Name(r.Ability), QuoteDto.From(r.Shown), Hints(episode, r)))
                .ToList(),
            results.Where(r => r.State == AbilityState.NotYet)
                .Select(r => new AbilityNameDto(ActionRef.Key(r.Ability), AbilityText.Name(r.Ability)))
                .ToList(),
            CanResume(episode));
    }

    /// <summary>
    /// 要確認の力の、足りない行動の手がかり（「もう少し聞かせてほしいこと」と、見えた力の画面の確かめ中）。
    /// 訂正で打ち消された行動の手がかりは出さない。後回しにしても、足りない行動がそれだけのときは同じ手がかりが出て、
    /// 本人が訂正で答えたばかりのことを聞き直すことになるため（Claude の判断）。
    /// </summary>
    public static IReadOnlyList<string> Hints(EpisodeItem episode, AbilityResult result)
    {
        var withdrawn = CorrectionRound.WithdrawnIn(episode.Turns);
        return result.Missing
            .Select(n => new ActionRef(result.Ability, n))
            .Where(a => !withdrawn.Contains(a))
            .Select(AbilityText.Hint)
            .ToList();
    }

    /// <summary>続きを話せるか: 話し終えた、印がない、要確認の力が 1 つ以上ある。</summary>
    public static bool CanResume(EpisodeItem episode) =>
        IsCheckable(episode) && AbilityStates.Evaluate(episode.Evidence).Any(r => r.State == AbilityState.NeedsCheck);

    /// <summary>
    /// 続きの問いで聞く行動。要確認の力のうち行動の多いもの（同じ数なら <see cref="Ability"/> の順）の足りない行動を、
    /// <see cref="AbilityStates.AskOrder"/> の順に見て、この場面で聞いた回数が上限（<see cref="NextMovePolicy.MaxAskPerAction"/>）に届いていないもの。
    /// なければ null（手がかりを添えずに聞く）。
    /// </summary>
    public static ActionRef? ResumeTarget(EpisodeItem episode)
    {
        var asked = ValidationContext.From(episode.Turns, episode.Evidence).AskedCounts;
        return AbilityStates.Evaluate(episode.Evidence)
            .Where(r => r.State == AbilityState.NeedsCheck)
            .OrderByDescending(r => r.Shown.Count)
            .ThenBy(r => r.Ability)
            .SelectMany(r => AbilityStates.AskOrder(r.Ability, r.Missing, episode.Evidence))
            .FirstOrDefault(a => asked.GetValueOrDefault(a) < NextMovePolicy.MaxAskPerAction);
    }

    /// <summary>
    /// 続きを話す場面を作る（まだ保存しない）。続きを話せない場面なら null。
    /// 聞ける足りない行動がない（どれも 2 回聞いた、一般論の根拠だけで 3 つそろった）ときは、手がかりを添えない問いで始める（Claude の判断）。
    /// </summary>
    public static EpisodeItem? Reopen(EpisodeItem episode, DateTimeOffset now)
    {
        if (!CanResume(episode))
        {
            return null;
        }

        var target = ResumeTarget(episode);
        var question = new Turn
        {
            Role = TurnRoles.Assistant,
            Text = target is null ? AbilityText.ResumeOpenQuestion : AbilityText.ResumeQuestion(target),
            Choices = AbilityText.ResumeChoices,
            Move = ResumeMove,
            Target = target?.ToString(),
            At = now,
        };
        return episode with
        {
            Status = EpisodeStatus.Talking,
            FinishedAt = null,
            TurnLimit = episode.UserTurnCount + NextMovePolicy.ResumeExtraTurns,
            Turns = [.. episode.Turns, question],
            BeforeResume = new ResumePoint(episode.Turns.Count, episode.FinishedAt, episode.TurnLimit, episode.Evidence),
        };
    }

    /// <summary>
    /// 続きを話している場面を、続きを話す前の話し終えた姿に戻す（まだ保存しない）。続きで足したやりとりと根拠は残さない。
    /// 続きの中でつらい状態のサインが出て付いた、力の確かめに使わない印は残す（安全な側。Claude の判断）。
    /// 続きを話している場面でなければ null。
    /// </summary>
    public static EpisodeItem? Rewind(EpisodeItem episode, DateTimeOffset now)
    {
        if (episode.Status != EpisodeStatus.Talking || episode.BeforeResume is not { } point)
        {
            return null;
        }

        return episode with
        {
            Status = EpisodeStatus.Finished,
            FinishedAt = point.FinishedAt ?? now,
            TurnLimit = point.TurnLimit,
            Turns = [.. episode.Turns.Take(point.TurnCount)],
            Evidence = point.Evidence,
            BeforeResume = null,
        };
    }

    private static bool IsCheckable(EpisodeItem episode) =>
        episode.Status == EpisodeStatus.Finished && !episode.ExcludedFromValidation;
}

/// <summary>/api/abilities の API。AI を呼ばない。</summary>
public static class ValidateEndpoints
{
    /// <summary>仕事での発揮の状態。何をもって動かすかはハッカソンのあとに決めるので、いつもこれ。</summary>
    public const string WorkNotChecked = "notChecked";

    public static void Map(RouteGroupBuilder api)
    {
        var abilities = api.MapGroup("/abilities").RequireConsent();

        abilities.MapGet("/", async (HttpContext http, IDataStore store, CancellationToken ct) =>
        {
            var userKey = http.User.GetUserKey()!;
            var book = await store.GetAsync<AbilityBookItem>(userKey, AbilityBookItem.ItemId, ct);
            return TypedResults.Ok(await DtoAsync(store, userKey, book, ct));
        });

        abilities.MapPost("/{name}/exclude", (string name, HttpContext http, IDataStore store, TimeProvider time, CancellationToken ct) =>
            SetExcludedAsync(name, excluded: true, http, store, time, ct));

        abilities.MapPost("/{name}/restore", (string name, HttpContext http, IDataStore store, TimeProvider time, CancellationToken ct) =>
            SetExcludedAsync(name, excluded: false, http, store, time, ct));

        var episodes = api.MapGroup("/episodes").RequireConsent();

        // 訂正を受け取り、場面全体を読み直す。AI を呼ぶので送信回数の上限を付ける
        episodes.MapPost("/{id}/corrections", async (
            string id,
            CorrectionRequest? request,
            HttpContext http,
            IDataStore store,
            IConversationAi ai,
            TimeProvider time,
            ILoggerFactory loggers,
            CancellationToken ct) =>
        {
            var text = request?.Text?.Trim();
            if (string.IsNullOrEmpty(text) || new StringInfo(text).LengthInTextElements > TalkStream.MaxAnswerLength)
            {
                return Problems.Create(StatusCodes.Status400BadRequest, Problems.InvalidAnswer, "The correction is empty or too long.");
            }

            var userKey = http.User.GetUserKey()!;
            var episode = await DiscoverEndpoints.FindAsync(store, userKey, id, ct);
            if (episode is null)
            {
                return DiscoverEndpoints.NotFound();
            }

            if (Unavailable(episode) is { } unavailable)
            {
                return unavailable;
            }

            var logger = loggers.CreateLogger(typeof(CorrectionRound));
            var correction = new Turn { Role = TurnRoles.User, Text = text, AnswerKind = AnswerKind.Correction, At = time.GetUtcNow() };
            var outcome = await CorrectionRound.RunAsync(ai, [.. episode.Turns, correction], ct);
            if (outcome.ErrorKind is { } kind)
            {
                logger.LogWarning("Reading the correction ended with {Kind}.", kind);
                return Problems.Create(
                    StatusCodes.Status503ServiceUnavailable,
                    Problems.AiUnavailable,
                    "The AI could not read the correction.",
                    new Dictionary<string, object?> { ["kind"] = kind });
            }

            // つらい状態のサインなら、AI の返事を使わず決まった言葉で応え、印を付ける。根拠は変えない
            var distress = outcome.Reading!.Has(AnswerSignal.Distress);
            var distressReply = new Turn
            {
                Role = TurnRoles.Assistant, Text = DiscoverText.DistressText, Move = TalkStream.MoveName(MoveKind.Distress), At = time.GetUtcNow(),
            };

            // 読んでから書くまでに場面が変わっていたら（ほかの画面の訂正、続き、飛ばす）書かない。
            // 訂正で打ち消された行動は、訂正のターンに印を残す（続きの問い、足りない行動を聞く一手、手がかりで聞き直さない）
            var saved = await store.TryUpdateAsync<EpisodeItem>(userKey, id, current =>
                Unavailable(current) is not null || current.Turns.Count != episode.Turns.Count
                    ? null
                    : current with
                    {
                        Turns = distress
                            ? [.. current.Turns, correction, distressReply]
                            : [.. current.Turns, WithWithdrawn(correction, CorrectionRound.Withdrawn(current.Evidence, outcome.Evidence))],
                        ExcludedFromValidation = distress,
                        Evidence = distress ? current.Evidence : outcome.Evidence,
                    }, ct);
            if (saved is null)
            {
                return await ConflictAsync(store, userKey, id, ct);
            }

            await AbilityBook.TryRecomputeAsync(store, userKey, distress ? ChangeReason.SetAside : ChangeReason.Correction, id, time, logger, ct);
            return TypedResults.Ok(EpisodeDto.From(saved));
        }).RequireDailyLimit();

        // 要確認の力がある話し終えた場面を、話している途中に戻し、続きの問いを足す。AI は呼ばない
        episodes.MapPost("/{id}/resume", async (string id, HttpContext http, IDataStore store, TimeProvider time, CancellationToken ct) =>
        {
            var userKey = http.User.GetUserKey()!;
            var episode = await DiscoverEndpoints.FindAsync(store, userKey, id, ct);
            if (episode is null)
            {
                return DiscoverEndpoints.NotFound();
            }

            if (Unavailable(episode) is { } unavailable)
            {
                return unavailable;
            }

            if (!EpisodeInsights.CanResume(episode))
            {
                return DiscoverEndpoints.AlreadyFinished();
            }

            var outcome = await EpisodeStarter.ResumeAsync(store, userKey, id, current => EpisodeInsights.Reopen(current, time.GetUtcNow()), ct);
            return outcome switch
            {
                null => await ConflictAsync(store, userKey, id, ct),
                { InProgress: { } other } => DiscoverEndpoints.InProgress(other.Id),
                { Started: { } resumed } => TypedResults.Ok(EpisodeDto.From(resumed)),
                _ => throw new InvalidOperationException("Resuming returned no episode."),
            };
        });
    }

    /// <summary>訂正のターンに、訂正で打ち消された行動の印を付ける。打ち消された行動がなければ、印を付けない。</summary>
    private static Turn WithWithdrawn(Turn correction, IReadOnlyList<ActionRef> withdrawn) =>
        withdrawn.Count == 0 ? correction : correction with { Withdrawn = [.. withdrawn.Select(a => a.ToString())] };

    /// <summary>訂正も続きもできない場面なら、その理由の 409。話している途中なら、その場面の id 付き。できるなら null。</summary>
    private static IResult? Unavailable(EpisodeItem episode)
    {
        if (episode.Status == EpisodeStatus.Talking)
        {
            return DiscoverEndpoints.InProgress(episode.Id);
        }

        return episode.ExcludedFromValidation
            ? Problems.Create(StatusCodes.Status409Conflict, Problems.EpisodeExcluded, "The episode is not used for checking abilities.")
            : null;
    }

    /// <summary>読んでから書くまでに場面が変わったときの応答。消えていれば 404、それ以外は 409。</summary>
    private static async Task<IResult> ConflictAsync(IDataStore store, string userKey, string id, CancellationToken ct)
    {
        var current = await DiscoverEndpoints.FindAsync(store, userKey, id, ct);
        if (current is null)
        {
            return DiscoverEndpoints.NotFound();
        }

        return Unavailable(current) ?? DiscoverEndpoints.AlreadyFinished();
    }

    private static async Task<IResult> SetExcludedAsync(
        string name, bool excluded, HttpContext http, IDataStore store, TimeProvider time, CancellationToken ct)
    {
        if (!ActionRef.TryParseAbility(name, out var ability))
        {
            return Problems.Create(StatusCodes.Status404NotFound, Problems.NotFound, "Not found.");
        }

        var userKey = http.User.GetUserKey()!;
        var book = await AbilityBook.SetExcludedAsync(store, userKey, ability, excluded, time, ct);
        return TypedResults.Ok(await DtoAsync(store, userKey, book, ct));
    }

    private static async Task<AbilitiesDto> DtoAsync(IDataStore store, string userKey, AbilityBookItem? book, CancellationToken ct)
    {
        var episodes = await store.ListByTypeAsync<EpisodeItem>(userKey, EpisodeItem.ItemType, ct);
        var abilities = AbilityBook.View(episodes, book)
            .Select(v => new AbilityDto(
                ActionRef.Key(v.Ability),
                AbilityText.Name(v.Ability),
                v.State,
                QuoteDto.From(v.Shown),
                v.EpisodeId,
                v.Hints,
                WorkNotChecked,
                v.Excluded))
            .ToList();
        var history = (book?.History ?? [])
            .Reverse()
            .Select(h => new AbilityChangeDto(h.At, ActionRef.Key(h.Ability), AbilityText.Name(h.Ability), h.From, h.To, h.Reason, h.EpisodeId))
            .ToList();
        return new AbilitiesDto(abilities, history);
    }
}
