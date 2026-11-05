using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using Anthropic;
using Microsoft.Extensions.Logging;
using Revalue.Server.Ai;
using Revalue.Server.Features.Deepen;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;
using static Revalue.Server.Tests.DeepenTestKit;

namespace Revalue.Server.Tests;

/// <summary>
/// 深める AI に送るリクエストの組み立てと、応答の受け取り方を確かめる。
/// HTTP の手前で差し替えた受け手が応答を返すので、Claude は呼ばない。記録と選んだ案はすべて架空。
/// </summary>
public sealed class ClaudeDeepenAiTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private const string Model = "claude-test-model";

    private static OptionsInputs RecordInputs() => Inputs() with
    {
        Preferences = ["架空-自分のペースで進められる"],
        Wants = ["架空-人の役に立つことをしたい"],
        Agency = "架空-自分で決めて動いた",
    };

    private static string DraftJson(string marker = "架空の一歩") => JsonSerializer.Serialize(new
    {
        tasks = new[]
        {
            new { name = "架空の業務 1", detail = "架空の中身 1", ability = "balancing-interests", knowledge = "表計算" },
            new { name = "架空の業務 2", detail = "", ability = "setting-priorities", knowledge = "" },
        },
        questions = new[]
        {
            new { situation = "架空の場面", ability = "balancing-interests", choices = new[] { "架空の考え方 a", "架空の考え方 b", "架空の考え方 c" } },
        },
        steps = new[]
        {
            new { text = marker, hours = 1, place = "home", demandCheck = true },
            new { text = "架空の一歩 2", hours = 2, place = "out", demandCheck = false },
            new { text = "架空の一歩 3", hours = 3, place = "home", demandCheck = false },
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

    private static (ClaudeDeepenAi Ai, FakeAnthropic Http, ListLogger<ClaudeDeepenAi> Logs) Create(
        HttpStatusCode status, string body, IAiUsageMeter? meter = null)
    {
        var http = new FakeAnthropic(status, body);
        var client = new AnthropicClient { ApiKey = "placeholder-for-tests", HttpClient = new HttpClient(http), MaxRetries = 0 };
        var logs = new ListLogger<ClaudeDeepenAi>();
        return (new ClaudeDeepenAi(client, Microsoft.Extensions.Options.Options.Create(new ClaudeOptions { Model = Model }), logs, meter), http, logs);
    }

    private static string Section(string brief, string tag)
    {
        var start = brief.IndexOf($"<{tag}>", StringComparison.Ordinal);
        var end = brief.IndexOf($"</{tag}>", StringComparison.Ordinal);
        Assert.True(start >= 0 && end > start, $"<{tag}> がない");
        return brief[start..end];
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 深める AI には、根拠の本人の言葉と状態を渡さない")]
    public void BriefHasNoQuotesOrStates()
    {
        var inputs = RecordInputs() with
        {
            Abilities =
            [
                new UsableAbility(TestAbilities.BalancingInterests, AbilityState.Confirmed, [E(TestAbilities.BalancingInterests, 1, Q1), E(TestAbilities.BalancingInterests, 2, Q2)]),
                new UsableAbility(TestAbilities.NoticingChanges, AbilityState.NeedsCheck, [E(TestAbilities.NoticingChanges, 1, "予定を見比べました")]),
            ],
        };

        foreach (var options in new[] { Options(ChooseChoice()), Options(CombineChoice()), Options(CreateChoice()), OwnOptions() })
        {
            var brief = ClaudeDeepenAi.Brief(Target(options), inputs);

            Assert.DoesNotContain(Q1, brief);
            Assert.DoesNotContain(Q2, brief);
            Assert.DoesNotContain("予定を見比べました", brief);
            Assert.DoesNotContain("見えた力", brief);
            Assert.DoesNotContain("確かめ中", brief);
            // カードの理由（根拠の言葉を引いた文）と、収入の目安も渡さない
            Assert.DoesNotContain("理由です。", brief);
            Assert.DoesNotContain("万円", brief);

            var conditions = Section(brief, "conditions");
            Assert.Contains("10 時間", conditions);
            Assert.Contains("homeOnly", conditions);
            Assert.Contains("daytime", conditions);
            Assert.Contains("evening", conditions);
            Assert.DoesNotContain("night", conditions);

            var records = Section(brief, "records");
            Assert.Contains("架空-自分のペースで進められる", records);
            Assert.Contains("架空-人の役に立つことをしたい", records);
            Assert.Contains("架空-自分で決めて動いた", records);

            // 力は 3 つの key と名前だけ
            var abilities = Section(brief, "abilities");
            foreach (var ability in AbilityCatalog.Active)
            {
                Assert.Contains(ActionRef.Key(ability), abilities);
                Assert.Contains(AbilityText.Name(ability), abilities);
            }
        }
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 選んだ案の中身を種類ごとに渡す")]
    public void BriefHasTargetContent()
    {
        var choose = Section(ClaudeDeepenAi.Brief(Target(Options(ChooseChoice())), RecordInputs()), "target");
        Assert.Contains("choose", choose);
        Assert.Contains("オンライン秘書", choose);
        var task = Catalog.FindTask("online-secretary-arrangement")!;
        Assert.Contains(task.Name, choose);
        Assert.Contains(task.Detail, choose);
        Assert.Contains("balancing-interests", choose);

        var combine = Section(ClaudeDeepenAi.Brief(Target(Options(CombineChoice())), RecordInputs()), "target");
        Assert.Contains("予定をつなぐ人", combine);
        Assert.Contains(Catalog.FindTask("accounting-check")!.Name, combine);
        Assert.Contains("noticing-changes", combine);

        var card = Card();
        var create = Section(ClaudeDeepenAi.Brief(Target(Options(CreateChoice())), RecordInputs()), "target");
        foreach (var text in new[] { card.Title, card.Who, card.Trouble, card.Summary })
        {
            Assert.Contains(text, create);
        }

        Assert.Contains("5 時間", create);

        var own = Section(ClaudeDeepenAi.Brief(Target(OwnOptions("架空のメモ-9c1d")), RecordInputs()), "target");
        Assert.Contains("地域の窓口の手伝い", own);
        Assert.Contains("架空のメモ-9c1d", own);
    }

    [Fact(DisplayName = "deepen-3（最初の一歩は小さく）: 登録した業務の小さな試し方を、一歩の手がかりとして AI に渡す")]
    public void BriefHasTrials()
    {
        var combine = Section(ClaudeDeepenAi.Brief(Target(Options(CombineChoice())), RecordInputs()), "target");
        foreach (var id in new[] { "online-secretary-arrangement", "accounting-check" })
        {
            Assert.Contains($"  小さな試し方の例: {Catalog.FindTask(id)!.Trial}\n", combine);
        }

        // 見立ての業務を書く案には、登録の業務の試し方を渡さない
        foreach (var options in new[] { Options(CreateChoice()), OwnOptions() })
        {
            Assert.DoesNotContain("小さな試し方の例", ClaudeDeepenAi.Brief(Target(options), RecordInputs()));
        }
    }

    [Fact(DisplayName = "deepen-6（仮の場面での考え方を聞く）: 登録した業務の使う力は、話から確かめる主な力と補助の力を渡し、準備中の力を渡さない")]
    public void BriefHasActiveTaskAbilities()
    {
        var schedule = Section(ClaudeDeepenAi.Brief(Target(Options(ChooseChoice(taskId: "online-secretary-schedule"))), RecordInputs()), "target");
        var abilities = Catalog.FindTask("online-secretary-schedule")!.Abilities.All;
        Assert.Contains(
            "  使う力: " + string.Join("、", abilities.Select(a => $"{ActionRef.Key(a)}（{AbilityText.Name(a)}）")) + "\n", schedule);

        // 課題の原因の見当づくり: 主な力（原因分析力）と補助の力の仮説思考力は準備中。違和感察知力だけを渡す
        var cause = Section(ClaudeDeepenAi.Brief(Target(Options(ChooseChoice(taskId: "planning-cause-hypothesis"))), RecordInputs()), "target");
        Assert.Contains("  使う力: sensing-incongruity（違和感察知力）\n", cause);
        Assert.DoesNotContain("cause-analysis", cause);
        Assert.DoesNotContain("hypothesis-thinking", cause);
    }

    [Fact(DisplayName = "deepen-3（最初の一歩は小さく）: 深める指示は、問いの力を業務の主な力か補助の力から選び、小さな試し方の例を一歩の手がかりにしてよいと書く")]
    public void PromptMentionsTaskAbilitiesAndTrials()
    {
        var prompt = PromptFiles.Read(PromptFiles.Deepen);

        Assert.Contains("主な力", prompt);
        Assert.Contains("補助の力", prompt);
        Assert.Contains("小さな試し方の例", prompt);
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 「創る」と自分の仕事のときだけ、業務の見立てを求める")]
    public void NeedTasksOnlyForDrafts()
    {
        Assert.Contains("true", Section(ClaudeDeepenAi.Brief(Target(Options(CreateChoice())), RecordInputs()), "needTasks"));
        Assert.Contains("true", Section(ClaudeDeepenAi.Brief(Target(OwnOptions()), RecordInputs()), "needTasks"));
        Assert.Contains("false", Section(ClaudeDeepenAi.Brief(Target(Options(ChooseChoice())), RecordInputs()), "needTasks"));
        Assert.Contains("false", Section(ClaudeDeepenAi.Brief(Target(Options(CombineChoice())), RecordInputs()), "needTasks"));
    }

    [Fact(DisplayName = "deepen-6（仮の場面での考え方を聞く）: 構造化出力、effort high、fallback、キャッシュの印で呼ぶ")]
    public async Task RequestShape()
    {
        var target = Target(Options(ChooseChoice()));
        var inputs = RecordInputs();
        var (ai, http, _) = Create(HttpStatusCode.OK, MessageJson(DraftJson(), "end_turn"));

        var draft = await ai.DraftAsync(target, inputs, Ct);

        Assert.Equal(3, draft.Steps.Count);
        var body = http.RequestBody;
        Assert.Equal(Model, body.GetProperty("model").GetString());
        Assert.Equal(16000, body.GetProperty("max_tokens").GetInt32());

        var system = body.GetProperty("system");
        Assert.Equal(1, system.GetArrayLength());
        Assert.Equal("ephemeral", system[0].GetProperty("cache_control").GetProperty("type").GetString());
        Assert.Equal(PromptFiles.Read(PromptFiles.Deepen), system[0].GetProperty("text").GetString());

        foreach (var name in new[] { "temperature", "top_p", "top_k", "thinking", "tool_choice" })
        {
            Assert.False(body.TryGetProperty(name, out _), $"{name} を送っている");
        }

        Assert.Equal("default", body.GetProperty("fallbacks").GetString());
        Assert.Contains(ClaudeConversationAi.ServerSideFallbackBeta, http.Betas);

        var message = Assert.Single(body.GetProperty("messages").EnumerateArray());
        Assert.Equal("user", message.GetProperty("role").GetString());
        Assert.Equal(ClaudeDeepenAi.Brief(target, inputs), message.GetProperty("content").ContentText());

        var output = body.GetProperty("output_config");
        Assert.Equal("high", output.GetProperty("effort").GetString());
        var format = output.GetProperty("format");
        Assert.Equal("json_schema", format.GetProperty("type").GetString());
        var schema = format.GetProperty("schema");
        Assert.False(schema.GetProperty("additionalProperties").GetBoolean());
        Assert.Equal(["questions", "steps", "tasks"], schema.GetProperty("required").EnumerateArray().Select(e => e.GetString()!).Order());

        static JsonElement Item(JsonElement schema, string name, string[] fields)
        {
            var array = schema.GetProperty("properties").GetProperty(name);
            Assert.Equal("array", array.GetProperty("type").GetString());
            var item = array.GetProperty("items");
            Assert.Equal("object", item.GetProperty("type").GetString());
            Assert.False(item.GetProperty("additionalProperties").GetBoolean());
            Assert.Equal(fields.Order(), item.GetProperty("required").EnumerateArray().Select(e => e.GetString()!).Order());
            Assert.Equal(fields.Order(), item.GetProperty("properties").EnumerateObject().Select(p => p.Name).Order());
            return item.GetProperty("properties");
        }

        var abilities = AbilityCatalog.Active.Select(a => a.Id).ToArray();
        var tasks = Item(schema, "tasks", ["name", "detail", "ability", "knowledge"]);
        Assert.Equal(abilities, tasks.GetProperty("ability").GetProperty("enum").EnumerateArray().Select(e => e.GetString()));
        var questions = Item(schema, "questions", ["situation", "ability", "choices"]);
        Assert.Equal(abilities, questions.GetProperty("ability").GetProperty("enum").EnumerateArray().Select(e => e.GetString()));
        Assert.Equal("array", questions.GetProperty("choices").GetProperty("type").GetString());
        var steps = Item(schema, "steps", ["text", "hours", "place", "demandCheck"]);
        Assert.Equal("integer", steps.GetProperty("hours").GetProperty("type").GetString());
        Assert.Equal(["home", "out"], steps.GetProperty("place").GetProperty("enum").EnumerateArray().Select(e => e.GetString()));
        Assert.Equal("boolean", steps.GetProperty("demandCheck").GetProperty("type").GetString());
    }

    [Fact(DisplayName = "deepen-3（最初の一歩は小さく）: 構造化出力の答えを、深める下書きに読む")]
    public void ParseDraftReadsAllParts()
    {
        var draft = ClaudeDeepenAi.ParseDraft(DraftJson("架空の一歩-a"));

        Assert.Equal(
            [new TaskDraft("架空の業務 1", "架空の中身 1", "balancing-interests", "表計算"), new TaskDraft("架空の業務 2", "", "setting-priorities", "")],
            draft.Tasks);
        var question = Assert.Single(draft.Questions);
        Assert.Equal(("架空の場面", "balancing-interests"), (question.Situation, question.Ability));
        Assert.Equal(["架空の考え方 a", "架空の考え方 b", "架空の考え方 c"], question.Choices);
        Assert.Equal(
            [new StepDraft("架空の一歩-a", 1, "home", true), new StepDraft("架空の一歩 2", 2, "out", false), new StepDraft("架空の一歩 3", 3, "home", false)],
            draft.Steps);

        // 形が合わない答えは失敗
        Assert.Equal("failure", Assert.Throws<ConversationAiException>(() => ClaudeDeepenAi.ParseDraft("{}")).Kind);
        Assert.Equal("failure", Assert.Throws<ConversationAiException>(() => ClaudeDeepenAi.ParseDraft("not json")).Kind);
        Assert.Equal("failure", Assert.Throws<ConversationAiException>(() => ClaudeDeepenAi.ParseDraft(DraftJson().Replace("\"hours\":1", "\"hours\":\"1\""))).Kind);
    }

    [Fact(DisplayName = "deepen-6（仮の場面での考え方を聞く）: 断られたら拒否、途中で切れたか呼び出しに失敗したら失敗として知らせる")]
    public async Task RefusalAndFailure()
    {
        var target = Target(Options(ChooseChoice()));
        var inputs = RecordInputs();

        var refused = Create(HttpStatusCode.OK, MessageJson("", "refusal")).Ai;
        Assert.Equal("refusal", (await Assert.ThrowsAsync<ConversationAiException>(() => refused.DraftAsync(target, inputs, Ct))).Kind);

        var cutOff = Create(HttpStatusCode.OK, MessageJson("""{"tasks":""", "max_tokens")).Ai;
        Assert.Equal("failure", (await Assert.ThrowsAsync<ConversationAiException>(() => cutOff.DraftAsync(target, inputs, Ct))).Kind);

        var broken = Create(HttpStatusCode.InternalServerError, """{"type":"error","error":{"type":"api_error","message":"x"}}""").Ai;
        Assert.Equal("failure", (await Assert.ThrowsAsync<ConversationAiException>(() => broken.DraftAsync(target, inputs, Ct))).Kind);
    }

    [Fact(DisplayName = "common-2（ログに中身を書かない）: 深める AI のログに、選んだ案と AI の答えを書かず、トークン数は数え役に渡す")]
    public async Task LogsHaveNoContentAndMeterGetsUsage()
    {
        var target = Target(OwnOptions("架空のメモ-4f8e"));
        var inputs = RecordInputs();
        var meter = new ListMeter();
        var (ai, _, logs) = Create(HttpStatusCode.OK, MessageJson(DraftJson("一歩の目印-7b2f"), "end_turn"), meter);
        await ai.DraftAsync(target, inputs, Ct);
        var (failAi, _, failLogs) = Create(HttpStatusCode.InternalServerError, """{"type":"error","error":{"type":"api_error","message":"x"}}""");
        await Assert.ThrowsAsync<ConversationAiException>(() => failAi.DraftAsync(target, inputs, Ct));

        Assert.Equal(new AiUsage("deepen", 300, 200, 0, 50), Assert.Single(meter.Usages));
        Assert.NotEmpty(logs.Lines);
        Assert.NotEmpty(failLogs.Lines);
        foreach (var line in logs.Lines.Concat(failLogs.Lines))
        {
            Assert.DoesNotContain("一歩の目印", line);
            Assert.DoesNotContain("架空のメモ", line);
            Assert.DoesNotContain("地域の窓口", line);
            Assert.DoesNotContain("架空の場面", line);
        }
    }

    [Fact(DisplayName = "common-1（使わない言葉を出さない）: 指示には使わない言葉の一覧がすべて載っている")]
    public void PromptListsForbiddenWords()
    {
        var prompt = PromptFiles.Read(PromptFiles.Deepen);

        foreach (var word in ForbiddenWordList.Load().Words)
        {
            Assert.Contains(word, prompt);
        }
    }

    [Fact(DisplayName = "deepen-4（創るの一歩には需要の確かめを入れる）: 深める指示は、渡すタグと答えの key、一歩の範囲、需要の確かめ、問いに正解を作らないことを書いている")]
    public void PromptStatesRules()
    {
        var prompt = PromptFiles.Read(PromptFiles.Deepen);

        foreach (var tag in new[] { "<target>", "<needTasks>", "<conditions>", "<records>", "<abilities>" })
        {
            Assert.Contains(tag, prompt);
        }

        foreach (var key in new[] { "tasks", "questions", "steps", "situation", "choices", "hours", "place", "demandCheck", "knowledge" })
        {
            Assert.Contains($"`{key}`", prompt);
        }

        Assert.Contains("本人が決め", prompt);
        Assert.Contains("正解", prompt);
        Assert.Contains("家族の病気", prompt);
        Assert.Contains("1〜3 時間", prompt);
        Assert.Contains("homeOnly", prompt);
        Assert.Contains("応募、契約、お金を払うこと", prompt);
        Assert.Contains("需要", prompt);
        Assert.Contains("褒め言葉", prompt);
        Assert.Contains("お金の額", prompt);
        Assert.Contains("人柄や向き不向きを推し量らない", prompt);
        Assert.Contains("採用される、収入が得られる、と約束しない", prompt);
    }
}
