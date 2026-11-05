using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Ai;
using static Revalue.Server.Tests.ValidateTestKit;

namespace Revalue.Server.Tests;

public sealed class NextStepApiTests
{
    private sealed record Kit(RevalueFactory Factory, FakeConversationAi Ai);

    private static Kit Setup()
    {
        var ai = new FakeConversationAi();
        var factory = new RevalueFactory().WithTestServices(services =>
        {
            services.AddSingleton<IConversationAi>(ai);
            services.AddSingleton<IOptionsAi>(new FakeOptionsAi());
            services.AddSingleton<IDeepenAi>(new FakeDeepenAi());
        });
        return new Kit(factory, ai);
    }

    private static async Task<(string Step, string? EpisodeId)> Next(HttpClient client)
    {
        var response = await client.GetAsync("/api/next-step", Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var dto = await Json(response);
        var id = dto.GetProperty("episodeId");
        return (dto.GetProperty("step").GetString()!, id.ValueKind == JsonValueKind.Null ? null : id.GetString());
    }

    private static async Task PutOk(HttpClient client, string path, object body) =>
        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(path, body, Ct)).StatusCode);

    [Fact(DisplayName = "common-3（次にできることを一つ示す）: 了解していない人は使えない")]
    public async Task RequiresConsent()
    {
        var kit = Setup();
        var client = kit.Factory.CreateUserClient("n-0");

        var response = await client.GetAsync("/api/next-step", Ct);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("/problems/consent-required", (await Json(response)).GetProperty("type").GetString());
    }

    [Fact(DisplayName = "common-3（次にできることを一つ示す）: 話す → 条件を入れる → 仕事の選択肢 → 深める → レポートの順に、次にできることが一つずつ変わる")]
    public async Task FollowsTheRecords()
    {
        var kit = Setup();
        var client = await Consenting(kit.Factory, "n-1");
        Assert.Equal(("talk", (string?)null), await Next(client));

        await FinishedEpisode(client, kit.Ai, BalancingInterestsAll);
        Assert.Equal(("conditions", (string?)null), await Next(client));

        await PutOk(client, "/api/profile/conditions", new { timeSlots = new[] { "daytime", "evening" }, hoursPerWeek = 10, place = "homeOnly", monthlyIncome = 5 });
        Assert.Equal(("options", (string?)null), await Next(client));

        var generated = await client.PostAsync("/api/options", null, Ct);
        Assert.Equal(HttpStatusCode.OK, generated.StatusCode);
        var generatedAt = (await Json(generated)).GetProperty("cards").GetProperty("generatedAt").GetString();
        await PutOk(client, "/api/options/choice", new { kind = "card", card = "choose", generatedAt });
        Assert.Equal(("deepen", (string?)null), await Next(client));

        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/api/deepen", null, Ct)).StatusCode);
        Assert.Equal(("report", (string?)null), await Next(client));

        await PutOk(client, "/api/options/choice", new { kind = "hold" });
        Assert.Equal(("report", (string?)null), await Next(client));

        var talking = await Start(client);
        Assert.Equal(("continue", talking), await Next(client));
    }

    [Fact(DisplayName = "common-3（次にできることを一つ示す）: 1 日の送信回数を使わず、上限に届いていても使える。ログには時間だけを書く")]
    public async Task UsesNoDailyCountAndLogsOnlyTime()
    {
        var ai = new FakeConversationAi();
        await using var factory = new RevalueFactory()
            .WithSetting("Limits:MessagesPerDay", "1")
            .WithTestServices(services => services.AddSingleton<IConversationAi>(ai));
        var client = await Consenting(factory, "n-2");
        var talking = await Start(client);
        Assert.Equal(HttpStatusCode.NoContent, (await client.PostAsync("/api/_test/send", null, Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await client.PostAsync("/api/_test/send", null, Ct)).StatusCode);

        Assert.Equal(("continue", talking), await Next(client));
        Assert.Equal(("continue", talking), await Next(client));

        var lines = factory.CapturedLogs.Where(l => l.Contains("Next step decided in", StringComparison.Ordinal)).ToList();
        Assert.Equal(2, lines.Count);
        Assert.All(lines, l => Assert.DoesNotContain(talking, l, StringComparison.Ordinal));
        Assert.All(lines, l => Assert.DoesNotContain("continue", l, StringComparison.OrdinalIgnoreCase));
    }
}
