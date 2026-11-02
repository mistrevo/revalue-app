using Revalue.Server.Data;

namespace Revalue.Server.Features.Discover;

/// <summary>
/// 話している途中の場面の印。利用者ごとに id の決まった 1 件で、最後に始めた場面の id を持つ。
/// 場面を始める要求どうしを一列に並べ、話している途中の場面を 1 人 1 つまでにするために使う（<see cref="EpisodeStarter"/>）。
/// </summary>
public sealed record TalkingMarkItem : Item
{
    /// <summary>印の id。<see cref="EpisodeItem.IdPrefix"/> で始めないので、エピソードとしては読めない。</summary>
    public const string ItemId = "talking-mark";

    public const string ItemType = "talkingMark";

    /// <summary>最後に始めた場面の id。</summary>
    public required string EpisodeId { get; init; }
}

/// <summary>場面を始めた結果。始めた場面（<see cref="Started"/>）か、話している途中の場面（<see cref="InProgress"/>）のどちらか一方が入る。</summary>
public sealed record StartOutcome(EpisodeItem? Started, EpisodeItem? InProgress);

/// <summary>
/// 新しい場面を始める。話している途中の場面は 1 人 1 つまで（02-discover.md の「場面の始まりと終わり」）。
/// 2 つの画面からほぼ同時に始めても 1 つにするため、確かめてから作るまでを次の順で一続きにする（Claude の判断）。
/// <list type="number">
/// <item>印を、版（ETag）つきで読む</item>
/// <item>話している途中の場面があれば、作らずにそれを返す</item>
/// <item>新しい場面を書く</item>
/// <item>印を、読んだときの版のまま書き換える（なければ作る）。書き換えられたら、始めたことにする</item>
/// <item>書き換えられなければ、ほかの要求が先に始めた。3 で書いた場面を消して、1 からやり直す</item>
/// </list>
/// 場面を印より先に書くので、印を書き換えた要求のあとに印を読んだ要求は、2 でその場面を必ず見つける。
/// </summary>
public static class EpisodeStarter
{
    /// <summary>ほかの要求が先に始めたときに、確かめ直す回数。</summary>
    public const int MaxAttempts = 5;

    /// <param name="create">新しい場面を作る（まだ保存しない）。</param>
    public static async Task<StartOutcome> StartAsync(IDataStore store, string userKey, Func<EpisodeItem> create, CancellationToken ct)
    {
        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var mark = await store.GetVersionedAsync<TalkingMarkItem>(userKey, TalkingMarkItem.ItemId, ct);
            var talking = await FindTalkingAsync(store, userKey, mark?.Item.EpisodeId, ct);
            if (talking is not null)
            {
                return new StartOutcome(null, talking);
            }

            var episode = create();
            await store.UpsertAsync(episode, ct);
            var next = new TalkingMarkItem
            {
                Id = TalkingMarkItem.ItemId,
                UserKey = userKey,
                Type = TalkingMarkItem.ItemType,
                EpisodeId = episode.Id,
            };
            var claimed = mark is null
                ? await store.TryCreateAsync(next, ct)
                : await store.TryReplaceAsync(next, mark.ETag, ct);
            if (claimed)
            {
                return new StartOutcome(episode, null);
            }

            // ほかの要求が、印を読んでから書き換えるまでのあいだに始めた。
            // 書いた場面はまだどの画面にも返していないので消し、確かめ直す
            await store.DeleteAsync(userKey, episode.Id, ct);
        }

        throw new InvalidOperationException($"Could not start an episode after {MaxAttempts} attempts.");
    }

    /// <summary>話している途中の場面。印が指す場面が途中ならそれを、そうでなければいちばん新しいものを返す。なければ null。</summary>
    private static async Task<EpisodeItem?> FindTalkingAsync(IDataStore store, string userKey, string? markedId, CancellationToken ct)
    {
        var talking = (await store.ListByTypeAsync<EpisodeItem>(userKey, EpisodeItem.ItemType, ct))
            .Where(e => e.Status == EpisodeStatus.Talking)
            .ToList();
        return talking.FirstOrDefault(e => e.Id == markedId)
            ?? talking.OrderByDescending(e => e.StartedAt).FirstOrDefault();
    }
}
