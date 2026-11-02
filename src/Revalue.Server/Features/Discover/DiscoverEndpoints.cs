using System.Globalization;
using Revalue.Server.Data;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Foundation.Auth;
using Revalue.Server.Features.Foundation.Consent;
using Revalue.Server.Features.Foundation.Limits;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Discover;

/// <summary>
/// 場面のやりとりすべて。<c>Notice</c> は、最後の返事がつらい状態のサインへの応えのときだけ付ける相談窓口の知らせ
/// （開き直しても、窓口と続け方が出るように。Claude の判断）。
/// </summary>
public sealed record EpisodeDto(
    string Id,
    string Status,
    DateTimeOffset StartedAt,
    DateTimeOffset? FinishedAt,
    IReadOnlyList<Turn> Turns,
    SupportNotice? Notice)
{
    public static EpisodeDto From(EpisodeItem e) => new(
        e.Id,
        e.Status,
        e.StartedAt,
        e.FinishedAt,
        e.Turns,
        e.Turns.LastOrDefault() is { Role: TurnRoles.Assistant } last && last.Move == TalkStream.MoveName(MoveKind.Distress)
            ? SupportNotice.Distress
            : null);
}

public sealed record EpisodeSummaryDto(string Id, string Status, DateTimeOffset StartedAt, int UserTurnCount, string Preview);

/// <summary>/api/episodes の API。ここにあるものは AI を呼ばない（答えを送る API は別）。</summary>
public static class DiscoverEndpoints
{
    /// <summary>一覧に出す、最初の答えの書き出しの長さ（文字）。</summary>
    public const int PreviewLength = 30;

    public static void Map(RouteGroupBuilder api)
    {
        var episodes = api.MapGroup("/episodes").RequireConsent();

        episodes.MapGet("/", async (HttpContext http, IDataStore store, CancellationToken ct) =>
        {
            var items = await store.ListByTypeAsync<EpisodeItem>(http.User.GetUserKey()!, EpisodeItem.ItemType, ct);
            return TypedResults.Ok(items
                .OrderByDescending(e => e.StartedAt)
                .Select(e => new EpisodeSummaryDto(e.Id, e.Status, e.StartedAt, e.UserTurnCount, Preview(e)))
                .ToList());
        });

        // 話している途中の場面があれば、作らずに 409 で知らせる。2 つの画面から同時に押しても 1 つだけ作る
        episodes.MapPost("/", async (HttpContext http, IDataStore store, TimeProvider time, CancellationToken ct) =>
        {
            var userKey = http.User.GetUserKey()!;
            var outcome = await EpisodeStarter.StartAsync(
                store, userKey, () => EpisodeItem.Start(userKey, time.GetUtcNow(), DiscoverText.Opening, DiscoverText.OpeningChoices, "opening"), ct);
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
            // 読んでから消すまでにほかの画面で 1 往復が保存されたときは、読み直して、それも含めて消す（飛ばすのは場面ごと）
            var removed = false;
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

                removed = await store.TryDeleteAsync(userKey, id, read.ETag, ct);
            }

            if (!removed)
            {
                throw new InvalidOperationException($"Could not skip the episode after {DataStoreExtensions.MaxUpdateAttempts} attempts.");
            }

            // 消した場面の根拠を、利用者ごとの力の状態から外す。失敗しても、飛ばすのは成功のまま
            await AbilityBook.TryRecomputeAsync(store, userKey, ChangeReason.Skip, id, time, loggers.CreateLogger(typeof(AbilityBook)), ct);

            // 消したあと、ほかの画面で新しい場面が始まっていたら、2 つ目は作らずに 409 でその場面を知らせる
            var outcome = await EpisodeStarter.StartAsync(
                store, userKey, () => EpisodeItem.Start(userKey, time.GetUtcNow(), DiscoverText.AfterSkip, DiscoverText.AfterSkipChoices, "afterSkip"), ct);
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

    private static IResult NotFound() =>
        Problems.Create(StatusCodes.Status404NotFound, Problems.NotFound, "Not found.");

    private static IResult InProgress(string episodeId) =>
        Problems.Create(
            StatusCodes.Status409Conflict,
            Problems.EpisodeInProgress,
            "An episode is in progress.",
            new Dictionary<string, object?> { ["episodeId"] = episodeId });

    internal static IResult AlreadyFinished() =>
        Problems.Create(StatusCodes.Status409Conflict, Problems.EpisodeFinished, "The episode is already finished.");
}
