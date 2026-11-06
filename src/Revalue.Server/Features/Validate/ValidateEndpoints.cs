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
/// <paramref name="Action"/> は、その根拠の核となる行動の文（能力辞書の共通の文）。本人の言葉と組にして、なぜその力なのかを伝える
/// （4-rules.md の「画面での見せ方」）。辞書の話から確かめる力でない、番号が行動の数を超える、本人の行動ではない状況の行動
/// （<see cref="AbilityCatalog.IsSituation"/>）なら null。うまくいかなかった状況を、本人の力の見出しとして本人の言葉に付けないため（Claude の判断）。
/// </summary>
public sealed record QuoteDto(string Text, bool FromChoice, string? LinkedText, string? Action)
{
    public static IReadOnlyList<QuoteDto> From(IEnumerable<Evidence> evidence) =>
        evidence.Select(e => new QuoteDto(e.Quote, e.FromChoice, e.LinkedQuote, ActionTextOrNull(e))).ToList();

    private static string? ActionTextOrNull(Evidence e) =>
        AbilityCatalog.IsActive(e.Ability) && e.Action >= 1 && e.Action <= AbilityCatalog.ActionCount(e.Ability)
            && !AbilityCatalog.IsSituation(new ActionRef(e.Ability, e.Action))
            ? AbilityCatalog.ActionText(new ActionRef(e.Ability, e.Action))
            : null;
}

/// <summary>
/// 見えた力の 1 つ。<paramref name="Life"/> は生活の中での状態、<paramref name="Work"/> は仕事での状態で、いまはいつも "notChecked"
/// （validate-9（生活での根拠と仕事での発揮を分ける））。<paramref name="CanTellMore"/> は、根拠の場面の「もう少し聞かせてほしいこと」に
/// いまも出している確かめ中の力か。false の確かめ中の力には、手がかりも、続きを話せるという言葉も出さない（<see cref="AbilityView.CanTellMore"/>）。
/// </summary>
public sealed record AbilityDto(
    string Key,
    string Name,
    AbilityState Life,
    IReadOnlyList<QuoteDto> Quotes,
    string? EpisodeId,
    IReadOnlyList<string> Hints,
    string Work,
    bool Excluded,
    bool CanTellMore);

public sealed record AbilityChangeDto(
    DateTimeOffset At, string Key, string Name, AbilityState From, AbilityState To, ChangeReason Reason, string? EpisodeId);

/// <summary>見えた力の API が返すもの。履歴は新しい順。</summary>
public sealed record AbilitiesDto(IReadOnlyList<AbilityDto> Abilities, IReadOnlyList<AbilityChangeDto> History);

/// <summary>話し終えた場面の「この話から見えた力」の 1 つ（根拠あり）。</summary>
public sealed record SeenAbilityDto(string Key, string Name, IReadOnlyList<QuoteDto> Quotes);

/// <summary>「もう少し聞かせてほしいこと」の 1 つ（要確認）。<paramref name="Hints"/> は足りない行動の手がかり。</summary>
public sealed record MoreToHearDto(string Key, string Name, IReadOnlyList<QuoteDto> Quotes, IReadOnlyList<string> Hints);

/// <summary>
/// 話し終えた場面から見えたこと（validate-7（見えた力と、もう少し聞きたいことを示す））。見せる力は <see cref="AbilityShowcase"/> で絞る。
/// まだ聞けていない力の一覧は返さない（4-rules.md の「画面での見せ方」）。
/// </summary>
public sealed record EpisodeInsightsDto(IReadOnlyList<SeenAbilityDto> Seen, IReadOnlyList<MoreToHearDto> MoreToHear, bool CanResume);

/// <summary>訂正を送る API の本文。</summary>
public sealed record CorrectionRequest(string? Text);

/// <summary>場面ごとの「見えたこと」と、続きを話せるか（03-validate.md の「話し終えたとき」「続きを話す」）。</summary>
public static class EpisodeInsights
{
    /// <summary>続きの問いのターンの一手の名前。</summary>
    public const string ResumeMove = "resume";

    /// <summary>話し終えた場面で、力の確かめに使わない印がないときだけ返す。ほかは null。見せる力だけを入れる（<see cref="AbilityShowcase.Of"/>）。</summary>
    public static EpisodeInsightsDto? From(EpisodeItem episode)
    {
        if (!IsCheckable(episode))
        {
            return null;
        }

        var showcase = Showcase(episode);
        return new EpisodeInsightsDto(
            showcase.Seen
                .Select(r => new SeenAbilityDto(ActionRef.Key(r.Ability), AbilityText.Name(r.Ability), QuoteDto.From(r.Shown)))
                .ToList(),
            showcase.MoreToHear
                .Select(r => new MoreToHearDto(ActionRef.Key(r.Ability), AbilityText.Name(r.Ability), QuoteDto.From(r.Shown), Hints(episode, r)))
                .ToList(),
            CanResume(episode));
    }

    /// <summary>この場面から見せる力（<see cref="AbilityShowcase.Of"/>）。</summary>
    public static EpisodeShowcase Showcase(EpisodeItem episode) => AbilityShowcase.Of(episode.Turns, episode.Evidence);

    /// <summary>
    /// 要確認の力の、足りない行動の手がかり（「もう少し聞かせてほしいこと」と、見えた力の画面の確かめ中）。
    /// 根拠が一般論だけの力には、足りない行動ではなく、最近の一日を一つ求める手がかり（<see cref="AbilityText.ConcreteDayHint"/>）だけを出す
    /// （validate-10（一般論には具体的な出来事を聞く））。
    /// 訂正で打ち消された行動の手がかりは出さない。後回しにしても、足りない行動がそれだけのときは同じ手がかりが出て、
    /// 本人が訂正で答えたばかりのことを聞き直すことになるため（Claude の判断）。
    /// </summary>
    public static IReadOnlyList<string> Hints(EpisodeItem episode, AbilityResult result)
    {
        if (IsGeneralOnly(result))
        {
            return [AbilityText.ConcreteDayHint];
        }

        var withdrawn = CorrectionRound.WithdrawnIn(episode.Turns);
        return result.Missing
            .Select(n => new ActionRef(result.Ability, n))
            .Where(a => !withdrawn.Contains(a))
            .Select(AbilityText.Hint)
            .ToList();
    }

    /// <summary>
    /// 続きを話せるか: 話し終えた、印がない、「もう少し聞かせてほしいこと」に出した力が 1 つ以上ある。
    /// 要確認でも、そろって見えた力に出せない力しかない場面は、続きで聞く力がないので続きを話せない（<see cref="AbilityShowcase.CouldBeSeen"/>）。
    /// </summary>
    public static bool CanResume(EpisodeItem episode) =>
        IsCheckable(episode) && Showcase(episode).MoreToHear.Count > 0;

    /// <summary>根拠が一般論だけの要確認の力か。一般論だけでは、どの日のことかが決まらないので、足りない行動は聞かず、具体的な出来事を一つ聞く。</summary>
    public static bool IsGeneralOnly(AbilityResult result) =>
        result.State == AbilityState.NeedsCheck && result.Shown.Count > 0 && result.Shown.All(e => e.General);

    /// <summary>
    /// 続きの問いで聞く行動。「もう少し聞かせてほしいこと」に出した力（<see cref="AbilityShowcase.Of"/> の <c>MoreToHear</c>）だけを、その順に見る。
    /// 本人に見せていない力の行動は聞かない。根拠が一般論だけの力は除く（指せる「その日」がないため）。
    /// 力ごとに足りない行動を <see cref="AbilityStates.AskOrder"/> の順に見て、この場面で聞いた回数が上限（<see cref="NextMovePolicy.MaxAskPerAction"/>）に届いていないもの。
    /// 訂正で打ち消された行動は、上限に届いたものとして数える（<see cref="ValidationContext.From"/>）。なければ null（手がかりを添えずに聞く）。
    /// </summary>
    public static ActionRef? ResumeTarget(EpisodeItem episode)
    {
        var context = ValidationContext.From(episode.Turns, episode.Evidence);
        if (context.AngerOpening)
        {
            // 腹が立った出来事では、足りない行動の手がかりを添えずに聞く（ValidationContext.AngerOpening）
            return null;
        }

        var asked = context.AskedCounts;
        var unanswered = ActionRef.Parse(UnansweredQuestion(episode)?.Target);
        return Showcase(episode).MoreToHear
            .Where(r => !IsGeneralOnly(r))
            .SelectMany(r => AbilityStates.AskOrder(r.Ability, r.Missing, episode.Evidence))
            .FirstOrDefault(a => asked.GetValueOrDefault(a) < NextMovePolicy.MaxAskPerAction && a != unanswered);
    }

    /// <summary>
    /// 答えていない最後の問い。訂正のターンを除いた最後のターンが聞き手のターンならそれを、そうでなければ null。
    /// 答えずに区切ったのは答えにくかったからかもしれないので、続きの最初の問いで同じ行動をすぐには聞き直さない（Claude の判断）。
    /// </summary>
    public static Turn? UnansweredQuestion(EpisodeItem episode) =>
        episode.Turns.LastOrDefault(t => t.AnswerKind != AnswerKind.Correction) is { Role: TurnRoles.Assistant } last ? last : null;

    /// <summary>
    /// 続きの最初の問いで映し返す本人の言葉（03-validate.md の「続きを話す」）。聞く力の見せる根拠（聞く行動がなければ、
    /// 「もう少し聞かせてほしいこと」に出した力すべての見せる根拠）のうち、
    /// 一般論でないものを先に、いちばん短いもの（同じ長さなら、力と行動の順で前のもの）。選んだ答えの根拠なら、選んだ文ではなく結びついた本人の言葉。
    /// 短いものを選ぶのは、受け止めと問いのあいだに挟んでも読みやすくするため（Claude の判断）。根拠がなければ null。
    /// </summary>
    public static string? ResumeMirrorQuote(EpisodeItem episode, ActionRef? target)
    {
        var shown = target is null
            ? Showcase(episode).MoreToHear.SelectMany(r => r.Shown)
            : AbilityStates.Evaluate(episode.Evidence).Single(r => r.Ability == target.Ability).Shown;
        return shown
            .Select(e => (e.General, Text: e.FromChoice ? e.LinkedQuote : e.Quote))
            .Where(x => !string.IsNullOrWhiteSpace(x.Text))
            .OrderBy(x => x.General)
            .ThenBy(x => new StringInfo(x.Text!).LengthInTextElements)
            .Select(x => x.Text)
            .FirstOrDefault();
    }

    /// <summary>
    /// 続きを話す場面を作る（まだ保存しない）。続きを話せない場面なら null。
    /// 最初の問いは、受け止めの一文、本人の言葉の映し返し、問い一つの順（<see cref="AbilityText.ResumeOpening"/>）。
    /// 聞ける足りない行動がない（どれも 2 回聞いた、訂正で打ち消された）ときは、手がかりを添えない問いで始める。
    /// 「もう少し聞かせてほしいこと」に出した力がどれも一般論だけのときは、「その日」を前提にせず、最近の一日を一つ聞く（validate-10。Claude の判断）。
    /// </summary>
    public static EpisodeItem? Reopen(EpisodeItem episode, DateTimeOffset now)
    {
        if (!CanResume(episode))
        {
            return null;
        }

        var resumePoint = new ResumePoint(episode.Turns.Count, episode.FinishedAt, episode.TurnLimit, episode.Evidence, now);
        if (episode.Turns.Count > 0 && episode.Turns[^1] is { Role: TurnRoles.Assistant, Move: ResumeMove })
        {
            // 続きの問いに答えずに区切ったあと。問いを足さず、その問いから続ける
            return episode with
            {
                Status = EpisodeStatus.Talking,
                FinishedAt = null,
                TurnLimit = episode.UserTurnCount + NextMovePolicy.ResumeExtraTurns,
                BeforeResume = resumePoint,
            };
        }

        var target = ResumeTarget(episode);
        var generalOnly = target is null && Showcase(episode).MoreToHear.All(IsGeneralOnly);
        var question = new Turn
        {
            Role = TurnRoles.Assistant,
            Text = generalOnly
                ? AbilityText.ResumeOpeningForGeneral(ResumeMirrorQuote(episode, null))
                : AbilityText.ResumeOpening(target, ResumeMirrorQuote(episode, target)),
            Choices = generalOnly ? AbilityText.ConcreteDayChoices : AbilityText.ResumeChoices,
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
            BeforeResume = resumePoint,
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
            if (string.IsNullOrEmpty(text) || !TalkStream.WithinLength(text))
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
                // 読み取りの失敗は、つらい状態のサインを見落としているかもしれないので、話す画面と同じく窓口を添える（Claude の判断）
                return Problems.Create(
                    StatusCodes.Status503ServiceUnavailable,
                    Problems.AiUnavailable,
                    "The AI could not read the correction.",
                    new Dictionary<string, object?> { ["kind"] = kind, ["notice"] = SupportNotice.Precaution });
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

        // 本人に見せた力か、外した力の一覧にある力だけを受け付ける。見ていない力は外せないため（validate-12）
        var userKey = http.User.GetUserKey()!;
        var book = await AbilityBook.SetExcludedAsync(store, userKey, ability, excluded, time, ct);
        return book is null
            ? Problems.Create(StatusCodes.Status404NotFound, Problems.NotFound, "Not found.")
            : TypedResults.Ok(await DtoAsync(store, userKey, book, ct));
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
                v.Excluded,
                v.CanTellMore))
            .ToList();
        // 辞書の話から確かめる力でない行（保存データの古い id など）は、名前を引く前に除く
        var history = (book?.History ?? [])
            .Reverse()
            .Where(h => AbilityCatalog.IsActive(h.Ability))
            .Select(h => new AbilityChangeDto(h.At, ActionRef.Key(h.Ability), AbilityText.Name(h.Ability), h.From, h.To, h.Reason, h.EpisodeId))
            .ToList();
        return new AbilitiesDto(abilities, history);
    }
}
