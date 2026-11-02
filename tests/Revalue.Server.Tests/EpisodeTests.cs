using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Data;
using Revalue.Server.Features.Discover;

namespace Revalue.Server.Tests;

public sealed class EpisodeTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<HttpClient> Consenting(RevalueFactory factory, string id)
    {
        var client = factory.CreateUserClient(id);
        var consent = await client.PostAsJsonAsync("/api/consent", new { version = "2026-11-02" }, Ct);
        Assert.Equal(HttpStatusCode.NoContent, consent.StatusCode);
        return client;
    }

    private static async Task<JsonElement> Json(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>(Ct);

    private static async Task<JsonElement> Start(HttpClient client)
    {
        var response = await client.PostAsync("/api/episodes", null, Ct);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return await Json(response);
    }

    /// <summary>保存先に、利用者の答えを足した場面を直接書く（答えを送る API は 02 の Task 4 で作る）。</summary>
    private static async Task AddUserAnswer(RevalueFactory factory, string principalId, string episodeId, string text)
    {
        var store = factory.Services.GetRequiredService<IDataStore>();
        var key = TestUsers.Key(principalId);
        var episode = (await store.GetAsync<EpisodeItem>(key, episodeId, Ct))!;
        await store.UpsertAsync(episode with
        {
            Turns = [.. episode.Turns, new Turn { Role = TurnRoles.User, Text = text, AnswerKind = AnswerKind.Free, At = factory.Clock.GetUtcNow() }],
        }, Ct);
    }

    [Fact(DisplayName = "discover-1（具体的な一日を一つ聞く）: 新しい場面は、最近の具体的な一日を尋ねる問いで始まる")]
    public async Task NewEpisodeStartsWithConcreteDayQuestion()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");

        var episode = await Start(client);

        Assert.StartsWith("episode-", episode.GetProperty("id").GetString());
        Assert.Equal("talking", episode.GetProperty("status").GetString());
        var turns = episode.GetProperty("turns");
        Assert.Equal(1, turns.GetArrayLength());
        var first = turns[0];
        Assert.Equal("assistant", first.GetProperty("role").GetString());
        Assert.Equal(DiscoverText.Opening, first.GetProperty("text").GetString());
        Assert.DoesNotContain("強み", first.GetProperty("text").GetString());
        Assert.Equal(DiscoverText.OpeningChoices, first.GetProperty("choices").EnumerateArray().Select(c => c.GetString()!).ToArray());
        Assert.Equal(3, DiscoverText.OpeningChoices.Count);
    }

    [Fact(DisplayName = "discover-6（一場面ずつ区切り、続きから話せる）: 途中の場面があると新しく始められない")]
    public async Task CannotStartWhileTalking()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");
        var first = await Start(client);

        var second = await client.PostAsync("/api/episodes", null, Ct);

        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
        var problem = await Json(second);
        Assert.Equal("/problems/episode-in-progress", problem.GetProperty("type").GetString());
        Assert.Equal(first.GetProperty("id").GetString(), problem.GetProperty("episodeId").GetString());
    }

    [Fact(DisplayName = "discover-6（一場面ずつ区切り、続きから話せる）: 区切ると話し終えた状態になり、新しく始められる")]
    public async Task FinishThenStartAgain()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");
        var id = (await Start(client)).GetProperty("id").GetString();

        var finished = await client.PostAsync($"/api/episodes/{id}/finish", null, Ct);

        Assert.Equal(HttpStatusCode.OK, finished.StatusCode);
        var body = await Json(finished);
        Assert.Equal("finished", body.GetProperty("status").GetString());
        Assert.Equal(factory.Clock.GetUtcNow(), body.GetProperty("finishedAt").GetDateTimeOffset());

        // 話し終えた場面をもう一度区切ることはできない
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsync($"/api/episodes/{id}/finish", null, Ct)).StatusCode);

        var next = await Start(client);
        Assert.NotEqual(id, next.GetProperty("id").GetString());
    }

    [Fact(DisplayName = "discover-6（一場面ずつ区切り、続きから話せる）: 途中の場面は、開き直すとそのまま読める")]
    public async Task TalkingEpisodeCanBeReopened()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");
        var id = (await Start(client)).GetProperty("id").GetString()!;
        await AddUserAnswer(factory, "g-1", id, "架空の答え。昨日は朝から子どもの支度をした");

        var reopened = await client.GetAsync($"/api/episodes/{id}", Ct);

        Assert.Equal(HttpStatusCode.OK, reopened.StatusCode);
        var body = await Json(reopened);
        Assert.Equal("talking", body.GetProperty("status").GetString());
        Assert.Equal(2, body.GetProperty("turns").GetArrayLength());
        Assert.Equal("free", body.GetProperty("turns")[1].GetProperty("answerKind").GetString());
    }

    [Fact(DisplayName = "discover-8（話した出来事が残る）: 一覧に途中と話し終えた場面が新しい順に出る")]
    public async Task ListShowsEpisodesNewestFirst()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");
        var older = (await Start(client)).GetProperty("id").GetString()!;
        const string answer = "架空の答え。昨日はスーパーで買い物をして、帰りに保育園へ寄って子どもを迎えた";
        await AddUserAnswer(factory, "g-1", older, answer);
        await client.PostAsync($"/api/episodes/{older}/finish", null, Ct);
        factory.Clock.Advance(TimeSpan.FromMinutes(5));
        var newer = (await Start(client)).GetProperty("id").GetString()!;

        var response = await client.GetAsync("/api/episodes", Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var list = (await Json(response)).EnumerateArray().ToArray();
        Assert.Equal([newer, older], list.Select(e => e.GetProperty("id").GetString()));
        Assert.Equal("talking", list[0].GetProperty("status").GetString());
        Assert.Equal(0, list[0].GetProperty("userTurnCount").GetInt32());
        Assert.Equal("", list[0].GetProperty("preview").GetString());
        Assert.Equal("finished", list[1].GetProperty("status").GetString());
        Assert.Equal(1, list[1].GetProperty("userTurnCount").GetInt32());
        Assert.Equal(answer[..30], list[1].GetProperty("preview").GetString());
        Assert.True(list[1].TryGetProperty("startedAt", out _));
    }

    [Fact(DisplayName = "discover-8（話した出来事が残る）: ほかの人のエピソードは読めない")]
    public async Task OtherUsersEpisodesAreNotFound()
    {
        await using var factory = new RevalueFactory();
        var owner = await Consenting(factory, "g-1");
        var other = await Consenting(factory, "g-2");
        var id = (await Start(owner)).GetProperty("id").GetString();

        Assert.Equal(HttpStatusCode.NotFound, (await other.GetAsync($"/api/episodes/{id}", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await other.PostAsync($"/api/episodes/{id}/finish", null, Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await other.PostAsync($"/api/episodes/{id}/skip", null, Ct)).StatusCode);
        Assert.Empty((await Json(await other.GetAsync("/api/episodes", Ct))).EnumerateArray());

        // 持ち主のほうは、何も変わっていない
        var mine = await Json(await owner.GetAsync($"/api/episodes/{id}", Ct));
        Assert.Equal("talking", mine.GetProperty("status").GetString());
    }

    [Fact(DisplayName = "discover-8（話した出来事が残る）: エピソードでないアイテムの id では読めない")]
    public async Task NonEpisodeIdsAreNotFound()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");

        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/episodes/consent", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync("/api/episodes/consent/skip", null, Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/episodes/episode-missing", Ct)).StatusCode);
    }

    [Fact(DisplayName = "discover-5（つらい話は飛ばせる）: 飛ばすと元の場面は消え、最初とは違う問いで新しい場面が始まる")]
    public async Task SkipDeletesAndStartsWithDifferentQuestion()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");
        var id = (await Start(client)).GetProperty("id").GetString()!;
        const string marker = "架空の飛ばしたい話-目印-7f3a";
        await AddUserAnswer(factory, "g-1", id, marker);

        var skipped = await client.PostAsync($"/api/episodes/{id}/skip", null, Ct);

        Assert.Equal(HttpStatusCode.Created, skipped.StatusCode);
        var next = await Json(skipped);
        Assert.NotEqual(id, next.GetProperty("id").GetString());
        Assert.Equal("talking", next.GetProperty("status").GetString());
        var first = next.GetProperty("turns")[0];
        Assert.Equal(DiscoverText.AfterSkip, first.GetProperty("text").GetString());
        Assert.NotEqual(DiscoverText.Opening, DiscoverText.AfterSkip);
        Assert.Equal(DiscoverText.AfterSkipChoices, first.GetProperty("choices").EnumerateArray().Select(c => c.GetString()!).ToArray());

        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/episodes/{id}", Ct)).StatusCode);
        var store = factory.Services.GetRequiredService<IDataStore>();
        await foreach (var json in store.DumpRawJsonAsync(Ct))
        {
            Assert.DoesNotContain(marker, json);
        }

        var list = (await Json(await client.GetAsync("/api/episodes", Ct))).EnumerateArray().ToArray();
        Assert.Single(list);
    }

    [Fact(DisplayName = "discover-5（つらい話は飛ばせる）: 話し終えた場面は飛ばせない")]
    public async Task FinishedEpisodeCannotBeSkipped()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");
        var id = (await Start(client)).GetProperty("id").GetString();
        await client.PostAsync($"/api/episodes/{id}/finish", null, Ct);

        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsync($"/api/episodes/{id}/skip", null, Ct)).StatusCode);
    }

    [Fact(DisplayName = "foundation-2（始める前に保存するものを示す）: 了解していない人はエピソードの API を使えない")]
    public async Task EpisodesRequireConsent()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateUserClient("g-1");

        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/episodes", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsync("/api/episodes", null, Ct)).StatusCode);
    }
}
