using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Revalue.Server.Tests;

public sealed class DailyLimitTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static RevalueFactory Limited() => new RevalueFactory()
        .WithSetting("Limits:MessagesPerDay", "3")
        .WithSetting("Limits:MessagesPerDayTotal", "5");

    private static async Task<HttpClient> Consenting(RevalueFactory factory, string id)
    {
        var client = factory.CreateUserClient(id);
        await client.PostAsJsonAsync("/api/consent", new { version = "2026-11-02" }, Ct);
        return client;
    }

    private static Task<HttpResponseMessage> Send(HttpClient client) => client.PostAsync("/api/_test/send", null, Ct);

    [Fact(DisplayName = "foundation-6（使いすぎを穏やかに止める）: 1 人の上限を超えると 429 と次に送れる時刻")]
    public async Task PerUserLimitReturns429WithResetTime()
    {
        await using var factory = Limited();
        factory.Clock.SetUtcNow(DateTimeOffset.Parse("2026-11-02T05:00:00Z"));
        var client = await Consenting(factory, "a");

        for (var i = 0; i < 3; i++)
        {
            Assert.Equal(HttpStatusCode.NoContent, (await Send(client)).StatusCode);
        }

        var response = await Send(client);
        Assert.Equal(HttpStatusCode.TooManyRequests, response.StatusCode);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Assert.Equal("/problems/daily-limit", problem.GetProperty("type").GetString());
        Assert.Equal("2026-11-03T00:00:00+09:00", problem.GetProperty("resetAt").GetString());
    }

    [Fact(DisplayName = "foundation-6（使いすぎを穏やかに止める）: アプリ全体の上限でも止まる")]
    public async Task TotalLimitStopsEveryone()
    {
        await using var factory = Limited();
        var a = await Consenting(factory, "a");
        var b = await Consenting(factory, "b");
        var c = await Consenting(factory, "c");

        var results = new List<HttpStatusCode>();
        foreach (var client in new[] { a, a, b, b, c, c })
        {
            results.Add((await Send(client)).StatusCode);
        }

        Assert.Equal(new[] { HttpStatusCode.NoContent, HttpStatusCode.NoContent, HttpStatusCode.NoContent, HttpStatusCode.NoContent, HttpStatusCode.NoContent, HttpStatusCode.TooManyRequests }, results);
    }

    [Fact(DisplayName = "foundation-6（使いすぎを穏やかに止める）: 日本時間の 0 時を過ぎるとまた送れる")]
    public async Task LimitResetsAtJstMidnight()
    {
        await using var factory = Limited();
        factory.Clock.SetUtcNow(DateTimeOffset.Parse("2026-11-02T05:00:00Z"));
        var client = await Consenting(factory, "a");
        for (var i = 0; i < 3; i++)
        {
            await Send(client);
        }

        factory.Clock.SetUtcNow(DateTimeOffset.Parse("2026-11-02T14:59:59Z"));
        Assert.Equal(HttpStatusCode.TooManyRequests, (await Send(client)).StatusCode);

        factory.Clock.SetUtcNow(DateTimeOffset.Parse("2026-11-02T15:00:00Z"));
        Assert.Equal(HttpStatusCode.NoContent, (await Send(client)).StatusCode);
    }

    [Fact(DisplayName = "foundation-6（使いすぎを穏やかに止める）: 了解していない人は上限より先に 403")]
    public async Task ConsentIsCheckedBeforeLimit()
    {
        await using var factory = Limited();
        var client = factory.CreateUserClient("a");

        Assert.Equal(HttpStatusCode.Forbidden, (await Send(client)).StatusCode);
    }
}
