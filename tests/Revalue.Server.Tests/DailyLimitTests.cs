using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Data;

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

    [Fact(DisplayName = "foundation-6（使いすぎを穏やかに止める）: 日付が変わったあと、前の日の送信回数を残さない")]
    public async Task PreviousDayCountIsNotKept()
    {
        await using var factory = Limited();
        factory.Clock.SetUtcNow(DateTimeOffset.Parse("2026-11-02T05:00:00Z"));
        var client = await Consenting(factory, "a");
        for (var i = 0; i < 2; i++)
        {
            Assert.Equal(HttpStatusCode.NoContent, (await Send(client)).StatusCode);
        }

        factory.Clock.SetUtcNow(DateTimeOffset.Parse("2026-11-03T05:00:00Z"));
        Assert.Equal(HttpStatusCode.NoContent, (await Send(client)).StatusCode);

        var store = (InMemoryDataStore)factory.Services.GetRequiredService<IDataStore>();
        var usage = new List<JsonElement>();
        await foreach (var json in store.DumpRawJsonAsync(Ct))
        {
            using var document = JsonDocument.Parse(json);
            var item = document.RootElement;
            if (item.GetProperty("userKey").GetString() == TestUsers.Key("a") && item.GetProperty("type").GetString() == "usage")
            {
                usage.Add(item.Clone());
            }
        }

        var only = Assert.Single(usage);
        Assert.Equal("2026-11-03", only.GetProperty("date").GetString());
        Assert.Equal(1, only.GetProperty("count").GetInt64());
    }

    [Fact(DisplayName = "foundation-6（使いすぎを穏やかに止める）: 翌日に開くだけで送らなくても、前の日の回数は残らない")]
    public async Task PreviousDayCountIsNotKeptWhenOnlyOpening()
    {
        await using var factory = Limited();
        factory.Clock.SetUtcNow(DateTimeOffset.Parse("2026-11-02T05:00:00Z"));
        var client = await Consenting(factory, "a");
        for (var i = 0; i < 2; i++)
        {
            Assert.Equal(HttpStatusCode.NoContent, (await Send(client)).StatusCode);
        }

        var store = (InMemoryDataStore)factory.Services.GetRequiredService<IDataStore>();
        foreach (var day in new[] { "2026-11-03T05:00:00Z", "2026-11-30T05:00:00Z" })
        {
            factory.Clock.SetUtcNow(DateTimeOffset.Parse(day));
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/me", Ct)).StatusCode);

            await foreach (var json in store.DumpRawJsonAsync(Ct))
            {
                using var document = JsonDocument.Parse(json);
                var item = document.RootElement;
                if (item.GetProperty("userKey").GetString() == TestUsers.Key("a") && item.GetProperty("type").GetString() == "usage")
                {
                    Assert.NotEqual("2026-11-02", item.GetProperty("date").GetString());
                    Assert.Equal(0, item.GetProperty("count").GetInt64());
                }
            }
        }
    }

    [Fact(DisplayName = "foundation-6（使いすぎを穏やかに止める）: 1 人が同時に送っても、上限を超えて通さない")]
    public async Task PerUserLimitHoldsUnderConcurrentSends()
    {
        await using var factory = new RevalueFactory().WithSetting("Limits:MessagesPerDay", "1");
        var client = await Consenting(factory, "a");

        var statuses = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => Task.Run(async () => (await Send(client)).StatusCode)));

        Assert.Equal(1, statuses.Count(s => s == HttpStatusCode.NoContent));
        Assert.Equal(49, statuses.Count(s => s == HttpStatusCode.TooManyRequests));
    }

    [Fact(DisplayName = "foundation-6（使いすぎを穏やかに止める）: 大勢が同時に送っても、アプリ全体の上限を超えて通さない")]
    public async Task TotalLimitHoldsUnderConcurrentSends()
    {
        await using var factory = new RevalueFactory().WithSetting("Limits:MessagesPerDayTotal", "1");
        var clients = new List<HttpClient>();
        for (var i = 0; i < 40; i++)
        {
            clients.Add(await Consenting(factory, $"user-{i}"));
        }

        var statuses = await Task.WhenAll(clients.Select(client => Task.Run(async () => (await Send(client)).StatusCode)));

        Assert.Equal(1, statuses.Count(s => s == HttpStatusCode.NoContent));
        Assert.Equal(39, statuses.Count(s => s == HttpStatusCode.TooManyRequests));
    }

    [Fact(DisplayName = "foundation-6（使いすぎを穏やかに止める）: 了解していない人は上限より先に 403")]
    public async Task ConsentIsCheckedBeforeLimit()
    {
        await using var factory = Limited();
        var client = factory.CreateUserClient("a");

        Assert.Equal(HttpStatusCode.Forbidden, (await Send(client)).StatusCode);
    }
}
