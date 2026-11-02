using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Data;

namespace Revalue.Server.Tests;

public sealed class DeleteAllTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact(DisplayName = "foundation-3（いつでも全部消せる）: 消すと、その人のアイテムが 1 件も残らない")]
    public async Task DeleteRemovesEverythingOfThatUserOnly()
    {
        await using var factory = new RevalueFactory();
        var a = factory.CreateUserClient("a");
        var b = factory.CreateUserClient("b");
        var store = factory.Services.GetRequiredService<IDataStore>();
        var keyA = TestUsers.Key("a");
        var keyB = TestUsers.Key("b");
        foreach (var client in new[] { a, b })
        {
            await client.PostAsJsonAsync("/api/consent", new { version = "2026-11-02" }, Ct);
        }

        await store.UpsertAsync(new NoteItem { Id = "n1", UserKey = keyA, Type = "note", Text = "話した内容" }, Ct);
        await store.UpsertAsync(new NoteItem { Id = "n1", UserKey = keyB, Type = "note" }, Ct);
        await store.IncrementAsync(DataConstants.GlobalPartition, "count-x", "count", null, Ct);
        var globalBefore = await store.CountAllAsync(DataConstants.GlobalPartition, Ct);

        var response = await a.DeleteAsync("/api/me", Ct);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(0, await store.CountAllAsync(keyA, Ct));
        Assert.True(await store.CountAllAsync(keyB, Ct) > 0);
        Assert.Equal(globalBefore, await store.CountAllAsync(DataConstants.GlobalPartition, Ct));
        Assert.True((await b.GetFromJsonAsync<JsonElement>("/api/me", Ct)).GetProperty("consented").GetBoolean());
        Assert.False((await a.GetFromJsonAsync<JsonElement>("/api/me", Ct)).GetProperty("consented").GetBoolean());
    }

    [Fact(DisplayName = "foundation-3（いつでも全部消せる）: 消すのとほかの要求が重なっても、消したあとに何も残らない")]
    public async Task DeleteRacingOtherRequestsLeavesNothing()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateUserClient("a");
        var store = factory.Services.GetRequiredService<IDataStore>();
        var key = TestUsers.Key("a");

        var leftovers = 0;
        for (var trial = 0; trial < 200; trial++)
        {
            Assert.Equal(HttpStatusCode.NoContent, (await client.PostAsJsonAsync("/api/consent", new { version = "2026-11-02" }, Ct)).StatusCode);
            await client.GetAsync("/api/me", Ct);
            // 次の要求が、日本時間でその日に初めての要求になる（使った記録と TTL を書き直す）
            factory.Clock.Advance(TimeSpan.FromDays(1));

            var requests = Enumerable.Range(0, 8)
                .Select(_ => Task.Run(() => client.GetAsync("/api/stats", Ct)))
                .Append(Task.Run(() => client.DeleteAsync("/api/me", Ct)));
            await Task.WhenAll(requests);

            if (await store.CountAllAsync(key, Ct) > 0)
            {
                leftovers++;
                await store.DeleteAllAsync(key, Ct);
            }
        }

        Assert.Equal(0, leftovers);
    }

    [Fact(DisplayName = "foundation-3（いつでも全部消せる）: その日の最初の要求が書き直す途中で消されても、使った記録を作り直さない")]
    public async Task DeleteDuringDailyTouchDoesNotRecreateActivity()
    {
        await using var factory = new RevalueFactory().WithTestServices(InterruptingDataStore.Install);
        var store = (InterruptingDataStore)factory.Services.GetRequiredService<IDataStore>();
        var client = factory.CreateUserClient("a");
        var key = TestUsers.Key("a");
        await client.PostAsJsonAsync("/api/consent", new { version = "2026-11-02" }, Ct);
        await client.GetAsync("/api/me", Ct);
        factory.Clock.Advance(TimeSpan.FromDays(1));

        // 了解を確かめて書き直したあと、使った記録を書く直前に、全部消すが割り込む
        store.DeleteAllOnceBefore(nameof(IDataStore.UpsertAsync));
        var response = await client.GetAsync("/api/stats", Ct);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal(0, await store.CountAllAsync(key, Ct));
    }

    [Fact(DisplayName = "foundation-3（いつでも全部消せる）: 送る途中で消されたら、送信回数を作り直さず 403 を返す")]
    public async Task DeleteDuringSendDoesNotRecreateUsage()
    {
        await using var factory = new RevalueFactory().WithTestServices(InterruptingDataStore.Install);
        var store = (InterruptingDataStore)factory.Services.GetRequiredService<IDataStore>();
        var client = factory.CreateUserClient("a");
        var key = TestUsers.Key("a");
        await client.PostAsJsonAsync("/api/consent", new { version = "2026-11-02" }, Ct);
        await client.GetAsync("/api/me", Ct);

        // 了解を確かめたあと、送信回数を増やす直前に、全部消すが割り込む
        store.DeleteAllOnceBefore(nameof(IDataStore.IncrementDailyAsync));
        var response = await client.PostAsync("/api/_test/send", null, Ct);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Assert.Equal("/problems/consent-required", problem.GetProperty("type").GetString());
        Assert.Equal(0, await store.CountAllAsync(key, Ct));
        // 1 人の数を増やせなかった要求は、アプリ全体の数も増やさない
        Assert.Null(await store.GetAsync<CountItem>(DataConstants.GlobalPartition, "usage-total-2026-11-02", Ct));
    }

    [Fact(DisplayName = "foundation-3（いつでも全部消せる）: 消したあとに画面が了解の状態を読み直しても、アイテムを作り直さない")]
    public async Task DeleteThenReloadLeavesNothing()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateUserClient("a");
        var store = factory.Services.GetRequiredService<IDataStore>();
        var key = TestUsers.Key("a");
        await client.PostAsJsonAsync("/api/consent", new { version = "2026-11-02" }, Ct);
        await client.GetAsync("/api/me", Ct);
        Assert.True(await store.CountAllAsync(key, Ct) > 0);

        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync("/api/me", Ct)).StatusCode);
        // 画面は消したあと「はじめに」へ進み、了解の状態を読み直す
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/me", Ct)).StatusCode);
        await client.GetAsync("/start", Ct);
        Assert.Equal(0, await store.CountAllAsync(key, Ct));

        // 次の日に開いても、了解するまでは作らない
        factory.Clock.Advance(TimeSpan.FromDays(1));
        await client.GetAsync("/api/me", Ct);
        Assert.Equal(0, await store.CountAllAsync(key, Ct));
    }
}
