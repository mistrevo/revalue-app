using Microsoft.Extensions.Time.Testing;
using Revalue.Server.Data;

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

    [Fact(DisplayName = "foundation-4（使わなければ自動で消える）: 保存して取り出せる。利用者のアイテムには 30 日の TTL が付く")]
    public async Task UpsertAndGet()
    {
        var (store, _) = Create();

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

    [Fact(DisplayName = "foundation-3（いつでも全部消せる）: 種類で一覧でき、全部消すとその人だけ 0 件になる")]
    public async Task ListByTypeAndDeleteAll()
    {
        var (store, _) = Create();
        await store.UpsertAsync(Note("u_a", "n1"), Ct);
        await store.UpsertAsync(Note("u_a", "n2"), Ct);
        await store.UpsertAsync(new NoteItem { Id = "o1", UserKey = "u_a", Type = "other" }, Ct);
        await store.UpsertAsync(Note("u_b", "n1"), Ct);
        await store.UpsertAsync(Note(DataConstants.GlobalPartition, "g1"), Ct);

        var notes = await store.ListByTypeAsync<NoteItem>("u_a", "note", Ct);
        Assert.Equal(["n1", "n2"], notes.Select(n => n.Id).Order());
        Assert.Equal(3, await store.CountAllAsync("u_a", Ct));

        await store.DeleteAllAsync("u_a", Ct);

        Assert.Equal(0, await store.CountAllAsync("u_a", Ct));
        Assert.Equal(1, await store.CountAllAsync("u_b", Ct));
        Assert.Equal(1, await store.CountAllAsync(DataConstants.GlobalPartition, Ct));
    }

    [Fact(DisplayName = "foundation-3（いつでも全部消せる）: global は全部消すの対象にできない")]
    public async Task DeleteAllRefusesGlobal()
    {
        var (store, _) = Create();

        await Assert.ThrowsAsync<ArgumentException>(() => store.DeleteAllAsync(DataConstants.GlobalPartition, Ct));
    }

    [Fact(DisplayName = "foundation-8（数だけを数える）: 数は 1 ずつ増え、なければ作る")]
    public async Task IncrementCreatesAndIncrements()
    {
        var (store, _) = Create();

        Assert.Equal(1, await store.IncrementAsync(DataConstants.GlobalPartition, "count-x", "count", null, Ct));
        Assert.Equal(2, await store.IncrementAsync(DataConstants.GlobalPartition, "count-x", "count", null, Ct));
        Assert.Equal(1, await store.IncrementAsync("u_a", "usage-2026-11-02", "usage", null, Ct));

        var usage = await store.GetAsync<CountItem>("u_a", "usage-2026-11-02", Ct);
        Assert.Equal(1, usage!.Count);
        Assert.Equal(DataConstants.UserTtlSeconds, usage.Ttl);
        Assert.Null((await store.GetAsync<CountItem>(DataConstants.GlobalPartition, "count-x", Ct))!.Ttl);
    }

    [Fact(DisplayName = "foundation-4（使わなければ自動で消える）: インメモリの保存先は、書いてから 30 日たつと見えなくなる")]
    public async Task ItemsExpireAfter30Days()
    {
        var (store, clock) = Create();
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
        await store.UpsertAsync(Note("u_a", "n1"), Ct);
        await store.UpsertAsync(Note("u_a", "n2"), Ct);
        await store.UpsertAsync(Note("u_b", "n1"), Ct);

        clock.Advance(TimeSpan.FromDays(29));
        await store.TouchAllAsync("u_a", Ct);
        clock.Advance(TimeSpan.FromDays(2));

        Assert.Equal(2, await store.CountAllAsync("u_a", Ct));
        Assert.Equal(0, await store.CountAllAsync("u_b", Ct));
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
    }
}
