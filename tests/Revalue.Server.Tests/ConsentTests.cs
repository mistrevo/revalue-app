using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Data;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Foundation.Consent;

namespace Revalue.Server.Tests;

public sealed class ConsentTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<JsonElement> GetMe(HttpClient client)
    {
        var response = await client.GetAsync("/api/me", Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
    }

    private static Task<HttpResponseMessage> Consent(HttpClient client, string version) =>
        client.PostAsJsonAsync("/api/consent", new { version }, Ct);

    [Fact(DisplayName = "foundation-2（始める前に保存するものを示す）: 初めての人は了解していない")]
    public async Task NewUserHasNotConsented()
    {
        await using var factory = new RevalueFactory();
        var me = await GetMe(factory.CreateUserClient("g-1"));

        Assert.False(me.GetProperty("consented").GetBoolean());
        Assert.Equal(ConsentInfo.CurrentVersion, me.GetProperty("currentVersion").GetString());
        Assert.Equal(JsonValueKind.Null, me.GetProperty("consentVersion").ValueKind);
    }

    [Fact(DisplayName = "foundation-2（始める前に保存するものを示す）: 了解するまで、了解の要る API は 403")]
    public async Task ConsentRequiredApiIsForbiddenBeforeConsent()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateUserClient("g-1");

        var response = await client.GetAsync("/api/stats", Ct);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Assert.Equal("/problems/consent-required", problem.GetProperty("type").GetString());

        Assert.Equal(HttpStatusCode.NoContent, (await Consent(client, ConsentInfo.CurrentVersion)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/stats", Ct)).StatusCode);
    }

    [Fact(DisplayName = "foundation-2（始める前に保存するものを示す）: 了解すると記録が残る")]
    public async Task ConsentIsRecorded()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateUserClient("g-1");

        Assert.Equal(HttpStatusCode.NoContent, (await Consent(client, ConsentInfo.CurrentVersion)).StatusCode);

        var me = await GetMe(client);
        Assert.True(me.GetProperty("consented").GetBoolean());
        Assert.Equal(ConsentInfo.CurrentVersion, me.GetProperty("consentVersion").GetString());
        var store = factory.Services.GetRequiredService<IDataStore>();
        var item = await store.GetAsync<ConsentItem>(TestUsers.Key("g-1"), ConsentItem.ItemId, Ct);
        Assert.Equal(factory.Clock.GetUtcNow(), item!.At);
        Assert.Equal(ConsentInfo.CurrentVersion, item.Version);
    }

    [Fact(DisplayName = "foundation-2（始める前に保存するものを示す）: 古い版の了解は了解していない扱い")]
    public async Task OldVersionConsentDoesNotCount()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateUserClient("g-1");
        var store = factory.Services.GetRequiredService<IDataStore>();
        await store.UpsertAsync(new ConsentItem
        {
            Id = ConsentItem.ItemId, UserKey = TestUsers.Key("g-1"), Type = ConsentItem.ItemType,
            Version = "2026-10-01", At = factory.Clock.GetUtcNow(),
        }, Ct);

        var me = await GetMe(client);

        Assert.False(me.GetProperty("consented").GetBoolean());
        Assert.Equal("2026-10-01", me.GetProperty("consentVersion").GetString());
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/stats", Ct)).StatusCode);
    }

    [Fact(DisplayName = "foundation-2（始める前に保存するものを示す）: はじめにの中身を変えたので版を上げた。前の版で了解した人は、了解し直すまで了解の要る API を使えない")]
    public async Task PreviousVersionConsentMustBeRenewed()
    {
        Assert.Equal("2026-11-03-2", ConsentInfo.CurrentVersion);
        await using var factory = new RevalueFactory();
        var client = factory.CreateUserClient("g-1");
        var store = factory.Services.GetRequiredService<IDataStore>();
        await store.UpsertAsync(new ConsentItem
        {
            Id = ConsentItem.ItemId, UserKey = TestUsers.Key("g-1"), Type = ConsentItem.ItemType,
            Version = "2026-11-03", At = factory.Clock.GetUtcNow(),
        }, Ct);

        Assert.False((await GetMe(client)).GetProperty("consented").GetBoolean());
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/next-step", Ct)).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await Consent(client, ConsentInfo.CurrentVersion)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/next-step", Ct)).StatusCode);
    }

    [Fact(DisplayName = "foundation-2（始める前に保存するものを示す）: 了解する前の要求では、その人のアイテムを作らない")]
    public async Task NoItemsAreStoredBeforeConsent()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateUserClient("g-1");
        var store = factory.Services.GetRequiredService<IDataStore>();
        var key = TestUsers.Key("g-1");

        await GetMe(client);
        await client.GetAsync("/start", Ct);
        await client.GetAsync("/api/stats", Ct);
        await Consent(client, "2026-10-01");
        Assert.Equal(0, await store.CountAllAsync(key, Ct));

        Assert.Equal(HttpStatusCode.NoContent, (await Consent(client, ConsentInfo.CurrentVersion)).StatusCode);
        await GetMe(client);
        Assert.NotNull(await store.GetAsync<ActivityItem>(key, ActivityItem.ItemId, Ct));
    }

    [Fact(DisplayName = "foundation-2（始める前に保存するものを示す）: 古い版の了解のままでは、使った記録を書かない")]
    public async Task OldVersionConsentDoesNotTouch()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateUserClient("g-1");
        var store = factory.Services.GetRequiredService<IDataStore>();
        var key = TestUsers.Key("g-1");
        await store.UpsertAsync(new ConsentItem
        {
            Id = ConsentItem.ItemId, UserKey = key, Type = ConsentItem.ItemType,
            Version = "2026-10-01", At = factory.Clock.GetUtcNow(),
        }, Ct);

        await GetMe(client);

        Assert.Null(await store.GetAsync<ActivityItem>(key, ActivityItem.ItemId, Ct));
    }

    [Fact(DisplayName = "foundation-2（始める前に保存するものを示す）: 違う版で了解しようとすると 400")]
    public async Task WrongVersionIsRejected()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateUserClient("g-1");

        Assert.Equal(HttpStatusCode.BadRequest, (await Consent(client, "2026-10-01")).StatusCode);
        Assert.False((await GetMe(client)).GetProperty("consented").GetBoolean());
    }
}
