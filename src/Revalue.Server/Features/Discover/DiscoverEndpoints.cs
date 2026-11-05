using System.Globalization;
using Revalue.Server.Data;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Foundation.Auth;
using Revalue.Server.Features.Foundation.Consent;
using Revalue.Server.Features.Foundation.Limits;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Report;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Discover;

/// <summary>
/// 場面のやりとりすべて。<c>Notice</c> は、最後の返事がつらい状態のサインへの応えのときだけ付ける相談窓口の知らせ
/// （開き直しても、窓口と続け方が出るように。Claude の判断）。
/// </summary>
/// <remarks><c>Insights</c> は、話し終えた場面で、力の確かめに使わない印がないときだけ入れる（03-validate.md の「話し終えたとき」）。</remarks>
public sealed record EpisodeDto(
    string Id,
    string Status,
    DateTimeOffset StartedAt,
    DateTimeOffset? FinishedAt,
    IReadOnlyList<Turn> Turns,
    SupportNotice? Notice,
    EpisodeInsightsDto? Insights)
{
    public static EpisodeDto From(EpisodeItem e) => new(
        e.Id,
        e.Status,
        e.StartedAt,
        e.FinishedAt,
        [.. e.Turns.Select(WithoutUnknownActions)],
        e.Turns.LastOrDefault() is { Role: TurnRoles.Assistant } last && last.Move == TalkStream.MoveName(MoveKind.Distress)
            ? SupportNotice.Distress
            : null,
        EpisodeInsights.From(e));

    /// <summary>
    /// 聞いた行動の印と、訂正で打ち消された印のうち、辞書の話から確かめる力の行動でないもの（保存データの古い id など）を、返す前に外す。
    /// 保存したデータは変えない（00-common.md の「力」）。
    /// </summary>
    private static Turn WithoutUnknownActions(Turn turn)
    {
        var target = turn.Target is not null && ActionRef.Parse(turn.Target) is null ? null : turn.Target;
        var withdrawn = turn.Withdrawn?.Where(w => ActionRef.Parse(w) is not null).ToList();
        return target == turn.Target && (withdrawn is null || withdrawn.Count == turn.Withdrawn!.Count)
            ? turn
            : turn with { Target = target, Withdrawn = withdrawn is { Count: > 0 } ? withdrawn : null };
    }
}

/// <summary>一覧の 1 件。<c>CanResume</c> は、続きを話せる場面か（03-validate.md の「続きを話す」）。</summary>
public sealed record EpisodeSummaryDto(string Id, string Status, DateTimeOffset StartedAt, int UserTurnCount, string Preview, bool CanResume);

/// <summary>/api/episodes の API。ここにあるものは AI を呼ばない（答えを送る API は別）。</summary>
public static class DiscoverEndpoints
{
    /// <summary>一覧に出す、最初の答えの書き出しの長さ（文字）。</summary>
    public const int PreviewLength = 30;

    /// <summary>
    /// 新しい場面の最初の問いと選択肢を、組で選ぶ（discover-1）。本人が答えた話し終えた場面（訂正は答えに数えない）のうち、
    /// いちばん新しく話し終えたものが、つらい状態のサインで力の確かめに使わない場面なら、気持ちを聞かない問い。
    /// ほかに答えた場面があれば「また」と添えた問い。なければ初めての問い。
    /// 「いちばん新しい」は、話し終えた時刻（続きを話した場面も、話し終えた時刻で並ぶ）で見る。
    /// 並べ方はホームの次にできること（NextStep.LastEndedWithDistress）と同じだが、見分ける条件は違う。
    /// ホームは最後のターンがサインへの応えかで見るのに対し、ここは力の確かめに使わない印で見る。
    /// サインのあと「続けて話す」を選んでふつうに締めた場面も、重い日に話を戻さない側に入れるため（Claude の判断）。
    /// </summary>
    public static (string Question, IReadOnlyList<string> Choices) ChooseOpening(IEnumerable<EpisodeItem> episodes)
    {
        var latest = episodes
            .Where(e => e.Status == EpisodeStatus.Finished
                && e.Turns.Any(t => t.Role == TurnRoles.User && t.AnswerKind != AnswerKind.Correction))
            .OrderByDescending(e => e.FinishedAt ?? e.StartedAt)
            .FirstOrDefault();
        return latest switch
        {
            null => (DiscoverText.Opening, DiscoverText.OpeningChoices),
            { ExcludedFromValidation: true } => (DiscoverText.OpeningAfterDistress, DiscoverText.OpeningAfterDistressChoices),
            _ => (DiscoverText.OpeningAnotherDay, DiscoverText.OpeningChoices),
        };
    }

    /// <summary>
    /// 飛ばしたあとの新しい場面の問いと選択肢を、組で選ぶ（discover-5）。ふだんは、飛ばしたあとの問い（<see cref="DiscoverText.AfterSkip"/>）。
    /// 飛ばした場面につらい状態のサインが出ていたら（力の確かめに使わない印。サインのあとの「この話は残さずに、別の話にする」もここを通る）、
    /// つらい状態のサインのあとの入口と同じ問いと選択肢にする。サインには家庭内の暴力や暴言も入るので、打ち明けた直後に、
    /// 家族や家の中の場面（「家族とゆっくり過ごした」、ごはんの前後）を出さないため（Claude の判断）。
    /// 続きを話している場面を飛ばしたときも、戻す前の場面の印で見る（続きの中でサインが出ていれば入る）。
    /// </summary>
    public static (string Question, IReadOnlyList<string> Choices) ChooseAfterSkip(EpisodeItem skipped) =>
        skipped.ExcludedFromValidation
            ? (DiscoverText.OpeningAfterDistress, DiscoverText.OpeningAfterDistressChoices)
            : (DiscoverText.AfterSkip, DiscoverText.AfterSkipChoices);

    public static void Map(RouteGroupBuilder api)
    {
        var episodes = api.MapGroup("/episodes").RequireConsent();

        episodes.MapGet("/", async (HttpContext http, IDataStore store, CancellationToken ct) =>
        {
            var items = await store.ListByTypeAsync<EpisodeItem>(http.User.GetUserKey()!, EpisodeItem.ItemType, ct);
            return TypedResults.Ok(items
                .OrderByDescending(e => e.StartedAt)
                .Select(e => new EpisodeSummaryDto(e.Id, e.Status, e.StartedAt, e.UserTurnCount, Preview(e), EpisodeInsights.CanResume(e)))
                .ToList());
        });

        // 話している途中の場面があれば、作らずに 409 で知らせる。2 つの画面から同時に押しても 1 つだけ作る
        episodes.MapPost("/", async (HttpContext http, IDataStore store, TimeProvider time, CancellationToken ct) =>
        {
            var userKey = http.User.GetUserKey()!;
            var (opening, choices) = ChooseOpening(await store.ListByTypeAsync<EpisodeItem>(userKey, EpisodeItem.ItemType, ct));
            var outcome = await EpisodeStarter.StartAsync(
                store, userKey, () => EpisodeItem.Start(userKey, time.GetUtcNow(), opening, choices, "opening"), ct);
            return Started(outcome);
        });

        episodes.MapGet("/{id}", async (string id, HttpContext http, IDataStore store, CancellationToken ct) =>
        {
            var episode = await FindAsync(store, http.User.GetUserKey()!, id, ct);
            return episode is null ? NotFound() : TypedResults.Ok(EpisodeDto.From(episode));
        });

        // 答えを受け取り、返事を SSE で流す。AI を呼ぶので送信回数の上限を付ける。
        // 受け取れない答え・ない場面・話し終えた場面は、SSE を始める前に断る
        episodes.MapPost("/{id}/messages", async (string id, MessageRequest? request, HttpContext http, IDataStore store, TalkStream talk, CancellationToken ct) =>
        {
            var answer = TalkStream.Validate(request);
            if (answer is not { } valid)
            {
                return Problems.Create(StatusCodes.Status400BadRequest, Problems.InvalidAnswer, "The answer is empty, too long, or has an unknown kind.");
            }

            var episode = await FindAsync(store, http.User.GetUserKey()!, id, ct);
            if (episode is null)
            {
                return NotFound();
            }

            if (episode.Status == EpisodeStatus.Finished)
            {
                return AlreadyFinished();
            }

            return TypedResults.ServerSentEvents(talk.RunAsync(episode, valid.Text, valid.Kind, ct));
        }).RequireDailyLimit();

        episodes.MapPost("/{id}/finish", async (string id, HttpContext http, IDataStore store, TimeProvider time, CancellationToken ct) =>
        {
            var userKey = http.User.GetUserKey()!;
            var episode = await FindAsync(store, userKey, id, ct);
            if (episode is null)
            {
                return NotFound();
            }

            if (episode.Status == EpisodeStatus.Finished)
            {
                return AlreadyFinished();
            }

            // 読んでから書くまでに、ほかの画面で 1 往復が保存されたら、それを残して区切る。
            // 飛ばされて消えていたら、作り直さない（版が合うときだけ置き換える）
            var finished = await store.TryUpdateAsync<EpisodeItem>(userKey, episode.Id, current =>
                current.Status == EpisodeStatus.Talking
                    ? current with { Status = EpisodeStatus.Finished, FinishedAt = time.GetUtcNow() }
                    : null, ct);
            if (finished is null)
            {
                return await FindAsync(store, userKey, id, ct) is null ? NotFound() : AlreadyFinished();
            }

            return TypedResults.Ok(EpisodeDto.From(finished));
        });

        episodes.MapPost("/{id}/skip", async (string id, HttpContext http, IDataStore store, TimeProvider time, ILoggerFactory loggers, CancellationToken ct) =>
        {
            var userKey = http.User.GetUserKey()!;

            // 中身を残さないよう、先に元の場面を消してから、新しい場面を作る。
            // 消すのは、読んだときから変わっていない、話している途中の場面だけ（版が合うときだけ消す）。
            // ほかの画面で区切られた場面は消さず、ほかの画面で先に飛ばされていたら 404 を返す。
            // 読んでから消すまでにほかの画面で 1 往復が保存されたときは、読み直して、それも含めて消す（飛ばすのは場面ごと）。
            // 続きを話している場面（03-validate.md の「続きを話す」）は消さず、続きで足したやりとりと根拠だけを残さずに、
            // 話し終えた姿に戻す。前に話し終えていた分は、飛ばす前の確かめ「このやりとりは残さずに」の外にあるため（Claude の判断）
            var removed = false;
            var deleted = false;
            EpisodeItem? skipped = null;
            for (var attempt = 0; attempt < DataStoreExtensions.MaxUpdateAttempts && !removed; attempt++)
            {
                var read = await FindVersionedAsync(store, userKey, id, ct);
                if (read is null)
                {
                    return NotFound();
                }

                // 飛ばせるのは話している途中の場面だけ。話し終えた場面から飛ばすと、途中の場面が 2 つになりうる（Claude の判断）
                if (read.Item.Status == EpisodeStatus.Finished)
                {
                    return AlreadyFinished();
                }

                skipped = read.Item;
                if (EpisodeInsights.Rewind(read.Item, time.GetUtcNow()) is { } rewound)
                {
                    removed = await store.TryReplaceAsync(rewound, read.ETag, ct);
                }
                else
                {
                    removed = deleted = await store.TryDeleteAsync(userKey, id, read.ETag, ct);
                }
            }

            if (!removed)
            {
                throw new InvalidOperationException($"Could not skip the episode after {DataStoreExtensions.MaxUpdateAttempts} attempts.");
            }

            // 消した場面の根拠を、利用者ごとの力の状態から外す。失敗しても、飛ばすのは成功のまま。
            // 場面ごと消したときは、その場面の「確かめに使わないことにした」履歴も残さない（03-validate.md の「力の状態」）。
            // 続きを話す前の姿に戻したときは、場面が残るので、その履歴も残す
            var abilityLogger = loggers.CreateLogger(typeof(AbilityBook));
            if (deleted)
            {
                await AbilityBook.TryRecomputeAfterDeletingAsync(store, userKey, id, time, abilityLogger, ct);
            }
            else
            {
                await AbilityBook.TryRecomputeAsync(store, userKey, ChangeReason.Skip, id, time, abilityLogger, ct);
            }

            // 仕事の選択肢のカードと選んだ案は、根拠の言葉を写して持つ。飛ばした場面の言葉を、そこにも残さない（05-options.md の「作り直す」）
            await OptionsScrub.TryAfterRemovingAsync(store, userKey, time, loggers.CreateLogger(typeof(OptionsScrub)), ct);

            // レポートの版は根拠の言葉を写さないが、力の名前は残す。飛ばしたやりとりのあいだに作った版を残さない（07-report.md の「版を残す」）
            await ReportScrub.TryAfterSkipAsync(store, userKey, skipped!, time, loggers.CreateLogger(typeof(ReportScrub)), ct);

            // 消したあと、ほかの画面で新しい場面が始まっていたら、2 つ目は作らずに 409 でその場面を知らせる
            var (question, choices) = ChooseAfterSkip(skipped!);
            var outcome = await EpisodeStarter.StartAsync(
                store, userKey, () => EpisodeItem.Start(userKey, time.GetUtcNow(), question, choices, "afterSkip"), ct);
            return Started(outcome);
        });
    }

    /// <summary>その人のエピソードを読む。エピソードの id の形でないもの、ほかの人のもの、ないものは null。</summary>
    public static async Task<EpisodeItem?> FindAsync(IDataStore store, string userKey, string id, CancellationToken ct)
    {
        if (!EpisodeItem.IsEpisodeId(id))
        {
            return null;
        }

        var episode = await store.GetAsync<EpisodeItem>(userKey, id, ct);
        return episode?.Type == EpisodeItem.ItemType ? episode : null;
    }

    /// <summary><see cref="FindAsync"/> と同じものを、読んだときの版と一緒に読む。</summary>
    private static async Task<Versioned<EpisodeItem>?> FindVersionedAsync(IDataStore store, string userKey, string id, CancellationToken ct)
    {
        if (!EpisodeItem.IsEpisodeId(id))
        {
            return null;
        }

        var read = await store.GetVersionedAsync<EpisodeItem>(userKey, id, ct);
        return read?.Item.Type == EpisodeItem.ItemType ? read : null;
    }

    /// <summary>始めた場面は 201、話している途中の場面があって始めなかったときは 409（その場面の id 付き）。</summary>
    private static IResult Started(StartOutcome outcome) =>
        outcome.Started is { } episode ? Created(episode) : InProgress(outcome.InProgress!.Id);

    private static string Preview(EpisodeItem episode)
    {
        var first = episode.Turns.FirstOrDefault(t => t.Role == TurnRoles.User)?.Text ?? "";
        var info = new StringInfo(first);
        // 文字の途中（サロゲートペアなど）で切らない
        return info.LengthInTextElements <= PreviewLength ? first : info.SubstringByTextElements(0, PreviewLength);
    }

    private static IResult Created(EpisodeItem episode) =>
        TypedResults.Created($"/api/episodes/{episode.Id}", EpisodeDto.From(episode));

    internal static IResult NotFound() =>
        Problems.Create(StatusCodes.Status404NotFound, Problems.NotFound, "Not found.");

    internal static IResult InProgress(string episodeId) =>
        Problems.Create(
            StatusCodes.Status409Conflict,
            Problems.EpisodeInProgress,
            "An episode is in progress.",
            new Dictionary<string, object?> { ["episodeId"] = episodeId });

    internal static IResult AlreadyFinished() =>
        Problems.Create(StatusCodes.Status409Conflict, Problems.EpisodeFinished, "The episode is already finished.");
}
