using System.Globalization;
using Revalue.Server.Data;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Foundation.Auth;
using Revalue.Server.Features.Foundation.Consent;
using Revalue.Server.Features.Foundation.Limits;

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

        episodes.MapPost("/", async (HttpContext http, IDataStore store, TimeProvider time, CancellationToken ct) =>
        {
            var userKey = http.User.GetUserKey()!;
            var talking = await FindTalkingAsync(store, userKey, ct);
            if (talking is not null)
            {
                return InProgress(talking.Id);
            }

            var episode = EpisodeItem.Start(userKey, time.GetUtcNow(), DiscoverText.Opening, DiscoverText.OpeningChoices, "opening");
            await store.UpsertAsync(episode, ct);
            return Created(episode);
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
            var episode = await FindAsync(store, http.User.GetUserKey()!, id, ct);
            if (episode is null)
            {
                return NotFound();
            }

            if (episode.Status == EpisodeStatus.Finished)
            {
                return AlreadyFinished();
            }

            var finished = episode with { Status = EpisodeStatus.Finished, FinishedAt = time.GetUtcNow() };
            await store.UpsertAsync(finished, ct);
            return TypedResults.Ok(EpisodeDto.From(finished));
        });

        episodes.MapPost("/{id}/skip", async (string id, HttpContext http, IDataStore store, TimeProvider time, CancellationToken ct) =>
        {
            var userKey = http.User.GetUserKey()!;
            var episode = await FindAsync(store, userKey, id, ct);
            if (episode is null)
            {
                return NotFound();
            }

            // 飛ばせるのは話している途中の場面だけ。話し終えた場面から飛ばすと、途中の場面が 2 つになりうる（Claude の判断）
            if (episode.Status == EpisodeStatus.Finished)
            {
                return AlreadyFinished();
            }

            // 中身を残さないよう、先に元の場面を消してから、新しい場面を作る
            await store.DeleteAsync(userKey, episode.Id, ct);
            var next = EpisodeItem.Start(userKey, time.GetUtcNow(), DiscoverText.AfterSkip, DiscoverText.AfterSkipChoices, "afterSkip");
            await store.UpsertAsync(next, ct);
            return Created(next);
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

    private static async Task<EpisodeItem?> FindTalkingAsync(IDataStore store, string userKey, CancellationToken ct)
    {
        var items = await store.ListByTypeAsync<EpisodeItem>(userKey, EpisodeItem.ItemType, ct);
        return items.Where(e => e.Status == EpisodeStatus.Talking).OrderByDescending(e => e.StartedAt).FirstOrDefault();
    }

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
