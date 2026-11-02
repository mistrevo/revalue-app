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
