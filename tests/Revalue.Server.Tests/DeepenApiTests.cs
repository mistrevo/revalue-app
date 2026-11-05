using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Ai;
using Revalue.Server.Data;
using Revalue.Server.Features.Deepen;
using Revalue.Server.Features.Foundation.Limits;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Validate;
using static Revalue.Server.Tests.ValidateTestKit;

namespace Revalue.Server.Tests;

/// <summary>テストで差し替える偽物の深める AI。既定は <see cref="ScriptedDeepenAi"/> の答えで、答えを変えたり失敗させたりできる。</summary>
public sealed class FakeDeepenAi : IDeepenAi
{
    private int _calls;

    /// <summary>偽物の答えを変える。引数は <see cref="ScriptedDeepenAi"/> の答え。</summary>
    public Func<DeepenDraft, DeepenDraft> Change { get; set; } = d => d;

    /// <summary>投げる例外の種類（refusal か failure）。null なら答える。</summary>
    public string? Fail { get; set; }

    public int Calls => _calls;

    public async Task<DeepenDraft> DraftAsync(DeepenTarget target, OptionsInputs inputs, CancellationToken ct)
    {
        Interlocked.Increment(ref _calls);
        if (Fail is { } kind)
        {
            throw new ConversationAiException(kind);
        }

        return Change(await new ScriptedDeepenAi().DraftAsync(target, inputs, ct));
    }
}

public sealed class DeepenApiTests
{
    private static object Conditions(int hours, string[]? slots = null, string place = "homeOnly") =>
        new { timeSlots = slots ?? ["daytime", "evening"], hoursPerWeek = hours, place, monthlyIncome = 5 };

    private sealed record Kit(RevalueFactory Factory, FakeConversationAi Ai, FakeOptionsAi Options, FakeDeepenAi Deepen);

    private static Kit Setup()
    {
        var ai = new FakeConversationAi();
        // 選ぶは、オンライン秘書の出張や会食の手配（主な力は利害調整力）にする。
        // 組み合わせるは、出張や会食の手配（利害調整力）と帳簿と口座の照合（変化への気づき）にする
        var options = new FakeOptionsAi
        {
            Change = d => d with
            {
                Choose = d.Choose with { Made = true, OccupationId = "online-secretary", TaskIds = ["online-secretary-arrangement"], Ability = "balancing-interests" },
                Combine = d.Combine with { Made = true, TaskIds = ["online-secretary-arrangement", "accounting-check"], Ability = "balancing-interests" },
            },
        };
        var deepen = new FakeDeepenAi();
        var factory = new RevalueFactory().WithTestServices(services =>
        {
            services.AddSingleton<IConversationAi>(ai);
            services.AddSingleton<IOptionsAi>(options);
            services.AddSingleton<IDeepenAi>(deepen);
        });
        return new Kit(factory, ai, options, deepen);
    }

    /// <summary>話し終えた場面（利害調整力が見えた力）、週 10 時間・日中と夕方・家だけで、仕事のカードを作った人。</summary>
    private static async Task<HttpClient> Ready(Kit kit, string user)
    {
        var client = await Consenting(kit.Factory, user);
        await FinishedEpisode(client, kit.Ai, BalancingInterestsAll);
        await PutConditions(client, Conditions(10));
        var generated = await client.PostAsync("/api/options", null, Ct);
        Assert.Equal(HttpStatusCode.OK, generated.StatusCode);
        return client;
    }

    private static async Task PutConditions(HttpClient client, object conditions) =>
        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync("/api/profile/conditions", conditions, Ct)).StatusCode);

    private static async Task ChooseCard(HttpClient client, string card)
    {
        var options = await Json(await client.GetAsync("/api/options", Ct));
        var generatedAt = options.GetProperty("cards").GetProperty("generatedAt").GetString();
        var response = await client.PutAsJsonAsync("/api/options/choice", new { kind = "card", card, generatedAt }, Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    private static async Task<string> ChooseOwn(HttpClient client, string title, string? note = null)
    {
        var added = await Json(await client.PostAsJsonAsync("/api/options/own", new { title, note }, Ct));
        var id = Array(added, "ownJobs").Last().GetProperty("id").GetString()!;
        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync("/api/options/choice", new { kind = "own", ownJobId = id }, Ct)).StatusCode);
        return id;
    }

    private static async Task<JsonElement> Get(HttpClient client)
    {
        var response = await client.GetAsync("/api/deepen", Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await Json(response);
    }

    private static async Task<JsonElement> Generate(HttpClient client)
    {
        var response = await client.PostAsync("/api/deepen", null, Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await Json(response);
    }

    /// <summary>見ていた中身の作った日時。<paramref name="seen"/> を渡さなければ、いまの中身のものを読む（読めなければ null）。</summary>
    private static async Task<string?> Seen(HttpClient client, string? seen)
    {
        if (seen is not null)
        {
            return seen;
        }

        var response = await client.GetAsync("/api/deepen", Ct);
        return response.StatusCode == HttpStatusCode.OK && Content(await Json(response)) is { ValueKind: JsonValueKind.Object } content
            ? content.GetProperty("generatedAt").GetString()
            : null;
    }

    private static async Task<HttpResponseMessage> PutAnswer(HttpClient client, string id, string? text, bool? fromChoice, string? seen = null) =>
        await client.PutAsJsonAsync($"/api/deepen/answers/{id}", new { text, fromChoice, generatedAt = await Seen(client, seen) }, Ct);

    private static async Task<HttpResponseMessage> PutSteps(HttpClient client, string[]? chosen, string[]? own, string? seen = null) =>
        await client.PutAsJsonAsync("/api/deepen/steps", new { chosen, own, generatedAt = await Seen(client, seen) }, Ct);

    private static async Task<HttpResponseMessage> PutTasks(HttpClient client, object[] tasks, string? seen = null) =>
        await client.PutAsJsonAsync("/api/deepen/tasks", new { tasks, generatedAt = await Seen(client, seen) }, Ct);

    private static string GeneratedAt(JsonElement dto) => Content(dto).GetProperty("generatedAt").GetString()!;

    private static async Task AssertProblem(HttpResponseMessage response, HttpStatusCode status, string type)
    {
        Assert.Equal(status, response.StatusCode);
        Assert.Equal(type, (await Json(response)).GetProperty("type").GetString());
    }

    private static async Task<long> Sends(RevalueFactory factory, string user) =>
        (await factory.Services.GetRequiredService<IDataStore>().GetAsync<DailyCountItem>(TestUsers.Key(user), DailyLimitFilter.UsageId, Ct))?.Count ?? 0;

    private static Task<DeepenItem?> Stored(RevalueFactory factory, string user) =>
        factory.Services.GetRequiredService<IDataStore>().GetAsync<DeepenItem>(TestUsers.Key(user), DeepenItem.ItemId, Ct);

    private static JsonElement Content(JsonElement dto) => dto.GetProperty("content");

    private static List<(string Id, bool Fits, bool Chosen)> Steps(JsonElement dto) =>
        Array(Content(dto), "steps")
            .Select(s => (s.GetProperty("id").GetString()!, s.GetProperty("fits").GetBoolean(), s.GetProperty("chosen").GetBoolean()))
            .ToList();

    [Fact(DisplayName = "deepen-1（選んだ 1 案だけ深める）: 選んだ案がないときと保留のときは深めず、409 を返す")]
    public async Task NoChoiceOrHoldIsNotReady()
    {
        var kit = Setup();
        var client = await Ready(kit, "d-1");

        foreach (var expected in new[] { "noChoice", "hold" })
        {
            if (expected == "hold")
            {
                Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync("/api/options/choice", new { kind = "hold" }, Ct)).StatusCode);
            }

            var dto = await Get(client);
            Assert.Equal(expected, dto.GetProperty("readiness").GetString());
            Assert.Equal(JsonValueKind.Null, dto.GetProperty("target").ValueKind);
            Assert.Equal(JsonValueKind.Null, dto.GetProperty("content").ValueKind);

            var refused = await client.PostAsync("/api/deepen", null, Ct);
            Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
            var problem = await Json(refused);
            Assert.Equal("/problems/deepen-not-ready", problem.GetProperty("type").GetString());
            Assert.Equal(expected, problem.GetProperty("readiness").GetString());
        }

        Assert.Equal(0, kit.Deepen.Calls);
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: GET /api/deepen は、話から確かめる力の一覧を辞書の順で返す")]
    public async Task DeepenReturnsActiveAbilitiesFromCatalog()
    {
        var kit = Setup();
        var client = await Ready(kit, "d-abilities");

        // 選んだ案がなくても、業務の見立てで選べる力は辞書の話から確かめる力と同じ順で返す
        var dto = await Get(client);
        var returned = dto.GetProperty("abilities").EnumerateArray()
            .Select(a => (a.GetProperty("key").GetString()!, a.GetProperty("name").GetString()!))
            .ToList();
        var expected = AbilityCatalog.Active.Select(a => (a.Id, AbilityCatalog.Name(a))).ToList();
        Assert.Equal(expected, returned);
    }

    [Fact(DisplayName = "deepen-1（選んだ 1 案だけ深める）: 選んだ案を深め、同じ案なら AI を呼ばずに返す")]
    public async Task DeepensChosenOnceAndReuses()
    {
        var kit = Setup();
        var client = await Ready(kit, "d-2");
        await ChooseCard(client, "choose");

        var before = await Get(client);
        Assert.Equal("ready", before.GetProperty("readiness").GetString());
        Assert.Equal(JsonValueKind.Null, before.GetProperty("content").ValueKind);
        var target = before.GetProperty("target");
        Assert.Equal(("choose", "オンライン秘書", false), (target.GetProperty("kind").GetString(), target.GetProperty("title").GetString(), target.GetProperty("outsideConditions").GetBoolean()));

        var sends = await Sends(kit.Factory, "d-2");
        var dto = await Generate(client);
        var content = Content(dto);
        Assert.False(content.GetProperty("stale").GetBoolean());
        Assert.False(content.GetProperty("retryPaused").GetBoolean());
        var task = Assert.Single(Array(content, "tasks"));
        Assert.Equal("online-secretary-arrangement", task.GetProperty("id").GetString());
        Assert.False(task.GetProperty("drafted").GetBoolean());
        var question = Assert.Single(Array(content, "questions"));
        Assert.Equal("q1", question.GetProperty("id").GetString());
        Assert.Equal(3, Array(question, "choices").Length);
        Assert.Equal(AbilityText.Name(TestAbilities.BalancingInterests), question.GetProperty("abilityName").GetString());
        Assert.Equal(JsonValueKind.Null, question.GetProperty("answer").ValueKind);
        Assert.Equal([("s1", true, false), ("s2", true, false), ("s3", true, false)], Steps(dto));
        Assert.Equal(sends + 1, await Sends(kit.Factory, "d-2"));

        kit.Factory.Clock.Advance(TimeSpan.FromMinutes(1));
        var again = await Generate(client);
        Assert.Equal(1, kit.Deepen.Calls);
        Assert.Equal(sends + 1, await Sends(kit.Factory, "d-2"));
        Assert.Equal(dto.GetRawText(), again.GetRawText());
    }

    [Fact(DisplayName = "deepen-1（選んだ 1 案だけ深める）: 選び直すと古くなり、作り直すと前の答えと一歩を残さない")]
    public async Task RechoosingMakesDeepenStale()
    {
        var kit = Setup();
        var client = await Ready(kit, "d-3");
        await ChooseCard(client, "choose");
        var first = await Generate(client);
        var choice = Array(Array(Content(first), "questions")[0], "choices")[0].GetString();
        Assert.Equal(HttpStatusCode.OK, (await PutAnswer(client, "q1", choice, true)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await PutSteps(client, ["s1"], ["架空の一歩"])).StatusCode);

        await ChooseCard(client, "combine");
        var stale = await Get(client);
        Assert.Equal("combine", stale.GetProperty("target").GetProperty("kind").GetString());
        Assert.True(Content(stale).GetProperty("stale").GetBoolean());
        Assert.False(Content(stale).GetProperty("retryPaused").GetBoolean());
        // 古い中身は出さない
        Assert.Empty(Array(Content(stale), "tasks"));
        Assert.Empty(Array(Content(stale), "questions"));
        Assert.Empty(Array(Content(stale), "steps"));
        Assert.Empty(Array(Content(stale), "ownSteps"));

        await AssertProblem(await PutAnswer(client, "q1", choice, true), HttpStatusCode.Conflict, "/problems/deepen-changed");
        await AssertProblem(await PutSteps(client, ["s2"], []), HttpStatusCode.Conflict, "/problems/deepen-changed");

        var regenerated = await Generate(client);
        var content = Content(regenerated);
        Assert.False(content.GetProperty("stale").GetBoolean());
        Assert.Equal(["online-secretary-arrangement", "accounting-check"], Array(content, "tasks").Select(t => t.GetProperty("id").GetString()));
        Assert.All(Array(content, "questions"), q => Assert.Equal(JsonValueKind.Null, q.GetProperty("answer").ValueKind));
        Assert.All(Steps(regenerated), s => Assert.False(s.Chosen));
        Assert.Empty(Array(content, "ownSteps"));
        Assert.Equal(2, kit.Deepen.Calls);
    }

    [Fact(DisplayName = "deepen-1（選んだ 1 案だけ深める）: 同じ案を選び直して作り直した中身には、前の中身を見ていた書き換えを入れない")]
    public async Task WritesForEarlierContentOfSameTargetAreRefused()
    {
        var kit = Setup();
        var client = await Ready(kit, "d-15");
        // 「創る」（業務の見立てを持つ）を深めて、その中身（A1）を見ている
        await ChooseCard(client, "create");
        var first = await Generate(client);
        var seen = GeneratedAt(first);
        var choice = Array(Array(Content(first), "questions")[0], "choices")[0].GetString();
        var task = new { name = "架空の業務", detail = "", ability = "noticing-changes", knowledge = "" };

        // ほかのタブで「選ぶ」を選んで深め、また「創る」を選んで深め直した（A2）
        kit.Factory.Clock.Advance(TimeSpan.FromMinutes(1));
        await ChooseCard(client, "choose");
        await Generate(client);
        kit.Factory.Clock.Advance(TimeSpan.FromMinutes(1));
        await ChooseCard(client, "create");
        var again = await Generate(client);
        Assert.NotEqual(seen, GeneratedAt(again));
        Assert.Equal(3, kit.Deepen.Calls);

        // A1 を見ていた書き換えは、A2 には入れない
        await AssertProblem(await PutAnswer(client, "q1", choice, true, seen), HttpStatusCode.Conflict, "/problems/deepen-changed");
        await AssertProblem(await PutSteps(client, ["s1"], ["架空の一歩"], seen), HttpStatusCode.Conflict, "/problems/deepen-changed");
        await AssertProblem(await PutTasks(client, [task], seen), HttpStatusCode.Conflict, "/problems/deepen-changed");
        var stored = await Stored(kit.Factory, "d-15");
        Assert.Empty(stored!.Answers);
        Assert.Empty(stored.ChosenStepIds);
        Assert.Empty(stored.OwnSteps);
        Assert.Equal(["t1", "t2"], stored.Content!.Tasks.Select(t => t.Id));

        // 作った日時を送らない書き換えは断る
        await AssertProblem(
            await client.PutAsJsonAsync("/api/deepen/steps", new { chosen = new[] { "s1" }, own = System.Array.Empty<string>() }, Ct),
            HttpStatusCode.BadRequest,
            "/problems/invalid-deepen");

        // A2 を見ていれば書ける
        Assert.Equal(HttpStatusCode.OK, (await PutAnswer(client, "q1", choice, true, GeneratedAt(again))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await PutSteps(client, ["s1"], [], GeneratedAt(again))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await PutTasks(client, [task], GeneratedAt(again))).StatusCode);
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 業務ごとに、使える力と根拠の言葉か、まだ確かめていない力を返す")]
    public async Task TasksAreLitWithUsableAbilities()
    {
        var kit = Setup();
        var client = await Ready(kit, "d-4");
        await ChooseCard(client, "combine");

        var tasks = Array(Content(await Generate(client)), "tasks");

        Assert.Equal(2, tasks.Length);
        var schedule = tasks[0];
        Assert.Equal(("balancing-interests", AbilityText.Name(TestAbilities.BalancingInterests)), (schedule.GetProperty("ability").GetString(), schedule.GetProperty("abilityName").GetString()));
        var usable = schedule.GetProperty("usable");
        Assert.Equal("confirmed", usable.GetProperty("state").GetString());
        Assert.Equal(BalancingInterestsAll.Select(c => c.Quote), Array(usable, "quotes").Select(q => q.GetProperty("text").GetString()));
        Assert.Equal(["予約サイトの使い方"], Array(schedule, "knowledge").Select(k => k.GetString()));

        var check = tasks[1];
        Assert.Equal("noticing-changes", check.GetProperty("ability").GetString());
        Assert.Equal(JsonValueKind.Null, check.GetProperty("usable").ValueKind);
        Assert.Equal(["簿記の基礎", "会計ソフト"], Array(check, "knowledge").Select(k => k.GetString()));
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 「創る」と自分の仕事は見立ての業務を返し、本人が直せる")]
    public async Task DraftedTasksCanBeEdited()
    {
        var kit = Setup();
        var client = await Ready(kit, "d-5");
        await ChooseOwn(client, "架空-地域の窓口の手伝い", "架空のメモ");

        var dto = await Generate(client);
        var drafted = Array(Content(dto), "tasks");
        Assert.Equal(["t1", "t2"], drafted.Select(t => t.GetProperty("id").GetString()));
        Assert.All(drafted, t => Assert.True(t.GetProperty("drafted").GetBoolean()));
        Assert.Equal("own", dto.GetProperty("target").GetProperty("kind").GetString());
        Assert.False(dto.GetProperty("target").GetProperty("outsideConditions").GetBoolean());

        var replaced = await PutTasks(client,
        [
            new { name = "架空の業務 a", detail = "架空の中身", ability = "noticing-changes", knowledge = "表計算" },
            new { name = "架空の業務 b", detail = "", ability = "balancing-interests", knowledge = "" },
            new { name = "  架空の業務 c  ", detail = (string?)null, ability = "setting-priorities", knowledge = (string?)null },
        ]);
        Assert.Equal(HttpStatusCode.OK, replaced.StatusCode);
        var tasks = Array(Content(await Get(client)), "tasks");
        Assert.Equal(["u1", "u2", "u3"], tasks.Select(t => t.GetProperty("id").GetString()));
        Assert.Equal(["架空の業務 a", "架空の業務 b", "架空の業務 c"], tasks.Select(t => t.GetProperty("name").GetString()));
        Assert.All(tasks, t => Assert.True(t.GetProperty("drafted").GetBoolean()));
        Assert.Equal(["表計算"], Array(tasks[0], "knowledge").Select(k => k.GetString()));
        Assert.Empty(Array(tasks[1], "knowledge"));
        Assert.Equal("confirmed", tasks[1].GetProperty("usable").GetProperty("state").GetString());
        Assert.False(Content(await Get(client)).GetProperty("tasksRejected").GetBoolean());

        var task = new { name = "架空の業務", detail = "", ability = "noticing-changes", knowledge = "" };
        await AssertProblem(await PutTasks(client, [new { name = "  ", detail = "", ability = "noticing-changes", knowledge = "" }]), HttpStatusCode.BadRequest, "/problems/invalid-deepen");
        await AssertProblem(await PutTasks(client, [task, task, task, task, task, task]), HttpStatusCode.BadRequest, "/problems/invalid-deepen");
        await AssertProblem(await PutTasks(client, [new { name = "架空の業務", detail = "", ability = "cooking", knowledge = "" }]), HttpStatusCode.BadRequest, "/problems/invalid-deepen");
        await AssertProblem(await PutTasks(client, [new { name = new string('あ', 31), detail = "", ability = "noticing-changes", knowledge = "" }]), HttpStatusCode.BadRequest, "/problems/invalid-deepen");
        await AssertProblem(await PutTasks(client, [new { name = "架空", detail = new string('あ', 81), ability = "noticing-changes", knowledge = "" }]), HttpStatusCode.BadRequest, "/problems/invalid-deepen");
        await AssertProblem(await PutTasks(client, [new { name = "架空", detail = "", ability = "noticing-changes", knowledge = new string('あ', 61) }]), HttpStatusCode.BadRequest, "/problems/invalid-deepen");
        Assert.Equal(3, Array(Content(await Get(client)), "tasks").Length);

        // 見立ての業務をすべて消しても、あとから足せる
        Assert.Equal(HttpStatusCode.OK, (await PutTasks(client, [])).StatusCode);
        var emptied = Content(await Get(client));
        Assert.Empty(Array(emptied, "tasks"));
        Assert.False(emptied.GetProperty("tasksRejected").GetBoolean());
        Assert.Equal(HttpStatusCode.OK, (await PutTasks(client, [task])).StatusCode);
        Assert.Equal(["u1"], Array(Content(await Get(client)), "tasks").Select(t => t.GetProperty("id").GetString()));

        // 「選ぶ」の中身の業務は直せない
        await ChooseCard(client, "choose");
        await Generate(client);
        await AssertProblem(await PutTasks(client, [task]), HttpStatusCode.Conflict, "/problems/deepen-changed");
    }

    [Fact(DisplayName = "deepen-3（最初の一歩は小さく）: 一歩は候補から選んでも書いてもよく、1 つでも複数でも、決めずにおいてもよい")]
    public async Task StepsCanBeChosenWrittenOrLeft()
    {
        var kit = Setup();
        var client = await Ready(kit, "d-6");
        await ChooseCard(client, "choose");
        await Generate(client);

        Assert.Equal(HttpStatusCode.OK, (await PutSteps(client, ["s1", "s3"], ["  近所の図書館で本を借りる  "])).StatusCode);
        var dto = await Get(client);
        Assert.Equal([("s1", true, true), ("s2", true, false), ("s3", true, true)], Steps(dto));
        Assert.Equal(["近所の図書館で本を借りる"], Array(Content(dto), "ownSteps").Select(s => s.GetString()));

        Assert.Equal(HttpStatusCode.OK, (await PutSteps(client, [], [])).StatusCode);
        var cleared = await Get(client);
        Assert.All(Steps(cleared), s => Assert.False(s.Chosen));
        Assert.Empty(Array(Content(cleared), "ownSteps"));

        await AssertProblem(await PutSteps(client, ["s9"], []), HttpStatusCode.BadRequest, "/problems/invalid-deepen");
        await AssertProblem(await PutSteps(client, ["s1", "s1"], []), HttpStatusCode.BadRequest, "/problems/invalid-deepen");
        await AssertProblem(await PutSteps(client, [], ["a", "b", "c", "d"]), HttpStatusCode.BadRequest, "/problems/invalid-deepen");
        await AssertProblem(await PutSteps(client, [], [new string('あ', 101)]), HttpStatusCode.BadRequest, "/problems/invalid-deepen");
        await AssertProblem(await PutSteps(client, [], [" "]), HttpStatusCode.BadRequest, "/problems/invalid-deepen");
        Assert.Empty(Array(Content(await Get(client)), "ownSteps"));
    }

    [Fact(DisplayName = "deepen-3（最初の一歩は小さく）: 条件を狭めると、収まらない候補はコードの候補で補い、前に選んだ候補は残る")]
    public async Task NarrowedConditionsHideStepCandidates()
    {
        var kit = Setup();
        kit.Deepen.Change = d => d with
        {
            Steps = [new StepDraft("架空の一歩 1", 1, "home", false), new StepDraft("架空の一歩 2", 2, "home", false), new StepDraft("架空の一歩 3", 3, "home", false)],
        };
        var client = await Ready(kit, "d-7");
        await ChooseCard(client, "choose");
        await Generate(client);
        Assert.Equal(HttpStatusCode.OK, (await PutSteps(client, ["s3"], [])).StatusCode);

        // 週 1 時間（選べる条件でいちばん短い）: s2（2 時間）は出さず、選んでいた s3（3 時間）は条件の外として残し、コードの候補で補って 3 つにする
        await PutConditions(client, Conditions(1));
        var narrowed = await Get(client);
        Assert.Equal([("s1", true, false), ("s3", false, true), ("f1", true, false), ("f2", true, false)], Steps(narrowed));
        Assert.Equal(3, Steps(narrowed).Count(s => s.Fits));

        Assert.Equal(HttpStatusCode.OK, (await PutSteps(client, ["s3", "f1"], [])).StatusCode);
        Assert.Contains(("f1", true, true), Steps(await Get(client)));

        // 出していない s2 は新しく選べない
        await AssertProblem(await PutSteps(client, ["s3", "f1", "s2"], []), HttpStatusCode.Conflict, "/problems/deepen-changed");
        Assert.Equal(["s3", "f1"], Steps(await Get(client)).Where(s => s.Chosen).Select(s => s.Id));

        // 条件を戻しても、選んだコードの候補は選んだまま見える
        await PutConditions(client, Conditions(10));
        var widened = Steps(await Get(client));
        Assert.Contains(("f1", true, true), widened);
        Assert.Contains(("s3", true, true), widened);
    }

    [Fact(DisplayName = "deepen-4（創るの一歩には需要の確かめを入れる）: 「創る」を深めると、需要の確かめの候補がある")]
    public async Task CreateHasDemandCheck()
    {
        var kit = Setup();
        var client = await Ready(kit, "d-8");
        await ChooseCard(client, "create");

        var dto = await Generate(client);
        Assert.Equal("create", dto.GetProperty("target").GetProperty("kind").GetString());
        Assert.Contains(Array(Content(dto), "steps"), s => s.GetProperty("demandCheck").GetBoolean());
        Assert.False(Content(dto).GetProperty("stepsFallback").GetBoolean());
        Assert.Equal(2, Array(Content(dto), "tasks").Length);

        // 偽物の答えから需要の確かめを外すと、コードの候補に置き換わる
        kit.Deepen.Change = d => d with { Steps = d.Steps.Select(s => s with { DemandCheck = false }).ToList() };
        await ChooseOwn(client, "架空の仕事");
        await Generate(client);
        await ChooseCard(client, "create");
        var fallback = await Generate(client);
        Assert.True(Content(fallback).GetProperty("stepsFallback").GetBoolean());
        var steps = Array(Content(fallback), "steps");
        Assert.Equal(["f1", "f2", "f3"], steps.Select(s => s.GetProperty("id").GetString()));
        Assert.True(steps[0].GetProperty("demandCheck").GetBoolean());
    }

    [Fact(DisplayName = "deepen-6（仮の場面での考え方を聞く）: 答えは選んでも書いてもよく、選んだ答えは選択肢と同じ文でなければ断る")]
    public async Task AnswersCanBeChosenOrWritten()
    {
        var kit = Setup();
        var client = await Ready(kit, "d-9");
        await ChooseCard(client, "choose");
        await Generate(client);

        var choice = ScriptedDeepenAi.Choices[1];
        Assert.Equal(HttpStatusCode.OK, (await PutAnswer(client, "q1", choice, true)).StatusCode);
        var answer = Array(Content(await Get(client)), "questions")[0].GetProperty("answer");
        Assert.Equal((choice, true), (answer.GetProperty("text").GetString(), answer.GetProperty("fromChoice").GetBoolean()));

        Assert.Equal(HttpStatusCode.OK, (await PutAnswer(client, "q1", "  架空-まず相手に聞いてみます  ", false)).StatusCode);
        answer = Array(Content(await Get(client)), "questions")[0].GetProperty("answer");
        Assert.Equal(("架空-まず相手に聞いてみます", false), (answer.GetProperty("text").GetString(), answer.GetProperty("fromChoice").GetBoolean()));

        await AssertProblem(await PutAnswer(client, "q1", "選択肢にない文", true), HttpStatusCode.BadRequest, "/problems/invalid-deepen");
        await AssertProblem(await PutAnswer(client, "q9", choice, true), HttpStatusCode.NotFound, "/problems/not-found");
        await AssertProblem(await PutAnswer(client, "q1", " ", false), HttpStatusCode.BadRequest, "/problems/invalid-deepen");
        await AssertProblem(await PutAnswer(client, "q1", new string('あ', 201), false), HttpStatusCode.BadRequest, "/problems/invalid-deepen");
        Assert.Equal("架空-まず相手に聞いてみます", Array(Content(await Get(client)), "questions")[0].GetProperty("answer").GetProperty("text").GetString());
    }

    [Fact(DisplayName = "deepen-6（仮の場面での考え方を聞く）: 問いに答えても、力の状態は変わらない")]
    public async Task AnswersDoNotChangeAbilities()
    {
        var kit = Setup();
        // 確かめ中の力（核となる行動が 2 つ）だけの人
        var client = await Consenting(kit.Factory, "d-10");
        await FinishedEpisode(client, kit.Ai, BalancingInterestsAll[..2]);
        await PutConditions(client, Conditions(10));
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/api/options", null, Ct)).StatusCode);
        await ChooseCard(client, "choose");
        await Generate(client);

        var store = kit.Factory.Services.GetRequiredService<IDataStore>();
        var abilitiesBefore = (await Json(await client.GetAsync("/api/abilities", Ct))).GetRawText();
        var bookBefore = JsonSerializer.Serialize(await store.GetAsync<AbilityBookItem>(TestUsers.Key("d-10"), AbilityBookItem.ItemId, Ct));
        var episodesBefore = JsonSerializer.Serialize(await store.ListByTypeAsync<Revalue.Server.Features.Discover.EpisodeItem>(TestUsers.Key("d-10"), Revalue.Server.Features.Discover.EpisodeItem.ItemType, Ct));

        // 利害調整力の残りの行動を思わせる答えを書いても
        Assert.Equal(HttpStatusCode.OK, (await PutAnswer(client, "q1", BalancingInterestsAll[2].Quote, false)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await PutAnswer(client, "q1", ScriptedDeepenAi.Choices[2], true)).StatusCode);

        Assert.Equal(abilitiesBefore, (await Json(await client.GetAsync("/api/abilities", Ct))).GetRawText());
        Assert.Equal(bookBefore, JsonSerializer.Serialize(await store.GetAsync<AbilityBookItem>(TestUsers.Key("d-10"), AbilityBookItem.ItemId, Ct)));
        Assert.Equal(episodesBefore, JsonSerializer.Serialize(await store.ListByTypeAsync<Revalue.Server.Features.Discover.EpisodeItem>(TestUsers.Key("d-10"), Revalue.Server.Features.Discover.EpisodeItem.ItemType, Ct)));
        var usable = Array(Content(await Get(client)), "tasks")[0].GetProperty("usable");
        Assert.Equal("needsCheck", usable.GetProperty("state").GetString());
    }

    [Fact(DisplayName = "deepen-1（選んだ 1 案だけ深める）: 初めて深めるときに AI が失敗したら、開き直しても失敗したことを返す")]
    public async Task FirstFailureIsReturnedOnReload()
    {
        var kit = Setup();
        var client = await Ready(kit, "d-21");
        await ChooseCard(client, "choose");
        var first = await Get(client);
        Assert.False(first.GetProperty("retryPaused").GetBoolean());

        kit.Deepen.Fail = ConversationAiException.Failure;
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await client.PostAsync("/api/deepen", null, Ct)).StatusCode);
        var reloaded = await Get(client);
        Assert.Equal(JsonValueKind.Null, reloaded.GetProperty("content").ValueKind);
        Assert.True(reloaded.GetProperty("retryPaused").GetBoolean());

        // 別の案を選べば、その案ではまだ失敗していない
        await ChooseCard(client, "combine");
        Assert.False((await Get(client)).GetProperty("retryPaused").GetBoolean());
    }

    [Fact(DisplayName = "deepen-1（選んだ 1 案だけ深める）: AI が失敗したら何も書き換えず、同じ案のあいだは自動で作り直さない印を残す")]
    public async Task AiFailureKeepsContentAndPausesRetry()
    {
        var kit = Setup();
        var client = await Ready(kit, "d-11");
        await ChooseCard(client, "choose");
        await Generate(client);
        var before = await Stored(kit.Factory, "d-11");

        await ChooseCard(client, "combine");
        var combineBasis = DeepenTargetReader.From(
            await kit.Factory.Services.GetRequiredService<IDataStore>().GetAsync<OptionsItem>(TestUsers.Key("d-11"), OptionsItem.ItemId, Ct),
            new Revalue.Server.Features.Profile.ProfileConditions([Revalue.Server.Features.Profile.TimeSlot.Daytime], 10, Revalue.Server.Features.Profile.Place.HomeOnly, null),
            kit.Factory.Services.GetRequiredService<JobCatalog>()).Target!.Basis;

        foreach (var kind in new[] { ConversationAiException.Failure, ConversationAiException.Refusal })
        {
            kit.Deepen.Fail = kind;
            var failed = await client.PostAsync("/api/deepen", null, Ct);
            Assert.Equal(HttpStatusCode.ServiceUnavailable, failed.StatusCode);
            var problem = await Json(failed);
            Assert.Equal("/problems/ai-unavailable", problem.GetProperty("type").GetString());
            Assert.Equal(kind, problem.GetProperty("kind").GetString());
        }

        var after = await Stored(kit.Factory, "d-11");
        Assert.Equal(combineBasis, after!.FailedBasis);
        Assert.Equal(JsonSerializer.Serialize(before!.Content), JsonSerializer.Serialize(after.Content));
        var paused = Content(await Get(client));
        Assert.True(paused.GetProperty("stale").GetBoolean());
        Assert.True(paused.GetProperty("retryPaused").GetBoolean());

        kit.Deepen.Fail = null;
        var regenerated = Content(await Generate(client));
        Assert.False(regenerated.GetProperty("stale").GetBoolean());
        Assert.False(regenerated.GetProperty("retryPaused").GetBoolean());
        Assert.Null((await Stored(kit.Factory, "d-11"))!.FailedBasis);
    }

    [Fact(DisplayName = "common-2（ログに中身を書かない）: 深める API のログに、業務、問い、答え、一歩の中身を書かない")]
    public async Task LogsHaveNoContent()
    {
        var kit = Setup();
        kit.Deepen.Change = d => d with
        {
            Tasks = [new TaskDraft("業務の目印-1a2b", "中身の目印", "balancing-interests", ""), new TaskDraft("業務の目印-3c4d", "", "noticing-changes", "")],
            Questions = [d.Questions[0] with { Situation = "問いの目印-5e6f、どうしますか？" }],
        };
        var client = await Ready(kit, "d-12");
        await ChooseOwn(client, "書いた仕事の目印-7a8b");
        await Generate(client);
        await PutAnswer(client, "q1", "答えの目印-9c0d", false);
        await PutSteps(client, ["s1"], ["一歩の目印-1e2f"]);
        await PutTasks(client, [new { name = "直した業務の目印", detail = "", ability = "noticing-changes", knowledge = "" }]);
        await ChooseCard(client, "choose");
        kit.Deepen.Fail = ConversationAiException.Failure;
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await client.PostAsync("/api/deepen", null, Ct)).StatusCode);

        var logs = kit.Factory.CapturedLogs;
        Assert.Contains(logs, l => l.Contains("Deepen generated", StringComparison.Ordinal));
        Assert.Contains(logs, l => l.Contains("Deepening ended with", StringComparison.Ordinal));
        foreach (var line in logs)
        {
            Assert.DoesNotContain("目印", line);
            Assert.DoesNotContain(ScriptedDeepenAi.Choices[0], line);
            Assert.DoesNotContain("オンライン秘書", line);
        }
    }

    [Fact(DisplayName = "foundation-3（全部消せる）: 全部消すと、深めた中身も消える")]
    public async Task DeleteAllRemovesDeepen()
    {
        var kit = Setup();
        var client = await Ready(kit, "d-13");
        await ChooseCard(client, "choose");
        await Generate(client);
        Assert.NotNull(await Stored(kit.Factory, "d-13"));

        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync("/api/me", Ct)).StatusCode);
        Assert.Null(await Stored(kit.Factory, "d-13"));
    }

    [Fact(DisplayName = "deepen-1（選んだ 1 案だけ深める）: 了解していない人は深める API を読み書きできない")]
    public async Task ConsentIsRequired()
    {
        var kit = Setup();
        var client = kit.Factory.CreateUserClient("d-14");
        var other = await client.GetAsync("/api/profile", Ct);

        Assert.NotEqual(HttpStatusCode.OK, other.StatusCode);
        Assert.Equal(other.StatusCode, (await client.GetAsync("/api/deepen", Ct)).StatusCode);
        Assert.Equal(other.StatusCode, (await client.PostAsync("/api/deepen", null, Ct)).StatusCode);
        Assert.Equal(other.StatusCode, (await PutSteps(client, [], [])).StatusCode);
        Assert.Equal(other.StatusCode, (await PutAnswer(client, "q1", "x", false)).StatusCode);
        Assert.Equal(other.StatusCode, (await PutTasks(client, [])).StatusCode);
        Assert.Equal(0, kit.Deepen.Calls);
    }
}
