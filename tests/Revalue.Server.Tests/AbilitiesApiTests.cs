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
        var consent = await client.PostAsJsonAsync("/api/consent", new { version = ConsentInfo.CurrentVersion }, Ct);
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

    private static readonly EvidenceCandidate[] BalancingInterestsAll =
    [
        Candidate(TestAbilities.BalancingInterests, 1, "夫と母の予定がぶつかって"),
        Candidate(TestAbilities.BalancingInterests, 2, "二人に電話して"),
        Candidate(TestAbilities.BalancingInterests, 3, "迎えの時間をずらしてもらいました"),
    ];

    [Fact(DisplayName = "validate-9（生活での根拠と仕事での発揮を分ける）: 生活の中の状態と根拠を返し、仕事はいつも notChecked")]
    public async Task LifeAndWorkAreSeparate()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.Reading = _ => ReadingWith([.. BalancingInterestsAll, Candidate(TestAbilities.NoticingChanges, 2, "迎えの時間")]);

        await Send(client, id, CoordinatingAnswer);
        await ValidateTestKit.Finish(client, id);
        var dto = await Abilities(client);

        Assert.Equal(["balancing-interests", "noticing-changes"],
            dto.GetProperty("abilities").EnumerateArray().Select(a => a.GetProperty("key").GetString()));
        var coordinating = Ability(dto, "balancing-interests");
        Assert.Equal("利害調整力", coordinating.GetProperty("name").GetString());
        Assert.Equal("confirmed", coordinating.GetProperty("life").GetString());
        Assert.Equal("notChecked", coordinating.GetProperty("work").GetString());
        Assert.Equal(id, coordinating.GetProperty("episodeId").GetString());
        Assert.Equal(3, coordinating.GetProperty("quotes").GetArrayLength());
        Assert.Equal(0, coordinating.GetProperty("hints").GetArrayLength());
        Assert.False(coordinating.GetProperty("excluded").GetBoolean());

        var noticing = Ability(dto, "noticing-changes");
        Assert.Equal("needsCheck", noticing.GetProperty("life").GetString());
        Assert.Equal("notChecked", noticing.GetProperty("work").GetString());
        Assert.Equal(2, noticing.GetProperty("hints").GetArrayLength());

        // 履歴は新しい順。どれも話した内容から（talk）
        var history = dto.GetProperty("history").EnumerateArray().ToList();
        Assert.Equal(2, history.Count);
        Assert.All(history, h => Assert.Equal("talk", h.GetProperty("reason").GetString()));
        Assert.All(history, h => Assert.Equal(id, h.GetProperty("episodeId").GetString()));
        Assert.Equal("利害調整力", history.Single(h => h.GetProperty("key").GetString() == "balancing-interests").GetProperty("name").GetString());
    }

    [Fact(DisplayName = "validate-4（根拠は本人の言葉）: 返す引用は、場面の本人の答えに一字一句含まれる")]
    public async Task QuotesAreVerbatim()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.Reading = _ => ReadingWith([.. BalancingInterestsAll, Candidate(TestAbilities.NoticingChanges, 1, "夫と母の予定がぶつかった")]);

        await Send(client, id, CoordinatingAnswer);
        await ValidateTestKit.Finish(client, id);
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
        Assert.DoesNotContain(dto.GetProperty("abilities").EnumerateArray(), a => a.GetProperty("key").GetString() == "noticing-changes");
    }

    [Fact(DisplayName = "validate-7（見えた力と、もう少し聞きたいことを示す）: GET /api/abilities は見せた力だけを返し、まだ聞けていない力を並べない")]
    public async Task ReturnsOnlyShownAbilities()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.Reading = _ => ReadingWith([.. BalancingInterestsAll, Candidate(TestAbilities.NoticingChanges, 1, "迎えの時間をずらして")]);

        await Send(client, id, CoordinatingAnswer);
        await ValidateTestKit.Finish(client, id);
        var abilities = (await Abilities(client)).GetProperty("abilities").EnumerateArray().ToList();

        Assert.Equal(["balancing-interests", "noticing-changes"], abilities.Select(a => a.GetProperty("key").GetString()));
        Assert.DoesNotContain(abilities, a => a.GetProperty("life").GetString() == "notYet");
        // 根拠の言葉には、その根拠の核となる行動の文が添えてある
        Assert.Equal(
            Enumerable.Range(1, 3).Select(n => AbilityCatalog.ActionText(new ActionRef(TestAbilities.BalancingInterests, n))),
            abilities[0].GetProperty("quotes").EnumerateArray().Select(q => q.GetProperty("action").GetString()));
    }

    [Fact(DisplayName = "validate-12（本人が見立てを外せる）: 画面に出さない力は、見えた力の画面にも履歴にも出ない")]
    public async Task HiddenAbilityIsNotInAbilitiesOrHistory()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        // 利害調整力（行動 3 つ）と段取り力（行動 2 つ）が同じ出来事でそろう。同じ分類なので、見せるのは利害調整力だけ
        ai.Reading = _ => ReadingWith(
        [
            .. BalancingInterestsAll,
            Candidate(TestAbilities.PlanningSteps, 1, "夫と母の予定がぶつかって"),
            Candidate(TestAbilities.PlanningSteps, 2, "迎えの時間をずらしてもらいました"),
        ]);

        await Send(client, id, CoordinatingAnswer);
        await ValidateTestKit.Finish(client, id);
        var dto = await Abilities(client);

        Assert.Equal(["balancing-interests"], dto.GetProperty("abilities").EnumerateArray().Select(a => a.GetProperty("key").GetString()));
        Assert.Equal(["balancing-interests"], dto.GetProperty("history").EnumerateArray().Select(h => h.GetProperty("key").GetString()));
        Assert.DoesNotContain("planning-steps", dto.GetRawText(), StringComparison.Ordinal);
    }

    // 2 往復で見せる力が入れ替わる場面の答えと読み取り。
    // 1 往復目: 傾聴力の 2 つがそろい、優先順位設定力と変化への気づきが 1 つずつ（聞き返すのは辞書の順で前の優先順位設定力）。
    // 2 往復目: 要約力の 2 つがそろい（傾聴力と同じ分類で、辞書の順で前）、利害調整力が 2 つ（変化への気づきより行動が多い）
    private const string FirstSwapAnswer = "用事が三つ重なっていて、娘の顔色がいつもと違っていたので、先に最後まで話を聞いて、けんかしたのがつらかったんだと分かりました。";
    private const string SecondSwapAnswer = "そのあと先生に、娘の話を短くまとめて、私の言葉で伝えました。夫と母の予定がぶつかっていたので、二人に電話しました。";

    private static TurnReading FirstSwapReading(IReadOnlyList<Turn> _) => ReadingWith(
        Candidate(TestAbilities.ActiveListening, 1, "先に最後まで話を聞いて"),
        Candidate(TestAbilities.ActiveListening, 2, "けんかしたのがつらかったんだと分かりました"),
        Candidate(TestAbilities.SettingPriorities, 1, "用事が三つ重なっていて"),
        Candidate(TestAbilities.NoticingChanges, 1, "顔色がいつもと違って"));

    private static TurnReading SecondSwapReading(IReadOnlyList<Turn> _) => ReadingWith(
        Candidate(TestAbilities.Summarizing, 1, "娘の話を短くまとめて", answer: 2),
        Candidate(TestAbilities.Summarizing, 2, "私の言葉で伝えました", answer: 2),
        Candidate(TestAbilities.BalancingInterests, 1, "夫と母の予定がぶつかって", answer: 2),
        Candidate(TestAbilities.BalancingInterests, 2, "二人に電話しました", answer: 2));

    private static List<(string? Key, string? From, string? To, string? Reason)> HistoryRows(JsonElement dto) =>
        dto.GetProperty("history").EnumerateArray()
            .Select(h => (h.GetProperty("key").GetString(), h.GetProperty("from").GetString(), h.GetProperty("to").GetString(),
                h.GetProperty("reason").GetString()))
            .ToList();

    private static int Rank(string? state) => state switch { "notYet" => 0, "needsCheck" => 1, "confirmed" => 2, _ => -1 };

    [Fact(DisplayName = "validate-12（本人が見立てを外せる）: 話している途中に見せる力が入れ替わっても、画面に出さない力は履歴に出ず、下がる行もない")]
    public async Task SwapWhileTalkingLeavesNoHiddenAbilityInHistory()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        ai.Reading = FirstSwapReading;
        await Send(client, id, FirstSwapAnswer);
        // 話している途中の場面では、まだ何も見せていない
        var talking = await Abilities(client);
        Assert.Empty(talking.GetProperty("abilities").EnumerateArray());
        Assert.Empty(talking.GetProperty("history").EnumerateArray());

        ai.Reading = SecondSwapReading;
        await Send(client, id, SecondSwapAnswer);
        await ValidateTestKit.Finish(client, id);

        // 話し終えた場面の見せ方: 見えた力は要約力、もう少し聞かせてほしいことは優先順位設定力（聞き返した力）と利害調整力
        var insights = (await (await client.GetAsync($"/api/episodes/{id}", Ct)).Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("insights");
        Assert.Equal(["summarizing"], insights.GetProperty("seen").EnumerateArray().Select(a => a.GetProperty("key").GetString()));
        Assert.Equal(["setting-priorities", "balancing-interests"],
            insights.GetProperty("moreToHear").EnumerateArray().Select(a => a.GetProperty("key").GetString()));

        var dto = await Abilities(client);
        Assert.Equal(["summarizing", "balancing-interests", "setting-priorities"],
            dto.GetProperty("abilities").EnumerateArray().Select(a => a.GetProperty("key").GetString()));
        var history = HistoryRows(dto);
        Assert.Equal(["balancing-interests", "setting-priorities", "summarizing"], history.Select(h => h.Key).Order(StringComparer.Ordinal));
        Assert.All(history, h => Assert.True(Rank(h.To) > Rank(h.From), $"{h.Key}: {h.From} → {h.To}"));
        Assert.DoesNotContain("active-listening", dto.GetRawText(), StringComparison.Ordinal);
        Assert.DoesNotContain("noticing-changes", dto.GetRawText(), StringComparison.Ordinal);
    }

    [Fact(DisplayName = "validate-12（本人が見立てを外せる）: 続きを話して見せる力が入れ替わっても、一度見せた力は下がらず、画面に出さない力は履歴に出ない")]
    public async Task SwapAfterResumeKeepsShownAbilities()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.Reading = FirstSwapReading;
        await Send(client, id, FirstSwapAnswer);
        await ValidateTestKit.Finish(client, id);

        // 見せたのは、傾聴力（見えた力）と、優先順位設定力・変化への気づき（もう少し聞かせてほしいこと）
        var before = await Abilities(client);
        Assert.Equal(["active-listening", "setting-priorities", "noticing-changes"],
            before.GetProperty("abilities").EnumerateArray().Select(a => a.GetProperty("key").GetString()));

        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync($"/api/episodes/{id}/resume", null, Ct)).StatusCode);
        ai.Reading = SecondSwapReading;
        await Send(client, id, SecondSwapAnswer);
        // 続きを話している途中は、前に話し終えたときの見せ方のまま
        Assert.Equal(before.GetProperty("abilities").GetRawText(), (await Abilities(client)).GetProperty("abilities").GetRawText());
        await ValidateTestKit.Finish(client, id);

        // 場面の見せ方は入れ替わる（傾聴力は要約力に、変化への気づきは利害調整力に隠れる）
        var insights = (await (await client.GetAsync($"/api/episodes/{id}", Ct)).Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("insights");
        Assert.Equal(["summarizing"], insights.GetProperty("seen").EnumerateArray().Select(a => a.GetProperty("key").GetString()));
        Assert.Equal(["setting-priorities", "balancing-interests"],
            insights.GetProperty("moreToHear").EnumerateArray().Select(a => a.GetProperty("key").GetString()));

        // 一度見せた傾聴力と変化への気づきは、見えた力に残り、下がる行もない
        var dto = await Abilities(client);
        Assert.Equal(["summarizing", "active-listening", "balancing-interests", "setting-priorities", "noticing-changes"],
            dto.GetProperty("abilities").EnumerateArray().Select(a => a.GetProperty("key").GetString()));
        Assert.Equal("confirmed", Ability(dto, "active-listening").GetProperty("life").GetString());
        Assert.Equal("needsCheck", Ability(dto, "noticing-changes").GetProperty("life").GetString());
        var history = HistoryRows(dto);
        Assert.Equal(5, history.Count);
        Assert.All(history, h => Assert.True(Rank(h.To) > Rank(h.From), $"{h.Key}: {h.From} → {h.To}"));
        Assert.Equal(
            dto.GetProperty("abilities").EnumerateArray().Select(a => a.GetProperty("key").GetString()).Order(StringComparer.Ordinal),
            history.Select(h => h.Key).Order(StringComparer.Ordinal));
    }

    [Fact(DisplayName = "validate-12（本人が見立てを外せる）: 外すと excluded になり履歴に exclude、戻すと restore")]
    public async Task ExcludeAndRestore()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.Reading = _ => ReadingWith(BalancingInterestsAll);
        await Send(client, id, CoordinatingAnswer);
        await ValidateTestKit.Finish(client, id);

        var excluded = await client.PostAsync("/api/abilities/balancing-interests/exclude", null, Ct);
        Assert.Equal(HttpStatusCode.OK, excluded.StatusCode);
        var dto = await excluded.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Assert.True(Ability(dto, "balancing-interests").GetProperty("excluded").GetBoolean());
        Assert.Equal("confirmed", Ability(dto, "balancing-interests").GetProperty("life").GetString());
        var latest = dto.GetProperty("history")[0];
        Assert.Equal("exclude", latest.GetProperty("reason").GetString());
        Assert.Equal("balancing-interests", latest.GetProperty("key").GetString());
        Assert.Equal("confirmed", latest.GetProperty("from").GetString());
        Assert.Equal("confirmed", latest.GetProperty("to").GetString());
        Assert.True(Ability(await Abilities(client), "balancing-interests").GetProperty("excluded").GetBoolean());

        var restored = await client.PostAsync("/api/abilities/balancing-interests/restore", null, Ct);
        Assert.Equal(HttpStatusCode.OK, restored.StatusCode);
        dto = await restored.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Assert.False(Ability(dto, "balancing-interests").GetProperty("excluded").GetBoolean());
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
        ai.Reading = _ => ReadingWith(BalancingInterestsAll);
        await Send(first, id, CoordinatingAnswer);
        await first.PostAsync("/api/abilities/noticing-changes/exclude", null, Ct);

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
    [InlineData("POST", "/api/abilities/noticing-changes/exclude")]
    [InlineData("POST", "/api/abilities/noticing-changes/restore")]
    public async Task ConsentIsRequired(string method, string path)
    {
        var (factory, _) = Create();
        await using var _f = factory;
        var client = factory.CreateUserClient("g-1");

        var response = await client.SendAsync(new HttpRequestMessage(new HttpMethod(method), path), Ct);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal(0, await factory.Services.GetRequiredService<IDataStore>().CountAllAsync(TestUsers.Key("g-1"), Ct));
    }

    /// <summary>
    /// 前の保存（話している途中の場面も力の本に入れていたころ）の力の本を置く。いまの力の本に、<paramref name="rows"/> の履歴と、その行の後の状態を足す。
    /// いまは話している途中の場面を力の本に入れないので、飛ばして消した場面の根拠や、確かめに使わないことにした履歴は、前の保存にだけ残っている。
    /// </summary>
    private static async Task SeedTalkingEra(
        RevalueFactory factory, string user, params (Ability Ability, AbilityState From, AbilityState To, ChangeReason Reason, string EpisodeId)[] rows)
    {
        var store = factory.Services.GetRequiredService<IDataStore>();
        var key = TestUsers.Key(user);
        var book = await store.GetAsync<AbilityBookItem>(key, AbilityBookItem.ItemId, Ct)
            ?? new AbilityBookItem { Id = AbilityBookItem.ItemId, UserKey = key, Type = AbilityBookItem.ItemType };
        var states = new Dictionary<Ability, AbilityState>(book.States);
        foreach (var row in rows)
        {
            states[row.Ability] = row.To;
        }

        var at = factory.Clock.GetUtcNow();
        await store.UpsertAsync(book with
        {
            States = states,
            History = [.. book.History, .. rows.Select(r => new AbilityChange(at, r.Ability, r.From, r.To, r.Reason, r.EpisodeId))],
        }, Ct);
    }

    [Fact(DisplayName = "validate-8（訂正したら確かめ直す）: 話している途中に飛ばした場面の根拠は見えた力に出ず、前の保存で力の本に入っていた分は、履歴に skip を残して外す")]
    public async Task SkippedEpisodeEvidenceIsRemoved()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.Reading = _ => ReadingWith(BalancingInterestsAll[0], BalancingInterestsAll[1]);
        await Send(client, id, CoordinatingAnswer);
        // 話している途中の場面では、まだ何も見せていない
        var talking = await Abilities(client);
        Assert.Empty(talking.GetProperty("abilities").EnumerateArray());
        Assert.Empty(talking.GetProperty("history").EnumerateArray());
        await SeedTalkingEra(factory, "g-1", (TestAbilities.BalancingInterests, AbilityState.NotYet, AbilityState.NeedsCheck, ChangeReason.Talk, id));

        var skipped = await client.PostAsync($"/api/episodes/{id}/skip", null, Ct);
        Assert.Equal(HttpStatusCode.Created, skipped.StatusCode);

        // 見せた力がなくなったので、見えた力の画面には出さない（まだ聞けていない力は並べない）
        var dto = await Abilities(client);
        Assert.Empty(dto.GetProperty("abilities").EnumerateArray());
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
        ai.Reading = _ => ReadingWith(BalancingInterestsAll);
        await Send(client, id, CoordinatingAnswer);
        ai.Reading = _ => new TurnReading(new HashSet<AnswerSignal> { AnswerSignal.Distress }, []);
        await Send(client, id, "もう消えたいと思うことがあります");
        // 話している途中の場面では何も見せていないので、確かめに使わないことにした履歴も出ない
        Assert.Empty((await Abilities(client)).GetProperty("history").EnumerateArray());
        await SeedTalkingEra(factory, "g-1",
            (TestAbilities.BalancingInterests, AbilityState.NotYet, AbilityState.Confirmed, ChangeReason.Talk, id),
            (TestAbilities.BalancingInterests, AbilityState.Confirmed, AbilityState.NotYet, ChangeReason.SetAside, id));

        var skipped = await client.PostAsync($"/api/episodes/{id}/skip", null, Ct);

        Assert.Equal(HttpStatusCode.Created, skipped.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/episodes/{id}", Ct)).StatusCode);
        var dto = await Abilities(client);
        Assert.Empty(dto.GetProperty("abilities").EnumerateArray());

        // サインの出た時を、消した場面のあとに残さない。保存した生の中身にも残さない
        var history = dto.GetProperty("history").EnumerateArray().ToList();
        Assert.DoesNotContain(history, h => h.GetProperty("reason").GetString() == "setAside");
        var book = Assert.Single(await ValidateTestKit.StoredContent(store), j => j.Contains("\"type\":\"abilityBook\"", StringComparison.Ordinal));
        Assert.DoesNotContain("setAside", book, StringComparison.Ordinal);

        // 状態の移り変わりは、場面を残さずに別の話にしたとして残す（履歴の前と後がつながる）
        Assert.Equal(
            [("skip", "confirmed", "notYet"), ("talk", "notYet", "confirmed")],
            history.Select(h => (h.GetProperty("reason").GetString(), h.GetProperty("from").GetString(), h.GetProperty("to").GetString())));
        Assert.All(history, h => Assert.Equal("balancing-interests", h.GetProperty("key").GetString()));
    }

    [Fact(DisplayName = "discover-5（つらい話は飛ばせる）: 飛ばして消した場面の確かめに使わない履歴を外しても、ほかの場面の履歴とその後の外す・戻すは残す")]
    public async Task SkipAfterDistressKeepsOtherHistory()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var finished = await ValidateTestKit.FinishedEpisode(client, ai, Candidate(TestAbilities.NoticingChanges, 1, "夫と母の予定がぶつかって"));
        var id = await Start(client);
        ai.Reading = _ => ReadingWith(BalancingInterestsAll);
        await Send(client, id, CoordinatingAnswer);
        ai.Reading = _ => new TurnReading(new HashSet<AnswerSignal> { AnswerSignal.Distress }, []);
        await Send(client, id, "もう消えたいと思うことがあります");
        await SeedTalkingEra(factory, "g-1",
            (TestAbilities.BalancingInterests, AbilityState.NotYet, AbilityState.Confirmed, ChangeReason.Talk, id),
            (TestAbilities.BalancingInterests, AbilityState.Confirmed, AbilityState.NotYet, ChangeReason.SetAside, id));
        await client.PostAsync("/api/abilities/balancing-interests/exclude", null, Ct);

        Assert.Equal(HttpStatusCode.Created, (await client.PostAsync($"/api/episodes/{id}/skip", null, Ct)).StatusCode);

        var history = (await Abilities(client)).GetProperty("history").EnumerateArray()
            .Select(h => (h.GetProperty("key").GetString(), h.GetProperty("reason").GetString(), h.GetProperty("from").GetString(),
                h.GetProperty("to").GetString(), h.GetProperty("episodeId").GetString()))
            .ToList();
        // サインのあとに外した行も、サインで下がった状態を読み取れないよう、外した行がなかったときの状態に書き直す
        Assert.Equal(
            [
                ("balancing-interests", "skip", "confirmed", "notYet", id),
                ("balancing-interests", "exclude", "confirmed", "confirmed", null),
                ("balancing-interests", "talk", "notYet", "confirmed", id),
                ("noticing-changes", "talk", "notYet", "needsCheck", finished),
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
        ai.Reading = _ => ReadingWith(BalancingInterestsAll);
        await Send(client, id, CoordinatingAnswer);
        await ValidateTestKit.Finish(client, id);
        await Abilities(client);
        await client.PostAsync("/api/abilities/balancing-interests/exclude", null, Ct);

        Assert.DoesNotContain(factory.CapturedLogs, l => l.Contains("二人に電話", StringComparison.Ordinal));
    }
}
