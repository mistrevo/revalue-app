using Revalue.Server.Features.Foundation.Consent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Data;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Foundation.Auth;

namespace Revalue.Server.Tests;

public sealed class AutoDeleteTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static string UserKey(string provider, string principalId) =>
        new UserKeyHasher(new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Auth:UserKeySecret"] = RevalueFactory.TestSecret })
            .Build()).Hash(provider, principalId);

    /// <summary>使った記録を書くのは、いまの版で了解した人だけなので、先に了解しておく。</summary>
    private static async Task Consent(HttpClient client) =>
        Assert.Equal(HttpStatusCode.NoContent, (await client.PostAsJsonAsync("/api/consent", new { version = ConsentInfo.CurrentVersion }, Ct)).StatusCode);

    [Fact(DisplayName = "foundation-4（使わなければ自動で消える）: 30 日たつと消える")]
    public async Task UserDataDisappearsAfter30Days()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateUserClient("g-1");
        var store = factory.Services.GetRequiredService<IDataStore>();
        var userKey = UserKey("google", "g-1");

        await Consent(client);
        await client.GetAsync("/api/nope", Ct);
        await store.UpsertAsync(new NoteItem { Id = "n1", UserKey = userKey, Type = "note" }, Ct);
        Assert.Equal(3, await store.CountAllAsync(userKey, Ct));

        factory.Clock.Advance(TimeSpan.FromDays(30));

        Assert.Null(await store.GetAsync<NoteItem>(userKey, "n1", Ct));
        Assert.Equal(0, await store.CountAllAsync(userKey, Ct));
    }

    [Fact(DisplayName = "foundation-4（使わなければ自動で消える）: 29 日目に使うと、そこから 30 日残る")]
    public async Task UsingOnDay29KeepsDataFor30MoreDays()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateUserClient("g-1");
        var store = factory.Services.GetRequiredService<IDataStore>();
        var userKey = UserKey("google", "g-1");

        await Consent(client);
        await client.GetAsync("/api/nope", Ct);
        await store.UpsertAsync(new NoteItem { Id = "n1", UserKey = userKey, Type = "note" }, Ct);

        factory.Clock.Advance(TimeSpan.FromDays(29));
        await client.GetAsync("/api/nope", Ct);

        factory.Clock.Advance(TimeSpan.FromDays(29));
        Assert.NotNull(await store.GetAsync<NoteItem>(userKey, "n1", Ct));
        var activity = await store.GetAsync<ActivityItem>(userKey, ActivityItem.ItemId, Ct);
        Assert.Equal("2026-12-01", activity!.LastActiveDate);

        factory.Clock.Advance(TimeSpan.FromDays(2));
        Assert.Null(await store.GetAsync<NoteItem>(userKey, "n1", Ct));
        Assert.Equal(0, await store.CountAllAsync(userKey, Ct));
    }

    [Fact(DisplayName = "foundation-4（使わなければ自動で消える）: 書き直すのは日本時間でその日に初めて使ったときだけ")]
    public async Task TouchOnlyOncePerJstDay()
    {
        await using var factory = new RevalueFactory();
        // 日本時間 2026-11-02 23:59:59
        factory.Clock.SetUtcNow(DateTimeOffset.Parse("2026-11-02T14:59:59Z"));
        var client = factory.CreateUserClient("g-1");
        var store = factory.Services.GetRequiredService<IDataStore>();
        var userKey = UserKey("google", "g-1");

        await Consent(client);
        await client.GetAsync("/api/nope", Ct);
        Assert.Equal("2026-11-02", (await store.GetAsync<ActivityItem>(userKey, ActivityItem.ItemId, Ct))!.LastActiveDate);

        await store.UpsertAsync(new NoteItem { Id = "n1", UserKey = userKey, Type = "note" }, Ct);
        await client.GetAsync("/api/nope", Ct);
        Assert.Equal("2026-11-02", (await store.GetAsync<ActivityItem>(userKey, ActivityItem.ItemId, Ct))!.LastActiveDate);

        // 日本時間 2026-11-03 00:00:00
        factory.Clock.Advance(TimeSpan.FromSeconds(1));
        await client.GetAsync("/api/nope", Ct);
        Assert.Equal("2026-11-03", (await store.GetAsync<ActivityItem>(userKey, ActivityItem.ItemId, Ct))!.LastActiveDate);
    }

    [Fact(DisplayName = "foundation-4（使わなければ自動で消える）: 同じ日のあとで書いたアイテムを、了解の記録が消えたあとに残さない")]
    public async Task ItemsWrittenLaterInTheDayDoNotOutliveConsent()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateUserClient("g-1");
        var store = factory.Services.GetRequiredService<IDataStore>();
        var userKey = UserKey("google", "g-1");

        // 日本時間 11/02 12:00 に了解し、その日の最初の要求で書き直す
        await Consent(client);
        await client.GetAsync("/api/me", Ct);
        // 同じ日の 23:00 に送る（送信回数のアイテムは、了解の記録より 11 時間あとに書かれる）
        factory.Clock.SetUtcNow(DateTimeOffset.Parse("2026-11-02T14:00:00Z"));
        Assert.Equal(HttpStatusCode.NoContent, (await client.PostAsync("/api/_test/send", null, Ct)).StatusCode);

        // 日本時間 12/02 13:00。了解の記録は 30 日たって消えたが、送信回数のアイテムはまだ TTL が残っている
        factory.Clock.SetUtcNow(DateTimeOffset.Parse("2026-12-02T04:00:00Z"));
        var me = await client.GetFromJsonAsync<JsonElement>("/api/me", Ct);
        Assert.False(me.GetProperty("consented").GetBoolean());
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/stats", Ct)).StatusCode);
        Assert.Equal(0, await store.CountAllAsync(userKey, Ct));

        // 了解し直しても、前の残りは戻らない（了解の記録と使った記録だけ）
        await Consent(client);
        await client.GetAsync("/api/me", Ct);
        Assert.Equal(2, await store.CountAllAsync(userKey, Ct));
    }

    [Fact(DisplayName = "foundation-1（案内はログインなしで見られる）: ログインしていない人のデータは作らない")]
    public async Task AnonymousRequestsDoNotStoreData()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateClient();

        await client.GetAsync("/api/health", Ct);
        await client.GetAsync("/", Ct);

        var store = (InMemoryDataStore)factory.Services.GetRequiredService<IDataStore>();
        Assert.Empty(await store.DumpRawJsonAsync(Ct).ToListAsync(Ct));
    }

    [Fact(DisplayName = "foundation-4（使わなければ自動で消える）: 本番で Cosmos の場所がなければ起動しない")]
    public async Task ProductionWithoutCosmosDoesNotStart()
    {
        await using var factory = new RevalueFactory().WithEnvironment("Production");

        var error = Assert.ThrowsAny<Exception>(() => factory.CreateClient());
        Assert.Contains("Cosmos:Endpoint", error.ToString());
    }

    [Fact(DisplayName = "foundation-4（使わなければ自動で消える）: Cosmos の場所があれば Cosmos を使い、なければインメモリ")]
    public async Task DataStoreIsChosenByEndpoint()
    {
        await using var inMemory = new RevalueFactory();
        Assert.IsType<InMemoryDataStore>(inMemory.Services.GetRequiredService<IDataStore>());

        await using var cosmos = new RevalueFactory().WithSetting("Cosmos:Endpoint", "https://cosmos.example.com:443/");
        Assert.IsType<CosmosDataStore>(cosmos.Services.GetRequiredService<IDataStore>());
    }

    [Fact(DisplayName = "foundation-5（名前とメールアドレスを残さない）: 開発用ログインで利用者を切り替えられる")]
    public async Task DevLoginCanSwitchUsers()
    {
        await using var factory = new RevalueFactory().WithEnvironment("Development");
        var options = new WebApplicationFactoryClientOptions { AllowAutoRedirect = false };
        var a = factory.CreateClient(options);
        var b = factory.CreateClient(options);

        Assert.Equal(HttpStatusCode.Redirect, (await a.GetAsync("/.auth/login/google?dev_user=a", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.Redirect, (await b.GetAsync("/.auth/login/google?dev_user=b", Ct)).StatusCode);
        await Consent(a);
        await Consent(b);
        await a.GetAsync("/api/nope", Ct);
        await b.GetAsync("/api/nope", Ct);

        var store = factory.Services.GetRequiredService<IDataStore>();
        var keyA = UserKey("dev", "a");
        var keyB = UserKey("dev", "b");
        Assert.NotEqual(keyA, keyB);
        Assert.NotNull(await store.GetAsync<ActivityItem>(keyA, ActivityItem.ItemId, Ct));
        Assert.NotNull(await store.GetAsync<ActivityItem>(keyB, ActivityItem.ItemId, Ct));
    }
}
