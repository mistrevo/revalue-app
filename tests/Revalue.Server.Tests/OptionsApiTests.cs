using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Ai;
using Revalue.Server.Data;
using Revalue.Server.Features.Foundation.Limits;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Validate;
using static Revalue.Server.Tests.ValidateTestKit;

namespace Revalue.Server.Tests;

/// <summary>テストで差し替える偽物の仕事の選択肢の AI。既定は <see cref="ScriptedOptionsAi"/> の答えで、答えを変えたり失敗させたりできる。</summary>
public sealed class FakeOptionsAi : IOptionsAi
{
    private int _calls;

    /// <summary>偽物の答えを変える。引数は <see cref="ScriptedOptionsAi"/> の答え。</summary>
    public Func<OptionsDraft, OptionsDraft> Change { get; set; } = d => d;

    /// <summary>投げる例外の種類（refusal か failure）。null なら答える。</summary>
    public string? Fail { get; set; }

    public int Calls => _calls;

    public async Task<OptionsDraft> DraftAsync(OptionsInputs inputs, OptionCandidates candidates, CancellationToken ct)
    {
        Interlocked.Increment(ref _calls);
        if (Fail is { } kind)
        {
            throw new ConversationAiException(kind);
        }

        return Change(await new ScriptedOptionsAi().DraftAsync(inputs, candidates, ct));
    }
}

public sealed class OptionsApiTests
{
    private static readonly object TenHours = Conditions(10, ["daytime", "evening"]);

    private static object Conditions(int hours, string[] slots, string place = "homeOnly", int? income = 5) =>
        new { timeSlots = slots, hoursPerWeek = hours, place, monthlyIncome = income };

    private static (RevalueFactory Factory, FakeConversationAi Ai, FakeOptionsAi Options) Setup()
    {
        var ai = new FakeConversationAi();
        var options = new FakeOptionsAi();
        var factory = new RevalueFactory().WithTestServices(services =>
        {
            services.AddSingleton<IConversationAi>(ai);
            services.AddSingleton<IOptionsAi>(options);
        });
        return (factory, ai, options);
    }

    /// <summary>話し終えた場面（調整する力が根拠あり）と条件のある人。</summary>
    private static async Task<HttpClient> Ready(RevalueFactory factory, FakeConversationAi ai, string user, EvidenceCandidate[]? candidates = null, object? conditions = null)
    {
        var client = await Consenting(factory, user);
        await FinishedEpisode(client, ai, candidates ?? CoordinatingAll);
        await PutConditions(client, conditions ?? TenHours);
        return client;
    }

    private static async Task PutConditions(HttpClient client, object conditions)
    {
        var response = await client.PutAsJsonAsync("/api/profile/conditions", conditions, Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    private static async Task<JsonElement> Get(HttpClient client)
    {
        var response = await client.GetAsync("/api/options", Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await Json(response);
    }

    private static async Task<JsonElement> Generate(HttpClient client)
    {
        var response = await client.PostAsync("/api/options", null, Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await Json(response);
    }

    private static Task<HttpResponseMessage> PutChoice(HttpClient client, object body) =>
        client.PutAsJsonAsync("/api/options/choice", body, Ct);

    private static async Task<JsonElement> ChooseCard(HttpClient client, string card, JsonElement dto)
    {
        var response = await PutChoice(client, new { kind = "card", card, generatedAt = dto.GetProperty("cards").GetProperty("generatedAt").GetString() });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await Json(response);
    }

    private static async Task<JsonElement> AddOwn(HttpClient client, string title, string? note = null)
    {
        var response = await client.PostAsJsonAsync("/api/options/own", new { title, note }, Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await Json(response);
    }

    private static async Task AssertProblem(HttpResponseMessage response, HttpStatusCode status, string type)
    {
        Assert.Equal(status, response.StatusCode);
        Assert.Equal(type, (await Json(response)).GetProperty("type").GetString());
    }

    private static List<(string Kind, string Reason)> Missing(JsonElement dto) =>
        Array(dto.GetProperty("cards"), "missing").Select(m => (m.GetProperty("kind").GetString()!, m.GetProperty("reason").GetString()!)).ToList();

    private static async Task<long> Sends(RevalueFactory factory, string user) =>
        (await factory.Services.GetRequiredService<IDataStore>().GetAsync<DailyCountItem>(TestUsers.Key(user), DailyLimitFilter.UsageId, Ct))?.Count ?? 0;

    private static async Task<long> ChoseOption(HttpClient client)
    {
        var response = await client.GetAsync("/api/stats", Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await Json(response)).GetProperty("choseOption").GetInt64();
    }

    [Fact(DisplayName = "options-7（1 場面で進める）: 進める条件がそろわないと、足りないものを返し、作れない")]
    public async Task NotReadyReturnsWhatIsMissing()
    {
        var (factory, ai, options) = Setup();
        var client = await Consenting(factory, "o-1");

        var dto = await Get(client);
        Assert.Equal("needsConditions", dto.GetProperty("readiness").GetString());
        Assert.Equal(JsonValueKind.Null, dto.GetProperty("cards").ValueKind);
        var refused = await client.PostAsync("/api/options", null, Ct);
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        var problem = await Json(refused);
        Assert.Equal("/problems/options-not-ready", problem.GetProperty("type").GetString());
        Assert.Equal("needsConditions", problem.GetProperty("readiness").GetString());

        await PutConditions(client, TenHours);
        Assert.Equal("needsFinishedEpisode", (await Get(client)).GetProperty("readiness").GetString());

        // 話し終えたが、使える力がない（読み取りが根拠の候補を返さない）
        await FinishedEpisode(client, ai);
        Assert.Equal("needsAbility", (await Get(client)).GetProperty("readiness").GetString());
        var stillRefused = await client.PostAsync("/api/options", null, Ct);
        Assert.Equal("needsAbility", (await Json(stillRefused)).GetProperty("readiness").GetString());

        Assert.Equal(0, options.Calls);
    }

    [Fact(DisplayName = "options-7（1 場面で進める）: 確かめ中の力しかなくても作れ、確かめ中と返す")]
    public async Task NeedsCheckAbilityIsEnough()
    {
        var (factory, ai, _) = Setup();
        // e11 のように、調整する力の核となる行動が 2 つだけそろった場面
        var client = await Ready(factory, ai, "o-2", CoordinatingAll[..2]);

        Assert.Equal("ready", (await Get(client)).GetProperty("readiness").GetString());
        var dto = await Generate(client);

        var ability = dto.GetProperty("cards").GetProperty("choose").GetProperty("ability");
        Assert.Equal("coordinating", ability.GetProperty("key").GetString());
        Assert.Equal(AbilityText.Name(Ability.Coordinating), ability.GetProperty("name").GetString());
        Assert.Equal("needsCheck", ability.GetProperty("state").GetString());
        Assert.Equal(["夫と母の予定がぶつかって", "二人に電話して"], Array(ability, "quotes").Select(q => q.GetProperty("text").GetString()));
    }

    [Fact(DisplayName = "options-1（3 枚を同じ重さで示す）: 3 枚のカードを決まった形で返し、作れないカードは理由つきで missing に入る")]
    public async Task CardsAndMissing()
    {
        var (factory, ai, options) = Setup();
        var client = await Ready(factory, ai, "o-3");

        var all = await Generate(client);
        var cards = all.GetProperty("cards");
        Assert.False(cards.GetProperty("stale").GetBoolean());
        Assert.Empty(Missing(all));
        var choose = cards.GetProperty("choose");
        Assert.Equal("オンライン秘書", choose.GetProperty("occupationName").GetString());
        var task = Assert.Single(Array(choose, "tasks"));
        Assert.Equal("online-secretary-schedule", task.GetProperty("id").GetString());
        Assert.Equal(["daytime", "evening"], Array(task, "timeSlots").Select(s => s.GetString()));
        Assert.Equal("home", task.GetProperty("place").GetString());
        Assert.Equal("coordinating", task.GetProperty("ability").GetString());
        var range = choose.GetProperty("range");
        Assert.Equal((3, 10), (range.GetProperty("minHours").GetInt32(), range.GetProperty("maxHours").GetInt32()));
        Assert.Equal(2, Array(cards.GetProperty("combine"), "tasks").Length);
        Assert.Equal("home", cards.GetProperty("create").GetProperty("place").GetString());
        Assert.Equal(5, all.GetProperty("monthlyIncome").GetInt32());
        Assert.Contains("job tag", all.GetProperty("source").GetProperty("text").GetString() + all.GetProperty("source").GetProperty("url").GetString());

        options.Change = d => d with { Combine = d.Combine with { Made = false } };
        var dto = await Generate(client);

        Assert.Equal(JsonValueKind.Null, dto.GetProperty("cards").GetProperty("combine").ValueKind);
        Assert.Equal([("combine", "noFit")], Missing(dto));
    }

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: AI が登録にない ID を返したら、そのカードは出ない")]
    public async Task UnknownIdHidesCard()
    {
        var (factory, ai, options) = Setup();
        var client = await Ready(factory, ai, "o-4");
        options.Change = d => d with { Choose = d.Choose with { OccupationId = "no-such-occupation" } };

        var dto = await Generate(client);

        Assert.Equal(JsonValueKind.Null, dto.GetProperty("cards").GetProperty("choose").ValueKind);
        Assert.Equal([("choose", "rejected")], Missing(dto));
        Assert.NotEqual(JsonValueKind.Null, dto.GetProperty("cards").GetProperty("combine").ValueKind);
    }

    [Fact(DisplayName = "options-6（本人が選ぶ、保留する、自分で書く）: カードを選び、作り直しても選んだ案はそのまま残る")]
    public async Task ChoiceSurvivesRegeneration()
    {
        var (factory, ai, options) = Setup();
        var client = await Ready(factory, ai, "o-5");
        var first = await Generate(client);
        var firstReason = first.GetProperty("cards").GetProperty("choose").GetProperty("reason").GetString();

        var chosen = await ChooseCard(client, "choose", first);
        var choice = chosen.GetProperty("choice");
        Assert.Equal("card", choice.GetProperty("kind").GetString());
        Assert.Equal("choose", choice.GetProperty("card").GetProperty("kind").GetString());
        Assert.Equal(firstReason, choice.GetProperty("card").GetProperty("choose").GetProperty("reason").GetString());
        Assert.Equal(JsonValueKind.Null, choice.GetProperty("ownJob").ValueKind);

        await AddOwn(client, "架空-近所の子どもの見守り");
        factory.Clock.Advance(TimeSpan.FromMinutes(1));
        options.Change = d => d with { Choose = d.Choose with { Reason = "作り直した理由です。" } };
        var regenerated = await Generate(client);

        Assert.Equal("作り直した理由です。", regenerated.GetProperty("cards").GetProperty("choose").GetProperty("reason").GetString());
        Assert.Equal(firstReason, regenerated.GetProperty("choice").GetProperty("card").GetProperty("choose").GetProperty("reason").GetString());
        Assert.Equal("架空-近所の子どもの見守り", Assert.Single(Array(regenerated, "ownJobs")).GetProperty("title").GetString());
    }

    [Fact(DisplayName = "options-6（本人が選ぶ、保留する、自分で書く）: 保留、書いた仕事を選ぶ、選び直す、書いた仕事を消すと選んだ案も外れる")]
    public async Task HoldOwnAndRechoose()
    {
        var (factory, ai, _) = Setup();
        var client = await Ready(factory, ai, "o-6");
        var generated = await Generate(client);

        var held = await Json(await PutChoice(client, new { kind = "hold" }));
        Assert.Equal("hold", held.GetProperty("choice").GetProperty("kind").GetString());

        var withOwn = await AddOwn(client, "架空-手作りの小物の販売", "架空のメモ");
        var own = Assert.Single(Array(withOwn, "ownJobs"));
        Assert.Equal("架空のメモ", own.GetProperty("note").GetString());
        var ownId = own.GetProperty("id").GetString();
        var ownChosen = await Json(await PutChoice(client, new { kind = "own", ownJobId = ownId }));
        Assert.Equal("own", ownChosen.GetProperty("choice").GetProperty("kind").GetString());
        Assert.Equal("架空-手作りの小物の販売", ownChosen.GetProperty("choice").GetProperty("ownJob").GetProperty("title").GetString());

        var rechosen = await ChooseCard(client, "create", generated);
        Assert.Equal("create", rechosen.GetProperty("choice").GetProperty("card").GetProperty("kind").GetString());

        await PutChoice(client, new { kind = "own", ownJobId = ownId });
        var deleted = await client.DeleteAsync($"/api/options/own/{ownId}", Ct);
        Assert.Equal(HttpStatusCode.OK, deleted.StatusCode);
        var afterDelete = await Json(deleted);
        Assert.Empty(Array(afterDelete, "ownJobs"));
        Assert.Equal(JsonValueKind.Null, afterDelete.GetProperty("choice").ValueKind);

        await ChooseCard(client, "combine", generated);
        var cleared = await client.DeleteAsync("/api/options/choice", Ct);
        Assert.Equal(HttpStatusCode.OK, cleared.StatusCode);
        Assert.Equal(JsonValueKind.Null, (await Json(cleared)).GetProperty("choice").ValueKind);

        // 形の合わない選び方と、知らない書いた仕事
        await AssertProblem(await PutChoice(client, new { kind = "pick" }), HttpStatusCode.BadRequest, "/problems/invalid-option");
        await AssertProblem(await PutChoice(client, new { kind = "card", card = "best" }), HttpStatusCode.BadRequest, "/problems/invalid-option");
        await AssertProblem(await PutChoice(client, new { kind = "card", card = "choose" }), HttpStatusCode.BadRequest, "/problems/invalid-option");
        await AssertProblem(await PutChoice(client, new { kind = "own" }), HttpStatusCode.BadRequest, "/problems/invalid-option");
        await AssertProblem(await PutChoice(client, new { kind = "own", ownJobId = "no-such" }), HttpStatusCode.NotFound, "/problems/not-found");
        await AssertProblem(
            await client.PutAsync("/api/options/choice", new StringContent("{\"kind\":", Encoding.UTF8, "application/json"), Ct),
            HttpStatusCode.BadRequest,
            "/problems/invalid-option");
    }

    [Fact(DisplayName = "options-6（本人が選ぶ、保留する、自分で書く）: 書いた仕事は 3 つまで、見える文字のない名前と長すぎる言葉は断る")]
    public async Task OwnJobLimits()
    {
        var (factory, _, _) = Setup();
        var client = await Consenting(factory, "o-7");

        async Task Rejected(HttpResponseMessage response) => await AssertProblem(response, HttpStatusCode.BadRequest, "/problems/invalid-option");

        await Rejected(await client.PostAsJsonAsync("/api/options/own", new { title = " ​ " }, Ct));
        await Rejected(await client.PostAsJsonAsync("/api/options/own", new { title = new string('あ', 101) }, Ct));
        await Rejected(await client.PostAsJsonAsync("/api/options/own", new { title = "a" + new string('́', 400) }, Ct));
        await Rejected(await client.PostAsJsonAsync("/api/options/own", new { title = "架空の仕事", note = new string('あ', 501) }, Ct));
        await Rejected(await client.PostAsJsonAsync("/api/options/own", new { note = "名前がない" }, Ct));

        // 名前は前後の空白を落とし、見える文字のないメモは書いていないことにする
        var first = await AddOwn(client, "  架空の仕事 1  ", " ​ ");
        var job = Assert.Single(Array(first, "ownJobs"));
        Assert.Equal("架空の仕事 1", job.GetProperty("title").GetString());
        Assert.Equal(JsonValueKind.Null, job.GetProperty("note").ValueKind);
        await AddOwn(client, new string('あ', 100), new string('い', 500));
        await AddOwn(client, "架空の仕事 3");
        await Rejected(await client.PostAsJsonAsync("/api/options/own", new { title = "架空の仕事 4" }, Ct));

        var id = job.GetProperty("id").GetString();
        var edited = await client.PutAsJsonAsync($"/api/options/own/{id}", new { title = "直した仕事", note = "直したメモ" }, Ct);
        Assert.Equal(HttpStatusCode.OK, edited.StatusCode);
        var editedJob = Array(await Json(edited), "ownJobs").Single(j => j.GetProperty("id").GetString() == id);
        Assert.Equal(("直した仕事", "直したメモ"), (editedJob.GetProperty("title").GetString(), editedJob.GetProperty("note").GetString()));
        await Rejected(await client.PutAsJsonAsync($"/api/options/own/{id}", new { title = "" }, Ct));

        await AssertProblem(await client.PutAsJsonAsync("/api/options/own/no-such", new { title = "x" }, Ct), HttpStatusCode.NotFound, "/problems/not-found");
        await AssertProblem(await client.DeleteAsync("/api/options/own/no-such", Ct), HttpStatusCode.NotFound, "/problems/not-found");
    }

    [Fact(DisplayName = "options-6（本人が選ぶ、保留する、自分で書く）: 作り直したあとに古いカードを選ぶと 409 で、選んだ案は変わらない")]
    public async Task ChoosingStaleCardIs409()
    {
        var (factory, ai, options) = Setup();
        var client = await Ready(factory, ai, "o-8");
        var old = await Generate(client);
        await ChooseCard(client, "choose", old);

        factory.Clock.Advance(TimeSpan.FromMinutes(1));
        options.Change = d => d with { Choose = d.Choose with { Reason = "別の画面で作り直した理由です。" } };
        await Generate(client);

        var stale = await PutChoice(client, new { kind = "card", card = "combine", generatedAt = old.GetProperty("cards").GetProperty("generatedAt").GetString() });
        await AssertProblem(stale, HttpStatusCode.Conflict, "/problems/options-changed");

        var choice = (await Get(client)).GetProperty("choice");
        Assert.Equal("choose", choice.GetProperty("card").GetProperty("kind").GetString());
        Assert.Equal(
            old.GetProperty("cards").GetProperty("choose").GetProperty("reason").GetString(),
            choice.GetProperty("card").GetProperty("choose").GetProperty("reason").GetString());
    }

    [Fact(DisplayName = "options-6（本人が選ぶ、保留する、自分で書く）: カードがないか、いま見せられないカードを選ぶと 409")]
    public async Task ChoosingMissingCardIs409()
    {
        var (factory, ai, options) = Setup();
        var client = await Ready(factory, ai, "o-9");
        await AssertProblem(
            await PutChoice(client, new { kind = "card", card = "choose", generatedAt = "2026-11-02T03:00:00+00:00" }),
            HttpStatusCode.Conflict,
            "/problems/options-changed");

        options.Change = d => d with { Combine = d.Combine with { Made = false } };
        var generated = await Generate(client);
        var generatedAt = generated.GetProperty("cards").GetProperty("generatedAt").GetString();
        await AssertProblem(await PutChoice(client, new { kind = "card", card = "combine", generatedAt }), HttpStatusCode.Conflict, "/problems/options-changed");

        // 条件を狭めて、創るが収まらなくなった
        await PutConditions(client, Conditions(3, ["daytime"]));
        await AssertProblem(await PutChoice(client, new { kind = "card", card = "create", generatedAt }), HttpStatusCode.Conflict, "/problems/options-changed");
        Assert.Equal(JsonValueKind.Null, (await Get(client)).GetProperty("choice").ValueKind);
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: カードの力を外すと、作り直すまでそのカードを出さない")]
    public async Task ExcludedAbilityHidesCardUntilRegenerated()
    {
        var (factory, ai, _) = Setup();
        var client = await Ready(factory, ai, "o-10");
        await Generate(client);

        var excluded = await client.PostAsync("/api/abilities/coordinating/exclude", null, Ct);
        Assert.Equal(HttpStatusCode.OK, excluded.StatusCode);
        var dto = await Get(client);

        var cards = dto.GetProperty("cards");
        Assert.True(cards.GetProperty("stale").GetBoolean());
        foreach (var kind in new[] { "choose", "combine", "create" })
        {
            Assert.Equal(JsonValueKind.Null, cards.GetProperty(kind).ValueKind);
        }

        Assert.Equal([("choose", "excluded"), ("combine", "excluded"), ("create", "excluded")], Missing(dto));
        Assert.Equal("needsAbility", dto.GetProperty("readiness").GetString());
    }

    [Fact(DisplayName = "options-5（条件の範囲だけ）: 条件を狭めると、収まらなくなったカードは出さない")]
    public async Task NarrowedConditionsHideCardsOutOfRange()
    {
        var (factory, ai, _) = Setup();
        var client = await Ready(factory, ai, "o-11");
        await Generate(client);

        // 週 10 時間 → 3 時間: 選ぶ（3 時間から）は収まり、組み合わせる（3 + 2 時間から）と創る（10 時間）は収まらない
        await PutConditions(client, Conditions(3, ["daytime", "evening"]));
        var narrowed = await Get(client);
        var cards = narrowed.GetProperty("cards");
        Assert.True(cards.GetProperty("stale").GetBoolean());
        var range = cards.GetProperty("choose").GetProperty("range");
        Assert.Equal((3, 3), (range.GetProperty("minHours").GetInt32(), range.GetProperty("maxHours").GetInt32()));
        Assert.Equal([("combine", "noFit"), ("create", "noFit")], Missing(narrowed));

        // 夜だけ、週 1 時間: 選ぶも収まらない
        await PutConditions(client, Conditions(1, ["night"]));
        var tighter = await Get(client);
        Assert.Equal([("choose", "noFit"), ("combine", "noFit"), ("create", "noFit")], Missing(tighter));
    }

    [Fact(DisplayName = "options-6（本人が選ぶ、保留する、自分で書く）: AI が失敗したら 503 で、前のカードと選んだ案は残る")]
    public async Task AiFailureKeepsCardsAndChoice()
    {
        var (factory, ai, options) = Setup();
        var client = await Ready(factory, ai, "o-12");
        var generated = await Generate(client);
        await ChooseCard(client, "choose", generated);
        var before = await Get(client);

        factory.Clock.Advance(TimeSpan.FromMinutes(1));
        foreach (var kind in new[] { ConversationAiException.Failure, ConversationAiException.Refusal })
        {
            options.Fail = kind;
            var failed = await client.PostAsync("/api/options", null, Ct);
            Assert.Equal(HttpStatusCode.ServiceUnavailable, failed.StatusCode);
            var problem = await Json(failed);
            Assert.Equal("/problems/ai-unavailable", problem.GetProperty("type").GetString());
            Assert.Equal(kind, problem.GetProperty("kind").GetString());
        }

        Assert.Equal(before.GetRawText(), (await Get(client)).GetRawText());
    }

    [Fact(DisplayName = "options-7（1 場面で進める）: 作るときだけ 1 日の送信回数を 1 回数える")]
    public async Task OnlyGenerationCountsTowardsDailyLimit()
    {
        var (factory, ai, _) = Setup();
        var client = await Ready(factory, ai, "o-13");
        var before = await Sends(factory, "o-13");

        var generated = await Generate(client);
        Assert.Equal(before + 1, await Sends(factory, "o-13"));

        await Get(client);
        await ChooseCard(client, "choose", generated);
        await PutChoice(client, new { kind = "hold" });
        await client.DeleteAsync("/api/options/choice", Ct);
        var own = Array(await AddOwn(client, "架空の仕事"), "ownJobs")[0].GetProperty("id").GetString();
        await client.PutAsJsonAsync($"/api/options/own/{own}", new { title = "架空の仕事 2" }, Ct);
        await client.DeleteAsync($"/api/options/own/{own}", Ct);
        Assert.Equal(before + 1, await Sends(factory, "o-13"));
    }

    [Fact(DisplayName = "options-6（本人が選ぶ、保留する、自分で書く）: 案を選んだ人は 1 人 1 回だけ数え、保留では数えない")]
    public async Task ChoosingCountsOncePerPerson()
    {
        var (factory, ai, _) = Setup();
        var client = await Ready(factory, ai, "o-14");
        var generated = await Generate(client);

        await PutChoice(client, new { kind = "hold" });
        Assert.Equal(0, await ChoseOption(client));

        await ChooseCard(client, "choose", generated);
        Assert.Equal(1, await ChoseOption(client));

        await ChooseCard(client, "combine", generated);
        var own = Array(await AddOwn(client, "架空の仕事"), "ownJobs")[0].GetProperty("id").GetString();
        await PutChoice(client, new { kind = "own", ownJobId = own });
        Assert.Equal(1, await ChoseOption(client));

        var other = await Consenting(factory, "o-14b");
        var otherOwn = Array(await AddOwn(other, "架空のほかの仕事"), "ownJobs")[0].GetProperty("id").GetString();
        await PutChoice(other, new { kind = "own", ownJobId = otherOwn });
        Assert.Equal(2, await ChoseOption(client));
    }

    [Fact(DisplayName = "common-2（ログに中身を書かない）: 本人が書いた仕事、AI の理由、根拠の言葉はログに出ない")]
    public async Task LogsHaveNoContent()
    {
        var (factory, ai, options) = Setup();
        var client = await Ready(factory, ai, "o-15");
        options.Change = d => d with { Choose = d.Choose with { Reason = "理由の目印-4c8d です。" } };
        var generated = await Generate(client);
        await ChooseCard(client, "choose", generated);
        await AddOwn(client, "書いた仕事の目印-9a1e", "メモの目印-2b7c");
        await client.PostAsJsonAsync("/api/options/own", new { title = "長すぎる目印-5f0d" + new string('あ', 200) }, Ct);
        options.Fail = ConversationAiException.Failure;
        await client.PostAsync("/api/options", null, Ct);

        var logs = factory.CapturedLogs;
        Assert.Contains(logs, l => l.Contains("Options generated", StringComparison.Ordinal));
        foreach (var line in logs)
        {
            Assert.DoesNotContain("目印", line);
            Assert.DoesNotContain("迎えの時間をずらしてもらいました", line);
            Assert.DoesNotContain("オンライン秘書", line);
        }
    }

    [Fact(DisplayName = "options-6（本人が選ぶ、保留する、自分で書く）: 全部消すと、カード、書いた仕事、選んだ案も消える")]
    public async Task DeleteAllRemovesOptions()
    {
        var (factory, ai, _) = Setup();
        var client = await Ready(factory, ai, "o-16");
        var generated = await Generate(client);
        await ChooseCard(client, "choose", generated);
        await AddOwn(client, "架空の仕事");

        var deleted = await client.DeleteAsync("/api/me", Ct);
        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);
        Assert.Null(await factory.Services.GetRequiredService<IDataStore>().GetAsync<OptionsItem>(TestUsers.Key("o-16"), OptionsItem.ItemId, Ct));

        client = await Consenting(factory, "o-16");
        var dto = await Get(client);
        Assert.Equal(JsonValueKind.Null, dto.GetProperty("cards").ValueKind);
        Assert.Empty(Array(dto, "ownJobs"));
        Assert.Equal(JsonValueKind.Null, dto.GetProperty("choice").ValueKind);
    }

    [Fact(DisplayName = "options-7（1 場面で進める）: 了解していない人は仕事の選択肢を読み書きできない")]
    public async Task ConsentIsRequired()
    {
        var (factory, _, options) = Setup();
        var client = factory.CreateUserClient("o-17");
        var other = await client.GetAsync("/api/profile", Ct);

        Assert.Equal(other.StatusCode, (await client.GetAsync("/api/options", Ct)).StatusCode);
        Assert.Equal(other.StatusCode, (await client.PostAsync("/api/options", null, Ct)).StatusCode);
        Assert.Equal(other.StatusCode, (await client.PostAsJsonAsync("/api/options/own", new { title = "x" }, Ct)).StatusCode);
        Assert.NotEqual(HttpStatusCode.OK, other.StatusCode);
        Assert.Equal(0, options.Calls);
    }
}
