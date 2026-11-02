using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Ai;
using Revalue.Server.Data;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

public sealed class AbilitiesApiTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static (RevalueFactory Factory, FakeConversationAi Ai) Create()
    {
        var ai = new FakeConversationAi();
        var factory = new RevalueFactory().WithTestServices(services => services.AddSingleton<IConversationAi>(ai));
        return (factory, ai);
    }

    private static async Task<HttpClient> Consenting(RevalueFactory factory, string id)
    {
        var client = factory.CreateUserClient(id);
        var consent = await client.PostAsJsonAsync("/api/consent", new { version = "2026-11-02" }, Ct);
        Assert.Equal(HttpStatusCode.NoContent, consent.StatusCode);
        return client;
    }

    private static async Task<string> Start(HttpClient client)
    {
        var response = await client.PostAsync("/api/episodes", null, Ct);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("id").GetString()!;
    }

    private static async Task Send(HttpClient client, string id, string text, string kind = "free")
    {
        var response = await client.PostAsJsonAsync($"/api/episodes/{id}/messages", new { text, kind }, Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync(Ct);
        Assert.Contains("event: done", body);
    }

    private static async Task<JsonElement> Abilities(HttpClient client)
    {
        var response = await client.GetAsync("/api/abilities", Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
    }

    private static JsonElement Ability(JsonElement dto, string key) =>
        dto.GetProperty("abilities").EnumerateArray().Single(a => a.GetProperty("key").GetString() == key);

    private static TurnReading ReadingWith(params EvidenceCandidate[] candidates) =>
        new(new HashSet<AnswerSignal> { AnswerSignal.ConcreteEvent }, candidates);

    private static EvidenceCandidate Candidate(Ability ability, int action, string quote, int answer = 1) =>
        new(ability, action, quote, answer, 1, false, "", 0);

    private const string CoordinatingAnswer = "夫と母の予定がぶつかっていたので、二人に電話して、迎えの時間をずらしてもらいました。";

    private static readonly EvidenceCandidate[] CoordinatingAll =
    [
        Candidate(Features.Validate.Ability.Coordinating, 1, "夫と母の予定がぶつかって"),
        Candidate(Features.Validate.Ability.Coordinating, 2, "二人に電話して"),
        Candidate(Features.Validate.Ability.Coordinating, 3, "迎えの時間をずらしてもらいました"),
    ];

    [Fact(DisplayName = "validate-9（生活での根拠と仕事での発揮を分ける）: 生活の中の状態と根拠を返し、仕事はいつも notChecked")]
    public async Task LifeAndWorkAreSeparate()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.Reading = _ => ReadingWith([.. CoordinatingAll, Candidate(Features.Validate.Ability.Prioritizing, 2, "迎えの時間")]);

        await Send(client, id, CoordinatingAnswer);
        var dto = await Abilities(client);

        Assert.Equal(["noticing", "coordinating", "prioritizing"],
            dto.GetProperty("abilities").EnumerateArray().Select(a => a.GetProperty("key").GetString()));
        var coordinating = Ability(dto, "coordinating");
        Assert.Equal("調整する力", coordinating.GetProperty("name").GetString());
        Assert.Equal("confirmed", coordinating.GetProperty("life").GetString());
        Assert.Equal("notChecked", coordinating.GetProperty("work").GetString());
        Assert.Equal(id, coordinating.GetProperty("episodeId").GetString());
        Assert.Equal(3, coordinating.GetProperty("quotes").GetArrayLength());
        Assert.Equal(0, coordinating.GetProperty("hints").GetArrayLength());
        Assert.False(coordinating.GetProperty("excluded").GetBoolean());

        var prioritizing = Ability(dto, "prioritizing");
        Assert.Equal("needsCheck", prioritizing.GetProperty("life").GetString());
        Assert.Equal("notChecked", prioritizing.GetProperty("work").GetString());
        Assert.Equal(2, prioritizing.GetProperty("hints").GetArrayLength());

        var noticing = Ability(dto, "noticing");
        Assert.Equal("notYet", noticing.GetProperty("life").GetString());
        Assert.Equal("notChecked", noticing.GetProperty("work").GetString());
        Assert.Equal(JsonValueKind.Null, noticing.GetProperty("episodeId").ValueKind);

        // 履歴は新しい順。どれも話した内容から（talk）
        var history = dto.GetProperty("history").EnumerateArray().ToList();
        Assert.Equal(2, history.Count);
        Assert.All(history, h => Assert.Equal("talk", h.GetProperty("reason").GetString()));
        Assert.All(history, h => Assert.Equal(id, h.GetProperty("episodeId").GetString()));
        Assert.Equal("調整する力", history.Single(h => h.GetProperty("key").GetString() == "coordinating").GetProperty("name").GetString());
    }

    [Fact(DisplayName = "validate-4（根拠は本人の言葉）: 返す引用は、場面の本人の答えに一字一句含まれる")]
    public async Task QuotesAreVerbatim()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.Reading = _ => ReadingWith([.. CoordinatingAll, Candidate(Features.Validate.Ability.Noticing, 1, "夫と母の予定がぶつかった")]);

        await Send(client, id, CoordinatingAnswer);
        var dto = await Abilities(client);

        var quotes = dto.GetProperty("abilities").EnumerateArray()
            .SelectMany(a => a.GetProperty("quotes").EnumerateArray())
            .ToList();
        Assert.Equal(3, quotes.Count);
        Assert.All(quotes, q =>
        {
            Assert.Contains(q.GetProperty("text").GetString()!, CoordinatingAnswer, StringComparison.Ordinal);
            Assert.False(q.GetProperty("fromChoice").GetBoolean());
        });
        Assert.Equal("notYet", Ability(dto, "noticing").GetProperty("life").GetString());
    }

    [Fact(DisplayName = "validate-12（本人が見立てを外せる）: 外すと excluded になり履歴に exclude、戻すと restore")]
    public async Task ExcludeAndRestore()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.Reading = _ => ReadingWith(CoordinatingAll);
        await Send(client, id, CoordinatingAnswer);

        var excluded = await client.PostAsync("/api/abilities/coordinating/exclude", null, Ct);
        Assert.Equal(HttpStatusCode.OK, excluded.StatusCode);
        var dto = await excluded.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Assert.True(Ability(dto, "coordinating").GetProperty("excluded").GetBoolean());
        Assert.Equal("confirmed", Ability(dto, "coordinating").GetProperty("life").GetString());
        var latest = dto.GetProperty("history")[0];
        Assert.Equal("exclude", latest.GetProperty("reason").GetString());
        Assert.Equal("coordinating", latest.GetProperty("key").GetString());
        Assert.Equal("confirmed", latest.GetProperty("from").GetString());
        Assert.Equal("confirmed", latest.GetProperty("to").GetString());
        Assert.True(Ability(await Abilities(client), "coordinating").GetProperty("excluded").GetBoolean());

        var restored = await client.PostAsync("/api/abilities/coordinating/restore", null, Ct);
        Assert.Equal(HttpStatusCode.OK, restored.StatusCode);
        dto = await restored.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Assert.False(Ability(dto, "coordinating").GetProperty("excluded").GetBoolean());
        Assert.Equal("restore", dto.GetProperty("history")[0].GetProperty("reason").GetString());
        Assert.Equal("exclude", dto.GetProperty("history")[1].GetProperty("reason").GetString());
    }

    [Theory(DisplayName = "validate-12（本人が見立てを外せる）: 知らない力の名前は 404")]
    [InlineData("/api/abilities/listening/exclude")]
    [InlineData("/api/abilities/Noticing/exclude")]
    [InlineData("/api/abilities/0/restore")]
    public async Task UnknownAbilityIs404(string path)
    {
        var (factory, _) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");

        var response = await client.PostAsync(path, null, Ct);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Null(await factory.Services.GetRequiredService<IDataStore>()
            .GetAsync<AbilityBookItem>(TestUsers.Key("g-1"), AbilityBookItem.ItemId, Ct));
    }

    [Fact(DisplayName = "validate-9（生活での根拠と仕事での発揮を分ける）: ほかの人の見えた力は見えない")]
    public async Task OtherUsersBookIsNotVisible()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var first = await Consenting(factory, "g-1");
        var second = await Consenting(factory, "g-2");
        var id = await Start(first);
        ai.Reading = _ => ReadingWith(CoordinatingAll);
        await Send(first, id, CoordinatingAnswer);
        await first.PostAsync("/api/abilities/noticing/exclude", null, Ct);

        var dto = await Abilities(second);

        Assert.All(dto.GetProperty("abilities").EnumerateArray(), a =>
        {
            Assert.Equal("notYet", a.GetProperty("life").GetString());
            Assert.Equal(0, a.GetProperty("quotes").GetArrayLength());
            Assert.False(a.GetProperty("excluded").GetBoolean());
        });
        Assert.Equal(0, dto.GetProperty("history").GetArrayLength());
    }

    [Theory(DisplayName = "foundation-2（始める前に保存するものを示す）: 了解していない人は見えた力の API を使えない")]
    [InlineData("GET", "/api/abilities")]
    [InlineData("POST", "/api/abilities/noticing/exclude")]
    [InlineData("POST", "/api/abilities/noticing/restore")]
    public async Task ConsentIsRequired(string method, string path)
    {
        var (factory, _) = Create();
        await using var _f = factory;
        var client = factory.CreateUserClient("g-1");

        var response = await client.SendAsync(new HttpRequestMessage(new HttpMethod(method), path), Ct);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal(0, await factory.Services.GetRequiredService<IDataStore>().CountAllAsync(TestUsers.Key("g-1"), Ct));
    }

    [Fact(DisplayName = "validate-8（訂正したら確かめ直す）: 飛ばした場面の根拠は見えた力から消え、履歴に skip が残る")]
    public async Task SkippedEpisodeEvidenceIsRemoved()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.Reading = _ => ReadingWith(CoordinatingAll[0], CoordinatingAll[1]);
        await Send(client, id, CoordinatingAnswer);
        Assert.Equal("needsCheck", Ability(await Abilities(client), "coordinating").GetProperty("life").GetString());

        var skipped = await client.PostAsync($"/api/episodes/{id}/skip", null, Ct);
        Assert.Equal(HttpStatusCode.Created, skipped.StatusCode);

        var dto = await Abilities(client);
        var coordinating = Ability(dto, "coordinating");
        Assert.Equal("notYet", coordinating.GetProperty("life").GetString());
        Assert.Equal(0, coordinating.GetProperty("quotes").GetArrayLength());
        var latest = dto.GetProperty("history")[0];
        Assert.Equal("skip", latest.GetProperty("reason").GetString());
        Assert.Equal("needsCheck", latest.GetProperty("from").GetString());
        Assert.Equal("notYet", latest.GetProperty("to").GetString());
        Assert.Equal(id, latest.GetProperty("episodeId").GetString());
    }

    [Fact(DisplayName = "discover-5（つらい話は飛ばせる）: つらい状態のサインが出た場面を残さずに飛ばすと、確かめに使わないことにした履歴も残さない")]
    public async Task SkipAfterDistressLeavesNoSetAside()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var store = factory.Services.GetRequiredService<IDataStore>();
        var id = await Start(client);
        ai.Reading = _ => ReadingWith(CoordinatingAll);
        await Send(client, id, CoordinatingAnswer);
        ai.Reading = _ => new TurnReading(new HashSet<AnswerSignal> { AnswerSignal.Distress }, []);
        await Send(client, id, "もう消えたいと思うことがあります");
        Assert.Contains(
            (await Abilities(client)).GetProperty("history").EnumerateArray(),
            h => h.GetProperty("reason").GetString() == "setAside");

        var skipped = await client.PostAsync($"/api/episodes/{id}/skip", null, Ct);

        Assert.Equal(HttpStatusCode.Created, skipped.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/episodes/{id}", Ct)).StatusCode);
        var dto = await Abilities(client);
        Assert.Equal("notYet", Ability(dto, "coordinating").GetProperty("life").GetString());

        // サインの出た時を、消した場面のあとに残さない。保存した生の中身にも残さない
        var history = dto.GetProperty("history").EnumerateArray().ToList();
        Assert.DoesNotContain(history, h => h.GetProperty("reason").GetString() == "setAside");
        var book = Assert.Single(await ValidateTestKit.StoredContent(store), j => j.Contains("\"type\":\"abilityBook\"", StringComparison.Ordinal));
        Assert.DoesNotContain("setAside", book, StringComparison.Ordinal);

        // 状態の移り変わりは、場面を残さずに別の話にしたとして残す（履歴の前と後がつながる）
        Assert.Equal(
            [("skip", "confirmed", "notYet"), ("talk", "notYet", "confirmed")],
            history.Select(h => (h.GetProperty("reason").GetString(), h.GetProperty("from").GetString(), h.GetProperty("to").GetString())));
        Assert.All(history, h => Assert.Equal("coordinating", h.GetProperty("key").GetString()));
    }

    [Fact(DisplayName = "discover-5（つらい話は飛ばせる）: 飛ばして消した場面の確かめに使わない履歴を外しても、ほかの場面の履歴とその後の外す・戻すは残す")]
    public async Task SkipAfterDistressKeepsOtherHistory()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var finished = await ValidateTestKit.FinishedEpisode(client, ai, Candidate(Features.Validate.Ability.Noticing, 1, "夫と母の予定がぶつかって"));
        var id = await Start(client);
        ai.Reading = _ => ReadingWith(CoordinatingAll);
        await Send(client, id, CoordinatingAnswer);
        ai.Reading = _ => new TurnReading(new HashSet<AnswerSignal> { AnswerSignal.Distress }, []);
        await Send(client, id, "もう消えたいと思うことがあります");
        await client.PostAsync("/api/abilities/coordinating/exclude", null, Ct);

        Assert.Equal(HttpStatusCode.Created, (await client.PostAsync($"/api/episodes/{id}/skip", null, Ct)).StatusCode);

        var history = (await Abilities(client)).GetProperty("history").EnumerateArray()
            .Select(h => (h.GetProperty("key").GetString(), h.GetProperty("reason").GetString(), h.GetProperty("from").GetString(),
                h.GetProperty("to").GetString(), h.GetProperty("episodeId").GetString()))
            .ToList();
        // サインのあとに外した行も、サインで下がった状態を読み取れないよう、外した行がなかったときの状態に書き直す
        Assert.Equal(
            [
                ("coordinating", "skip", "confirmed", "notYet", id),
                ("coordinating", "exclude", "confirmed", "confirmed", null),
                ("coordinating", "talk", "notYet", "confirmed", id),
                ("noticing", "talk", "notYet", "needsCheck", finished),
            ],
            history);
    }

    [Fact(DisplayName = "common-2（ログに中身を書かない）: 見えた力の API はログに引用を書かない")]
    public async Task LogsHaveNoQuotes()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.Reading = _ => ReadingWith(CoordinatingAll);
        await Send(client, id, CoordinatingAnswer);
        await Abilities(client);
        await client.PostAsync("/api/abilities/coordinating/exclude", null, Ct);

        Assert.DoesNotContain(factory.CapturedLogs, l => l.Contains("二人に電話", StringComparison.Ordinal));
    }
}
