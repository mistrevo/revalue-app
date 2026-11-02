using Microsoft.Extensions.Time.Testing;
using Revalue.Server.Data;
using Revalue.Server.Features.Foundation.Consent;

namespace Revalue.Server.Tests;

public sealed class DataStoreTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static (InMemoryDataStore Store, FakeTimeProvider Clock) Create()
    {
        var clock = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-02T03:00:00Z"));
        return (new InMemoryDataStore(clock), clock);
    }

    private static NoteItem Note(string userKey, string id, string text = "架空のメモ", int? ttl = null) =>
        new() { Id = id, UserKey = userKey, Type = "note", Text = text, Ttl = ttl };

    /// <summary>了解の記録を置く。利用者のパーティションには、これがあるときだけ書ける。</summary>
    private static Task Consent(IDataStore store, string userKey) =>
        store.UpsertAsync(new ConsentItem
        {
            Id = ConsentItem.ItemId,
            UserKey = userKey,
            Type = ConsentItem.ItemType,
            Version = ConsentInfo.CurrentVersion,
            At = DateTimeOffset.Parse("2026-11-02T03:00:00Z"),
        }, Ct);

    [Fact(DisplayName = "foundation-4（使わなければ自動で消える）: 保存して取り出せる。利用者のアイテムには 30 日の TTL が付く")]
    public async Task UpsertAndGet()
    {
        var (store, _) = Create();
        await Consent(store, "u_a");

        await store.UpsertAsync(Note("u_a", "n1", "一つ目"), Ct);
        await store.UpsertAsync(Note("u_a", "n1", "書き直し"), Ct);

        var item = await store.GetAsync<NoteItem>("u_a", "n1", Ct);
        Assert.NotNull(item);
        Assert.Equal("書き直し", item.Text);
        Assert.Equal(DataConstants.UserTtlSeconds, item.Ttl);
        Assert.Equal(2592000, DataConstants.UserTtlSeconds);
        Assert.Null(await store.GetAsync<NoteItem>("u_b", "n1", Ct));
    }

    [Fact(DisplayName = "foundation-4（使わなければ自動で消える）: global のアイテムは渡した ttl のまま")]
    public async Task GlobalItemKeepsGivenTtl()
    {
        var (store, _) = Create();

        await store.UpsertAsync(Note(DataConstants.GlobalPartition, "g1"), Ct);
        await store.UpsertAsync(Note(DataConstants.GlobalPartition, "g2", ttl: 172800), Ct);

        Assert.Null((await store.GetAsync<NoteItem>(DataConstants.GlobalPartition, "g1", Ct))!.Ttl);
        Assert.Equal(172800, (await store.GetAsync<NoteItem>(DataConstants.GlobalPartition, "g2", Ct))!.Ttl);
    }

    [Fact(DisplayName = "foundation-2（始める前に保存するものを示す）: 了解の記録がない人のパーティションには書けない")]
    public async Task NothingIsWrittenWithoutConsent()
    {
        var (store, _) = Create();

        await Assert.ThrowsAsync<ConsentMissingException>(() => store.UpsertAsync(Note("u_a", "n1"), Ct));
        await Assert.ThrowsAsync<ConsentMissingException>(() => store.IncrementAsync("u_a", "count-x", "count", null, Ct));
        await Assert.ThrowsAsync<ConsentMissingException>(() => store.IncrementDailyAsync("u_a", "usage", "usage", "2026-11-02", null, Ct));
        Assert.Equal(0, await store.CountAllAsync("u_a", Ct));

        // 了解の記録そのものと、人と結びつかない global には、了解なしで書ける
        await store.IncrementAsync(DataConstants.GlobalPartition, "count-x", "count", null, Ct);
        await Consent(store, "u_a");
        await store.UpsertAsync(Note("u_a", "n1"), Ct);
        Assert.Equal(2, await store.CountAllAsync("u_a", Ct));
    }

    [Fact(DisplayName = "foundation-3（いつでも全部消せる）: 全部消したあとに届いた書き込みは断り、何も作り直さない")]
    public async Task WritesAfterDeleteAllAreRefused()
    {
        var (store, _) = Create();
        await Consent(store, "u_a");
        await store.UpsertAsync(Note("u_a", "n1"), Ct);

        await store.DeleteAllAsync("u_a", Ct);

        await Assert.ThrowsAsync<ConsentMissingException>(() => store.UpsertAsync(Note("u_a", "n2"), Ct));
        await Assert.ThrowsAsync<ConsentMissingException>(() => store.IncrementDailyAsync("u_a", "usage", "usage", "2026-11-02", null, Ct));
        Assert.Equal(0, await store.CountAllAsync("u_a", Ct));
    }

    [Fact(DisplayName = "foundation-3（いつでも全部消せる）: 種類で一覧でき、全部消すとその人だけ 0 件になる")]
    public async Task ListByTypeAndDeleteAll()
    {
        var (store, _) = Create();
        await Consent(store, "u_a");
        await Consent(store, "u_b");
        await store.UpsertAsync(Note("u_a", "n1"), Ct);
        await store.UpsertAsync(Note("u_a", "n2"), Ct);
        await store.UpsertAsync(new NoteItem { Id = "o1", UserKey = "u_a", Type = "other" }, Ct);
        await store.UpsertAsync(Note("u_b", "n1"), Ct);
        await store.UpsertAsync(Note(DataConstants.GlobalPartition, "g1"), Ct);

        var notes = await store.ListByTypeAsync<NoteItem>("u_a", "note", Ct);
        Assert.Equal(["n1", "n2"], notes.Select(n => n.Id).Order());
        // 了解の記録と、3 件
        Assert.Equal(4, await store.CountAllAsync("u_a", Ct));

        await store.DeleteAllAsync("u_a", Ct);

        Assert.Equal(0, await store.CountAllAsync("u_a", Ct));
        Assert.Equal(2, await store.CountAllAsync("u_b", Ct));
        Assert.Equal(1, await store.CountAllAsync(DataConstants.GlobalPartition, Ct));
    }

    [Fact(DisplayName = "foundation-3（いつでも全部消せる）: global は全部消すの対象にできない")]
    public async Task DeleteAllRefusesGlobal()
    {
        var (store, _) = Create();

        await Assert.ThrowsAsync<ArgumentException>(() => store.DeleteAllAsync(DataConstants.GlobalPartition, Ct));
        await Assert.ThrowsAsync<ArgumentException>(() => store.DeleteLeftoversAsync(DataConstants.GlobalPartition, Ct));
    }

    [Fact(DisplayName = "foundation-8（数だけを数える）: 数は 1 ずつ増え、なければ作る")]
    public async Task IncrementCreatesAndIncrements()
    {
        var (store, _) = Create();
        await Consent(store, "u_a");

        Assert.Equal(1, await store.IncrementAsync(DataConstants.GlobalPartition, "count-x", "count", null, Ct));
        Assert.Equal(2, await store.IncrementAsync(DataConstants.GlobalPartition, "count-x", "count", null, Ct));
        Assert.Equal(1, await store.IncrementAsync("u_a", "count-y", "count", null, Ct));

        var mine = await store.GetAsync<CountItem>("u_a", "count-y", Ct);
        Assert.Equal(1, mine!.Count);
        Assert.Equal(DataConstants.UserTtlSeconds, mine.Ttl);
        Assert.Null((await store.GetAsync<CountItem>(DataConstants.GlobalPartition, "count-x", Ct))!.Ttl);
    }

    [Fact(DisplayName = "foundation-8（数だけを数える）: なければ作るは、1 回目だけ作り、あれば何もしない")]
    public async Task TryCreateCreatesOnlyOnce()
    {
        var (store, _) = Create();
        await Assert.ThrowsAsync<ConsentMissingException>(() => store.TryCreateAsync(Note("u_a", "m1", "一つ目"), Ct));
        await Consent(store, "u_a");

        Assert.True(await store.TryCreateAsync(Note("u_a", "m1", "一つ目"), Ct));
        Assert.False(await store.TryCreateAsync(Note("u_a", "m1", "二つ目"), Ct));

        var item = await store.GetAsync<NoteItem>("u_a", "m1", Ct);
        Assert.Equal("一つ目", item!.Text);
        Assert.Equal(DataConstants.UserTtlSeconds, item.Ttl);
    }

    [Fact(DisplayName = "foundation-6（使いすぎを穏やかに止める）: その日の数は 1 ずつ増え、日が変わると前の日の数を残さず 1 から数え直す")]
    public async Task IncrementDailyRestartsOnANewDay()
    {
        var (store, _) = Create();
        await Consent(store, "u_a");

        Assert.Equal(1, await store.IncrementDailyAsync("u_a", "usage", "usage", "2026-11-02", null, Ct));
        Assert.Equal(2, await store.IncrementDailyAsync("u_a", "usage", "usage", "2026-11-02", null, Ct));
        Assert.Equal(1, await store.IncrementDailyAsync("u_a", "usage", "usage", "2026-11-03", null, Ct));

        var usage = Assert.Single(await store.ListByTypeAsync<DailyCountItem>("u_a", "usage", Ct));
        Assert.Equal("2026-11-03", usage.Date);
        Assert.Equal(1, usage.Count);
        Assert.Equal(DataConstants.UserTtlSeconds, usage.Ttl);
    }

    [Fact(DisplayName = "foundation-4（使わなければ自動で消える）: インメモリの保存先は、書いてから 30 日たつと見えなくなる")]
    public async Task ItemsExpireAfter30Days()
    {
        var (store, clock) = Create();
        await Consent(store, "u_a");
        await store.UpsertAsync(Note("u_a", "n1"), Ct);

        clock.Advance(TimeSpan.FromDays(30) - TimeSpan.FromSeconds(1));
        Assert.NotNull(await store.GetAsync<NoteItem>("u_a", "n1", Ct));

        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Null(await store.GetAsync<NoteItem>("u_a", "n1", Ct));
        Assert.Equal(0, await store.CountAllAsync("u_a", Ct));
        Assert.Empty(await store.ListByTypeAsync<NoteItem>("u_a", "note", Ct));
    }

    [Fact(DisplayName = "foundation-4（使わなければ自動で消える）: 書き直すと、そこから 30 日を数え直す")]
    public async Task TouchAllRestartsTtl()
    {
        var (store, clock) = Create();
        await Consent(store, "u_a");
        await Consent(store, "u_b");
        await store.UpsertAsync(Note("u_a", "n1"), Ct);
        await store.UpsertAsync(Note("u_a", "n2"), Ct);
        await store.UpsertAsync(Note("u_b", "n1"), Ct);

        clock.Advance(TimeSpan.FromDays(29));
        await store.TouchAllAsync("u_a", Ct);
        clock.Advance(TimeSpan.FromDays(2));

        // 了解の記録と、2 件
        Assert.Equal(3, await store.CountAllAsync("u_a", Ct));
        Assert.Equal(0, await store.CountAllAsync("u_b", Ct));
    }

    [Fact(DisplayName = "foundation-4（使わなければ自動で消える）: 了解の記録が先に消えたら、残りを消せる。了解の記録があれば消さない")]
    public async Task DeleteLeftoversOnlyWithoutConsent()
    {
        var (store, clock) = Create();
        await Consent(store, "u_a");
        await Consent(store, "u_b");
        await store.UpsertAsync(Note("u_b", "n1"), Ct);
        // 了解の記録より 11 時間あとに書いたアイテムは、了解の記録より 11 時間長く残る
        clock.Advance(TimeSpan.FromHours(11));
        await store.UpsertAsync(Note("u_a", "n1"), Ct);

        clock.Advance(TimeSpan.FromDays(30) - TimeSpan.FromHours(10));
        Assert.Null(await store.GetAsync<ConsentItem>("u_a", ConsentItem.ItemId, Ct));
        Assert.Equal(1, await store.CountAllAsync("u_a", Ct));

        await store.DeleteLeftoversAsync("u_a", Ct);
        Assert.Equal(0, await store.CountAllAsync("u_a", Ct));

        // 了解の記録がある人は消さない
        await Consent(store, "u_b");
        await store.UpsertAsync(Note("u_b", "n2"), Ct);
        await store.DeleteLeftoversAsync("u_b", Ct);
        Assert.Equal(2, await store.CountAllAsync("u_b", Ct));
    }

    [Fact(DisplayName = "foundation-4（使わなければ自動で消える）: Cosmos に保存するアイテムには ttl が付く")]
    public void CosmosSerializationHasTtl()
    {
        var json = CosmosDataStore.Serialize(Note("u_a", "n1", "架空のメモ"));

        Assert.Contains("\"ttl\":2592000", json);
        Assert.Contains("\"userKey\":\"u_a\"", json);
        Assert.Contains("\"id\":\"n1\"", json);
        Assert.Contains("\"type\":\"note\"", json);
        Assert.Contains("\"text\":", json);

        var global = CosmosDataStore.Serialize(Note(DataConstants.GlobalPartition, "g1"));
        Assert.DoesNotContain("\"ttl\"", global);

        var daily = CosmosDataStore.Serialize(new DailyCountItem { Id = "usage", UserKey = "u_a", Type = "usage", Date = "2026-11-02", Count = 3 });
        Assert.Contains("\"ttl\":2592000", daily);
        Assert.Contains("\"date\":\"2026-11-02\"", daily);
        Assert.Contains("\"count\":3", daily);
    }
}
