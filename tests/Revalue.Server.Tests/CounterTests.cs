using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Data;
using Revalue.Server.Features.Foundation.Counting;

namespace Revalue.Server.Tests;

public sealed class CounterTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>数えるのは了解した人だけ（しるしは、その人のパーティションに置くため）。</summary>
    private static async Task Consent(RevalueFactory factory, params string[] principalIds)
    {
        foreach (var id in principalIds)
        {
            var response = await factory.CreateUserClient(id).PostAsJsonAsync("/api/consent", new { version = "2026-11-02" }, Ct);
            Assert.Equal(System.Net.HttpStatusCode.NoContent, response.StatusCode);
        }
    }

    [Fact(DisplayName = "foundation-8（数だけを数える）: 同じ人を何度数えても 1 回だけ")]
    public async Task SamePersonIsCountedOnce()
    {
        await using var factory = new RevalueFactory();
        var counter = factory.Services.GetRequiredService<ICounter>();
        await Consent(factory, "a", "b");

        for (var i = 0; i < 3; i++)
        {
            await counter.CountOnceAsync(TestUsers.Key("a"), CountMetric.ReachedReport, Ct);
        }

        Assert.Equal(new StatsDto(1, 0), await counter.GetAsync(Ct));

        await counter.CountOnceAsync(TestUsers.Key("b"), CountMetric.ReachedReport, Ct);
        await counter.CountOnceAsync(TestUsers.Key("a"), CountMetric.ChoseOption, Ct);

        Assert.Equal(new StatsDto(2, 1), await counter.GetAsync(Ct));
    }

    [Fact(DisplayName = "foundation-8（数だけを数える）: 同じ人を同時に何度数えても 1 回だけ")]
    public async Task SamePersonCountedConcurrentlyIsCountedOnce()
    {
        await using var factory = new RevalueFactory();
        var counter = factory.Services.GetRequiredService<ICounter>();
        await Consent(factory, "a");

        await Task.WhenAll(Enumerable.Range(0, 50).Select(_ =>
            Task.Run(() => counter.CountOnceAsync(TestUsers.Key("a"), CountMetric.ReachedReport, Ct))));

        Assert.Equal(new StatsDto(1, 0), await counter.GetAsync(Ct));
    }

    [Fact(DisplayName = "foundation-8（数だけを数える）: 数のアイテムは利用者キーを持たない")]
    public async Task CountItemsCarryNoUserKey()
    {
        await using var factory = new RevalueFactory();
        var counter = factory.Services.GetRequiredService<ICounter>();
        await Consent(factory, "a", "b");
        var keyA = TestUsers.Key("a");
        var keyB = TestUsers.Key("b");
        await counter.CountOnceAsync(keyA, CountMetric.ReachedReport, Ct);
        await counter.CountOnceAsync(keyB, CountMetric.ReachedReport, Ct);

        var store = (InMemoryDataStore)factory.Services.GetRequiredService<IDataStore>();
        var countJson = new List<string>();
        await foreach (var json in store.DumpRawJsonAsync(Ct))
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.GetProperty("userKey").GetString() == DataConstants.GlobalPartition)
            {
                countJson.Add(json);
            }
        }

        Assert.NotEmpty(countJson);
        Assert.All(countJson, json =>
        {
            Assert.DoesNotContain(keyA, json);
            Assert.DoesNotContain(keyB, json);
        });
    }

    [Fact(DisplayName = "foundation-8（数だけを数える）: 全部消しても数は減らない")]
    public async Task DeletingEverythingDoesNotReduceCounts()
    {
        await using var factory = new RevalueFactory();
        var counter = factory.Services.GetRequiredService<ICounter>();
        var a = factory.CreateUserClient("a");
        var b = factory.CreateUserClient("b");
        foreach (var client in new[] { a, b })
        {
            await client.PostAsJsonAsync("/api/consent", new { version = "2026-11-02" }, Ct);
        }

        await counter.CountOnceAsync(TestUsers.Key("a"), CountMetric.ReachedReport, Ct);
        await counter.CountOnceAsync(TestUsers.Key("b"), CountMetric.ReachedReport, Ct);
        var before = await b.GetFromJsonAsync<JsonElement>("/api/stats", Ct);
        Assert.Equal(2, before.GetProperty("reachedReport").GetInt64());

        await a.DeleteAsync("/api/me", Ct);

        var after = await b.GetFromJsonAsync<JsonElement>("/api/stats", Ct);
        Assert.Equal(2, after.GetProperty("reachedReport").GetInt64());
        Assert.Equal(0, after.GetProperty("choseOption").GetInt64());
    }
}
