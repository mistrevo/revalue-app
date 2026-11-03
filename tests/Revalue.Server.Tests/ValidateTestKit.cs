using Revalue.Server.Features.Foundation.Consent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Ai;
using Revalue.Server.Data;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

/// <summary>03 validate（確かめる）の結合テストで使う、立ち上げと呼び出しの手助け。</summary>
public static class ValidateTestKit
{
    public static CancellationToken Ct => TestContext.Current.CancellationToken;

    public const string CoordinatingAnswer = "夫と母の予定がぶつかっていたので、二人に電話して、迎えの時間をずらしてもらいました。";

    /// <summary>偽物の AI で立ち上げる。<paramref name="interrupting"/> なら、書き込みの直前に割り込ませる保存先にする。</summary>
    public static (RevalueFactory Factory, FakeConversationAi Ai) Create(bool interrupting = false, RevalueFactory? baseFactory = null)
    {
        var ai = new FakeConversationAi();
        var factory = (baseFactory ?? new RevalueFactory()).WithTestServices(services =>
        {
            services.AddSingleton<IConversationAi>(ai);
            if (interrupting)
            {
                InterruptingDataStore.Install(services);
            }
        });
        return (factory, ai);
    }

    public static async Task<HttpClient> Consenting(RevalueFactory factory, string id)
    {
        var client = factory.CreateUserClient(id);
        var consent = await client.PostAsJsonAsync("/api/consent", new { version = ConsentInfo.CurrentVersion }, Ct);
        Assert.Equal(HttpStatusCode.NoContent, consent.StatusCode);
        return client;
    }

    public static async Task<string> Start(HttpClient client)
    {
        var response = await client.PostAsync("/api/episodes", null, Ct);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await Json(response)).GetProperty("id").GetString()!;
    }

    /// <summary>答えを送り、返事を最後まで受け取る。</summary>
    public static async Task Send(HttpClient client, string id, string text, string kind = "free")
    {
        var response = await client.PostAsJsonAsync($"/api/episodes/{id}/messages", new { text, kind }, Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("event: done", await response.Content.ReadAsStringAsync(Ct));
    }

    public static async Task Finish(HttpClient client, string id)
    {
        var response = await client.PostAsync($"/api/episodes/{id}/finish", null, Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    public static async Task<JsonElement> GetEpisode(HttpClient client, string id)
    {
        var response = await client.GetAsync($"/api/episodes/{id}", Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await Json(response);
    }

    public static async Task<JsonElement> Json(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>(Ct);

    public static Task<HttpResponseMessage> Correct(HttpClient client, string id, string? text) =>
        client.PostAsJsonAsync($"/api/episodes/{id}/corrections", new { text }, Ct);

    public static Task<HttpResponseMessage> Resume(HttpClient client, string id) =>
        client.PostAsync($"/api/episodes/{id}/resume", null, Ct);

    public static TurnReading ReadingWith(params EvidenceCandidate[] candidates) =>
        new(new HashSet<AnswerSignal> { AnswerSignal.ConcreteEvent }, candidates);

    public static EvidenceCandidate Candidate(Ability ability, int action, string quote, int answer = 1) =>
        new(ability, action, quote, answer, 1, false, "", 0);

    public static readonly EvidenceCandidate[] CoordinatingAll =
    [
        Candidate(Ability.Coordinating, 1, "夫と母の予定がぶつかって"),
        Candidate(Ability.Coordinating, 2, "二人に電話して"),
        Candidate(Ability.Coordinating, 3, "迎えの時間をずらしてもらいました"),
    ];

    public static async Task<EpisodeItem> Saved(RevalueFactory factory, string user, string id) =>
        (await factory.Services.GetRequiredService<IDataStore>().GetAsync<EpisodeItem>(TestUsers.Key(user), id, Ct))!;

    /// <summary>
    /// 話し終えた場面を作る。<paramref name="candidates"/> を読み取りに返させて <see cref="CoordinatingAnswer"/> を送り、区切る。
    /// </summary>
    public static async Task<string> FinishedEpisode(HttpClient client, FakeConversationAi ai, params EvidenceCandidate[] candidates)
    {
        var id = await Start(client);
        ai.Reading = _ => ReadingWith(candidates);
        await Send(client, id, CoordinatingAnswer);
        await Finish(client, id);
        return id;
    }

    /// <summary>
    /// 保存した中身のうち、場面、話している途中の印、力の状態の本だけ（生の JSON）。
    /// 送信回数は断った要求でも数えるので（上限のフィルターが先に数える）、「何も保存しない」の比べ方から外す。
    /// </summary>
    public static async Task<List<string>> StoredContent(IDataStore store)
    {
        string[] types = ["\"type\":\"episode\"", "\"type\":\"talkingMark\"", "\"type\":\"abilityBook\""];
        var kept = new List<string>();
        await foreach (var json in store.DumpRawJsonAsync(Ct))
        {
            if (types.Any(t => json.Contains(t, StringComparison.Ordinal)))
            {
                kept.Add(json);
            }
        }

        return kept;
    }

    public static JsonElement[] Array(JsonElement element, string property) =>
        element.GetProperty(property).EnumerateArray().ToArray();
}
