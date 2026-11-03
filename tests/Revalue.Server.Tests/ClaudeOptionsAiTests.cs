using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using Anthropic;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Revalue.Server.Ai;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

/// <summary>
/// 仕事の選択肢の AI に送るリクエストの組み立てと、応答の受け取り方を確かめる。
/// HTTP の手前で差し替えた受け手が応答を返すので、Claude は呼ばない。根拠の言葉はすべて架空。
/// </summary>
public sealed class ClaudeOptionsAiTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private const string Model = "claude-test-model";
    private const string Q1 = "架空-夫と母の予定がぶつかって";
    private const string Q2 = "架空-班の 2 家族に連絡しました";
    private const string NoticingQuote = "架空-いつもより顔色が悪いと気づきました";
    private const string ExcludedQuote = "架空-外した力の言葉-3e7a";

    private static readonly JobCatalog Catalog = JobCatalog.Load();

    private static Evidence E(Ability ability, int action, string quote, bool fromChoice = false, string? linked = null) =>
        new(ability, action, quote, 1, 1, false, fromChoice, linked);

    private static OptionsInputs Inputs(
        int hours = 10,
        Place place = Place.HomeOnly,
        TimeSlot[]? slots = null,
        AbilityState state = AbilityState.Confirmed,
        Ability[]? excluded = null,
        int? income = 5) =>
        new(
            new ProfileConditions(slots ?? [TimeSlot.Daytime, TimeSlot.Evening], hours, place, income),
            true,
            [new UsableAbility(Ability.Coordinating, state, [E(Ability.Coordinating, 1, Q1), E(Ability.Coordinating, 2, Q2)])],
            excluded ?? [],
            ["架空-自分のペースで進められる"],
            [],
            null);

    private static string DraftJson(string reason = "架空の理由") => JsonSerializer.Serialize(new
    {
        choose = new { made = true, occupationId = "online-secretary", taskIds = new[] { "online-secretary-schedule" }, ability = "coordinating", reason },
        combine = new { made = false, taskIds = Array.Empty<string>(), roleName = "", ability = "coordinating", reason = "" },
        create = new
        {
            made = true, title = "架空の題", who = "架空の誰の", trouble = "架空の困りごと", summary = "架空の中身", ability = "coordinating",
            quotes = new[] { Q1 }, hoursPerWeek = 5, place = "home", timeSlots = new[] { "daytime" }, reason,
        },
    });

    private static string MessageJson(string text, string stopReason) => JsonSerializer.Serialize(new
    {
        id = "msg_test",
        type = "message",
        role = "assistant",
        model = Model,
        content = new object[] { new { type = "text", text } },
        stop_reason = stopReason,
        stop_sequence = (string?)null,
        usage = new { input_tokens = 300, output_tokens = 50, cache_read_input_tokens = 200 },
    });

    private sealed class FakeAnthropic(HttpStatusCode status, string body) : HttpMessageHandler
    {
        public JsonElement RequestBody { get; private set; }
        public string Betas { get; private set; } = "";

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            RequestBody = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct)).RootElement.Clone();
            Betas = request.Headers.TryGetValues("anthropic-beta", out var values) ? string.Join(",", values) : "";
            return new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        }
    }

    private sealed class ListLogger<T> : ILogger<T>
    {
        public ConcurrentQueue<string> Lines { get; } = new();

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            Lines.Enqueue(formatter(state, exception) + (exception is null ? "" : " " + exception));
    }

    private sealed class ListMeter : IAiUsageMeter
    {
        public ConcurrentQueue<AiUsage> Usages { get; } = new();

        public void Record(AiUsage usage) => Usages.Enqueue(usage);
    }

    private static (ClaudeOptionsAi Ai, FakeAnthropic Http, ListLogger<ClaudeOptionsAi> Logs) Create(
        HttpStatusCode status, string body, IAiUsageMeter? meter = null)
    {
        var http = new FakeAnthropic(status, body);
        var client = new AnthropicClient { ApiKey = "placeholder-for-tests", HttpClient = new HttpClient(http), MaxRetries = 0 };
        var logs = new ListLogger<ClaudeOptionsAi>();
        return (new ClaudeOptionsAi(client, Options.Create(new ClaudeOptions { Model = Model }), logs, meter), http, logs);
    }

    private static string Section(string brief, string tag)
    {
        var start = brief.IndexOf($"<{tag}>", StringComparison.Ordinal);
        var end = brief.IndexOf($"</{tag}>", StringComparison.Ordinal);
        Assert.True(start >= 0 && end > start, $"<{tag}> がない");
        return brief[start..end];
    }

    /// <summary>指示の文の、見出し <paramref name="from"/> から次の見出し <paramref name="to"/> の手前まで。</summary>
    private static string Between(string prompt, string from, string to)
    {
        var start = prompt.IndexOf(from, StringComparison.Ordinal);
        var end = prompt.IndexOf(to, start + from.Length, StringComparison.Ordinal);
        Assert.True(start >= 0 && end > start, $"{from} から {to} までがない");
        return prompt[start..end];
    }

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: リクエストは構造化出力、effort high、server-side fallback で、システムプロンプトにキャッシュの印がある")]
    public async Task RequestShape()
    {
        var inputs = Inputs();
        var (ai, http, _) = Create(HttpStatusCode.OK, MessageJson(DraftJson(), "end_turn"));

        var draft = await ai.DraftAsync(inputs, OptionCandidates.From(Catalog, inputs), Ct);

        Assert.Equal("online-secretary", draft.Choose.OccupationId);
        var body = http.RequestBody;
        Assert.Equal(Model, body.GetProperty("model").GetString());
        Assert.Equal(16000, body.GetProperty("max_tokens").GetInt32());

        var system = body.GetProperty("system");
        Assert.Equal(1, system.GetArrayLength());
        Assert.Equal("ephemeral", system[0].GetProperty("cache_control").GetProperty("type").GetString());
        Assert.Equal(PromptFiles.Read(PromptFiles.Options), system[0].GetProperty("text").GetString());

        foreach (var name in new[] { "temperature", "top_p", "top_k", "thinking", "tool_choice" })
        {
            Assert.False(body.TryGetProperty(name, out _), $"{name} を送っている");
        }

        Assert.Equal("default", body.GetProperty("fallbacks").GetString());
        Assert.Contains(ClaudeConversationAi.ServerSideFallbackBeta, http.Betas);

        var message = Assert.Single(body.GetProperty("messages").EnumerateArray());
        Assert.Equal("user", message.GetProperty("role").GetString());
        Assert.Equal(ClaudeOptionsAi.Brief(inputs, OptionCandidates.From(Catalog, inputs)), message.GetProperty("content").ContentText());

        var output = body.GetProperty("output_config");
        Assert.Equal("high", output.GetProperty("effort").GetString());
        var format = output.GetProperty("format");
        Assert.Equal("json_schema", format.GetProperty("type").GetString());
        var schema = format.GetProperty("schema");
        Assert.False(schema.GetProperty("additionalProperties").GetBoolean());
        Assert.Equal(["choose", "combine", "create"], schema.GetProperty("required").EnumerateArray().Select(e => e.GetString()!).Order());

        static void AssertObject(JsonElement element, string[] fields)
        {
            Assert.Equal("object", element.GetProperty("type").GetString());
            Assert.False(element.GetProperty("additionalProperties").GetBoolean());
            Assert.Equal(fields.Order(), element.GetProperty("required").EnumerateArray().Select(e => e.GetString()!).Order());
            Assert.Equal(fields.Order(), element.GetProperty("properties").EnumerateObject().Select(p => p.Name).Order());
        }

        var properties = schema.GetProperty("properties");
        AssertObject(properties.GetProperty("choose"), ["made", "occupationId", "taskIds", "ability", "reason"]);
        AssertObject(properties.GetProperty("combine"), ["made", "taskIds", "roleName", "ability", "reason"]);
        var create = properties.GetProperty("create");
        AssertObject(create, ["made", "title", "who", "trouble", "summary", "ability", "quotes", "hoursPerWeek", "place", "timeSlots", "reason"]);

        string[] abilities = ["noticing", "coordinating", "prioritizing"];
        foreach (var card in new[] { "choose", "combine", "create" })
        {
            var cardProperties = properties.GetProperty(card).GetProperty("properties");
            Assert.Equal(abilities, cardProperties.GetProperty("ability").GetProperty("enum").EnumerateArray().Select(e => e.GetString()));
            Assert.Equal("boolean", cardProperties.GetProperty("made").GetProperty("type").GetString());
        }

        // ID は文字列で受け取り、候補の ID の enum にはしない（コードが照らし合わせる）
        var occupationId = properties.GetProperty("choose").GetProperty("properties").GetProperty("occupationId");
        Assert.Equal("string", occupationId.GetProperty("type").GetString());
        Assert.False(occupationId.TryGetProperty("enum", out _));

        var createProperties = create.GetProperty("properties");
        Assert.Equal(["home", "out"], createProperties.GetProperty("place").GetProperty("enum").EnumerateArray().Select(e => e.GetString()));
        Assert.Equal("integer", createProperties.GetProperty("hoursPerWeek").GetProperty("type").GetString());
        Assert.Equal(
            ["morning", "daytime", "evening", "night"],
            createProperties.GetProperty("timeSlots").GetProperty("items").GetProperty("enum").EnumerateArray().Select(e => e.GetString()));
    }

    [Fact(DisplayName = "options-5（条件の範囲だけ）: AI に渡す文には、条件に合う候補の業務だけが入る")]
    public void BriefHasOnlyFittingTasks()
    {
        var inputs = Inputs();
        var brief = ClaudeOptionsAi.Brief(inputs, OptionCandidates.From(Catalog, inputs));

        var candidates = Section(brief, "candidates");
        Assert.Contains("online-secretary-schedule", candidates);
        Assert.Contains("recruiting-interview-schedule", candidates);
        // 家だけの人に、外に出る業務を渡さない
        Assert.DoesNotContain("accounting-cash", brief);
        Assert.DoesNotContain("recruiting-reception", brief);
        Assert.Contains("choose: 作れる", Section(brief, "cards"));
        Assert.Contains("combine: 作れる", Section(brief, "cards"));

        var conditions = Section(brief, "conditions");
        Assert.Contains("daytime", conditions);
        Assert.Contains("evening", conditions);
        Assert.DoesNotContain("night", conditions);
        Assert.Contains("10", conditions);
        Assert.Contains("homeOnly", conditions);
        Assert.Contains("5 万円", conditions);

        // 週 1 時間、日中だけ: 業務は 1 つ（オンライン秘書の手配）だけで、組み合わせるは作れない
        var tight = Inputs(hours: 1, slots: [TimeSlot.Daytime], income: null);
        var tightCandidates = OptionCandidates.From(Catalog, tight);
        Assert.False(tightCandidates.CanCombine);
        var tightBrief = ClaudeOptionsAi.Brief(tight, tightCandidates);
        Assert.Contains("online-secretary-arrangement", tightBrief);
        Assert.DoesNotContain("online-secretary-schedule", tightBrief);
        Assert.DoesNotContain("accounting-", tightBrief);
        Assert.Contains("combine: 作れない", Section(tightBrief, "cards"));
        Assert.Contains("まだ決めていない", Section(tightBrief, "conditions"));
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: AI に渡す文には、外した力と未確認の力が入らない")]
    public void BriefHasOnlyUsableAbilities()
    {
        // 見立てる力は本人が外した。優先順位をつける力は未確認なので、使える力に入っていない
        var inputs = Inputs(excluded: [Ability.Noticing]);
        var brief = ClaudeOptionsAi.Brief(inputs, OptionCandidates.From(Catalog, inputs));

        var abilities = Section(brief, "abilities");
        Assert.Contains("coordinating", abilities);
        Assert.Contains(AbilityText.Name(Ability.Coordinating), abilities);
        Assert.Contains($"「{Q1}」", abilities);
        Assert.Contains($"「{Q2}」", abilities);
        Assert.DoesNotContain("noticing", abilities);
        Assert.DoesNotContain("prioritizing", abilities);
        Assert.DoesNotContain(AbilityText.Name(Ability.Noticing), abilities);
        Assert.DoesNotContain(AbilityText.Name(Ability.Prioritizing), abilities);
        Assert.DoesNotContain(ExcludedQuote, brief);
        Assert.DoesNotContain(NoticingQuote, brief);
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: 選んだ答えの根拠には（選んだ答え）と結びついた本人の言葉を添え、記録は本人の言葉として渡す")]
    public void BriefMarksChosenAnswersAndRecords()
    {
        var inputs = Inputs() with
        {
            Abilities = [new UsableAbility(Ability.Coordinating, AbilityState.Confirmed, [E(Ability.Coordinating, 2, "架空-頼んだ", true, "架空-姉に電話して")])],
            Wants = ["架空-人の役に立つことをしたい"],
            Agency = "架空-自分で決めて動いた",
        };

        var brief = ClaudeOptionsAi.Brief(inputs, OptionCandidates.From(Catalog, inputs));

        Assert.Contains("「架空-頼んだ」（選んだ答え）", Section(brief, "abilities"));
        Assert.Contains("「架空-姉に電話して」", Section(brief, "abilities"));
        var records = Section(brief, "records");
        Assert.Contains("架空-自分のペースで進められる", records);
        Assert.Contains("架空-人の役に立つことをしたい", records);
        Assert.Contains("架空-自分で決めて動いた", records);

        var empty = Inputs() with { Preferences = [], Wants = [], Agency = null };
        var emptyRecords = Section(ClaudeOptionsAi.Brief(empty, OptionCandidates.From(Catalog, empty)), "records");
        Assert.Contains("まだ決めていない", emptyRecords);
        Assert.Contains("まだ書いていない", emptyRecords);
    }

    [Fact(DisplayName = "options-7（1 場面で進める）: 確かめ中の力は、AI に渡す文で「確かめ中」と示す")]
    public void BriefMarksNeedsCheck()
    {
        var checking = Inputs(state: AbilityState.NeedsCheck);
        Assert.Contains("確かめ中", Section(ClaudeOptionsAi.Brief(checking, OptionCandidates.From(Catalog, checking)), "abilities"));

        var seen = Inputs(state: AbilityState.Confirmed);
        var abilities = Section(ClaudeOptionsAi.Brief(seen, OptionCandidates.From(Catalog, seen)), "abilities");
        Assert.Contains("見えた力", abilities);
        Assert.DoesNotContain("確かめ中", abilities);
    }

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: 形の合わない答えは失敗として扱う")]
    public void ParseDraftRejectsWrongShapes()
    {
        Assert.Equal("failure", Assert.Throws<ConversationAiException>(() => ClaudeOptionsAi.ParseDraft("{}")).Kind);
        Assert.Equal("failure", Assert.Throws<ConversationAiException>(() => ClaudeOptionsAi.ParseDraft("not json")).Kind);
        Assert.Equal("failure", Assert.Throws<ConversationAiException>(() => ClaudeOptionsAi.ParseDraft(DraftJson().Replace("\"hoursPerWeek\":5", "\"hoursPerWeek\":\"5\""))).Kind);

        var draft = ClaudeOptionsAi.ParseDraft(DraftJson("架空の理由-a"));
        Assert.Equal(
            (true, "online-secretary", "coordinating", "架空の理由-a"),
            (draft.Choose.Made, draft.Choose.OccupationId, draft.Choose.Ability, draft.Choose.Reason));
        Assert.Equal(["online-secretary-schedule"], draft.Choose.TaskIds);
        Assert.False(draft.Combine.Made);
        Assert.Empty(draft.Combine.TaskIds);
        Assert.True(draft.Create.Made);
        Assert.Equal([Q1], draft.Create.Quotes);
        Assert.Equal(5, draft.Create.HoursPerWeek);
        Assert.Equal("home", draft.Create.Place);
        Assert.Equal(["daytime"], draft.Create.TimeSlots);
        Assert.Equal("架空の題", draft.Create.Title);
    }

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: 断られたら拒否、途中で切れたか呼び出しに失敗したら失敗として知らせる")]
    public async Task RefusalAndFailure()
    {
        var inputs = Inputs();
        var candidates = OptionCandidates.From(Catalog, inputs);

        var refused = Create(HttpStatusCode.OK, MessageJson("", "refusal")).Ai;
        Assert.Equal("refusal", (await Assert.ThrowsAsync<ConversationAiException>(() => refused.DraftAsync(inputs, candidates, Ct))).Kind);

        var cutOff = Create(HttpStatusCode.OK, MessageJson("""{"choose":""", "max_tokens")).Ai;
        Assert.Equal("failure", (await Assert.ThrowsAsync<ConversationAiException>(() => cutOff.DraftAsync(inputs, candidates, Ct))).Kind);

        var broken = Create(HttpStatusCode.InternalServerError, """{"type":"error","error":{"type":"api_error","message":"x"}}""").Ai;
        Assert.Equal("failure", (await Assert.ThrowsAsync<ConversationAiException>(() => broken.DraftAsync(inputs, candidates, Ct))).Kind);
    }

    [Fact(DisplayName = "common-2（ログに中身を書かない）: 仕事の選択肢の AI のログに、根拠の言葉と AI の答えを書かず、トークン数は数え役に渡す")]
    public async Task LogsHaveNoContentAndMeterGetsUsage()
    {
        var inputs = Inputs();
        var candidates = OptionCandidates.From(Catalog, inputs);
        var meter = new ListMeter();
        var (ai, _, logs) = Create(HttpStatusCode.OK, MessageJson(DraftJson("理由の目印-7b2f"), "end_turn"), meter);
        await ai.DraftAsync(inputs, candidates, Ct);
        var (failAi, _, failLogs) = Create(HttpStatusCode.InternalServerError, """{"type":"error","error":{"type":"api_error","message":"x"}}""");
        await Assert.ThrowsAsync<ConversationAiException>(() => failAi.DraftAsync(inputs, candidates, Ct));

        Assert.Equal(new AiUsage("options", 300, 200, 0, 50), Assert.Single(meter.Usages));
        Assert.NotEmpty(logs.Lines);
        Assert.NotEmpty(failLogs.Lines);
        foreach (var line in logs.Lines.Concat(failLogs.Lines))
        {
            Assert.DoesNotContain(Q1, line);
            Assert.DoesNotContain("理由の目印", line);
            Assert.DoesNotContain("online-secretary", line);
        }
    }

    [Fact(DisplayName = "options-1（3 枚を同じ重さで示す）: 仕事の選択肢の指示は、順位を付けない、渡した ID だけ、「」は根拠の言葉だけ、と書いている")]
    public void PromptStatesRules()
    {
        var prompt = PromptFiles.Read(PromptFiles.Options);

        foreach (var tag in new[] { "<abilities>", "<conditions>", "<records>", "<candidates>", "<cards>" })
        {
            Assert.Contains(tag, prompt);
        }

        foreach (var key in new[] { "made", "occupationId", "taskIds", "roleName", "quotes", "hoursPerWeek", "timeSlots" })
        {
            Assert.Contains($"`{key}`", prompt);
        }

        Assert.Contains("本人が決め", prompt);
        Assert.Contains("渡した候補の ID だけ", prompt);
        Assert.Contains("一字一句そのまま", prompt);
        Assert.Contains("確かめ中", prompt);
        Assert.Contains("かもしれません", prompt);
        Assert.Contains("需要や収入を約束", prompt);
        Assert.Contains("家族の病気", prompt);
        Assert.Contains("人柄や向き不向きを推し量らない", prompt);
        Assert.Contains("求人", prompt);

        // 3 枚に共通すること: 採用や収入を約束しない、どの文も褒め言葉で埋めない、お金の額を書かない、「」は理由の中だけ
        var common = Between(prompt, "## 3 枚に共通すること", "## 選ぶ");
        Assert.Contains("採用される、すぐ働ける、収入が得られる、と約束しない", common);
        Assert.Contains("褒め言葉", common);
        Assert.Contains("達人", common);
        Assert.Contains("お金の額", common);
        Assert.Contains("「」は、理由（`reason`）の中だけ", common);
        // 創るは、値段、収入、件数の数字を書かない
        Assert.Contains("値段、収入、件数の数字を書かない", Between(prompt, "## 創る", "## 理由"));
        // 理由: 根拠の言葉の一部を引くときの下限と、選んだ答えの言葉の引き方
        var reason = Between(prompt, "## 理由", "## 本人の記録の扱い");
        Assert.Contains("4 文字以上", reason);
        Assert.Contains("（選んだ答え）の言葉を理由で引くときは、話してくれた、と書かない", reason);

        // 使わない言葉は、一覧をそのまま載せて書かないよう伝える
        foreach (var word in ForbiddenWordList.Load().Words)
        {
            Assert.Contains(word, prompt);
        }
    }
}
