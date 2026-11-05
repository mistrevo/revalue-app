using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using Anthropic;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Revalue.Server.Ai;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

/// <summary>
/// Claude に送るリクエストの組み立てと、応答の受け取り方を確かめる。
/// HTTP の手前で差し替えた受け手が応答を返すので、Claude は呼ばない。
/// </summary>
public sealed class ClaudeConversationAiTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private const string Model = "claude-test-model";
    private const string SecretAnswer = "架空の答え-ログに出ない目印-91c2";

    private static readonly DateTimeOffset At = DateTimeOffset.Parse("2026-11-03T03:00:00Z");

    private static IReadOnlyList<Turn> Conversation() =>
    [
        new Turn { Role = TurnRoles.Assistant, Text = DiscoverText.Opening, Choices = DiscoverText.OpeningChoices, Move = "opening", At = At },
        new Turn { Role = TurnRoles.User, Text = "架空の答え。昨日は朝から子どもの支度をした", AnswerKind = AnswerKind.Free, At = At },
        new Turn { Role = TurnRoles.Assistant, Text = "架空の返事。最初に何をしましたか？", Choices = ["起こした", "着替えさせた", "朝ごはんを作った"], Move = "AskWhatYouDid", At = At },
        new Turn { Role = TurnRoles.User, Text = SecretAnswer, AnswerKind = AnswerKind.Choice, At = At },
    ];

    private static string MessageJson(string text, string stopReason) => JsonSerializer.Serialize(new
    {
        id = "msg_test",
        type = "message",
        role = "assistant",
        model = Model,
        content = new object[] { new { type = "text", text } },
        stop_reason = stopReason,
        stop_sequence = (string?)null,
        usage = new { input_tokens = 100, output_tokens = 20, cache_read_input_tokens = 80 },
    });

    private const string ReadingJson =
        """{"concreteEvent":true,"generalOnly":false,"dontKnow":false,"familyIllness":true,"distress":false}""";

    private static string Sse(string stopReason, params string[] texts)
    {
        var sb = new StringBuilder();
        void Event(string name, object data) =>
            sb.Append("event: ").Append(name).Append('\n').Append("data: ").Append(JsonSerializer.Serialize(data)).Append("\n\n");

        Event("message_start", new
        {
            type = "message_start",
            message = new
            {
                id = "msg_test", type = "message", role = "assistant", model = Model, content = Array.Empty<object>(),
                stop_reason = (string?)null, stop_sequence = (string?)null, usage = new { input_tokens = 100, output_tokens = 1 },
            },
        });
        Event("content_block_start", new { type = "content_block_start", index = 0, content_block = new { type = "text", text = "" } });
        foreach (var text in texts)
        {
            Event("content_block_delta", new { type = "content_block_delta", index = 0, delta = new { type = "text_delta", text } });
        }

        Event("content_block_stop", new { type = "content_block_stop", index = 0 });
        Event("message_delta", new
        {
            type = "message_delta",
            delta = new { stop_reason = stopReason, stop_sequence = (string?)null },
            usage = new { output_tokens = 30 },
        });
        Event("message_stop", new { type = "message_stop" });
        return sb.ToString();
    }

    private sealed class FakeAnthropic(HttpStatusCode status, string body, string mediaType) : HttpMessageHandler
    {
        public JsonElement RequestBody { get; private set; }
        public string Betas { get; private set; } = "";

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            RequestBody = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct)).RootElement.Clone();
            Betas = request.Headers.TryGetValues("anthropic-beta", out var values) ? string.Join(",", values) : "";
            return new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, mediaType) };
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

    private static (ClaudeConversationAi Ai, FakeAnthropic Http, ListLogger<ClaudeConversationAi> Logs) Create(
        HttpStatusCode status, string body, string mediaType = "application/json", IAiUsageMeter? meter = null)
    {
        var http = new FakeAnthropic(status, body, mediaType);
        var client = new AnthropicClient { ApiKey = "placeholder-for-tests", HttpClient = new HttpClient(http), MaxRetries = 0 };
        var logs = new ListLogger<ClaudeConversationAi>();
        var ai = new ClaudeConversationAi(client, Options.Create(new ClaudeOptions { Model = Model }), logs, meter);
        return (ai, http, logs);
    }

    private static async Task<List<string>> Collect(IAsyncEnumerable<string> stream)
    {
        var chunks = new List<string>();
        await foreach (var chunk in stream)
        {
            chunks.Add(chunk);
        }

        return chunks;
    }

    private static void AssertCommon(JsonElement body, string betas)
    {
        Assert.Equal(Model, body.GetProperty("model").GetString());

        // システムプロンプトは固定の文だけで、キャッシュの印が付いている
        var system = body.GetProperty("system");
        Assert.Equal(1, system.GetArrayLength());
        Assert.Equal("ephemeral", system[0].GetProperty("cache_control").GetProperty("type").GetString());
        Assert.DoesNotContain("next_move>" + nameof(MoveKind.AskEasierScene), system.GetRawText());

        // Opus 5.5 で 400 になるものを送らない
        foreach (var name in new[] { "temperature", "top_p", "top_k", "thinking", "tool_choice" })
        {
            Assert.False(body.TryGetProperty(name, out _), $"{name} を送っている");
        }

        // 拒否への備え（server-side fallback の既定の形）
        Assert.Equal("default", body.GetProperty("fallbacks").GetString());
        Assert.Contains(ClaudeConversationAi.ServerSideFallbackBeta, betas);

        // 最初の message は user。assistant の先読み入力で終わらない
        var messages = body.GetProperty("messages").EnumerateArray().ToList();
        Assert.Equal("user", messages[0].GetProperty("role").GetString());
        Assert.NotEqual("assistant", messages[^1].GetProperty("role").GetString());
    }

    [Fact(DisplayName = "discover-2（受け止めてから一つだけ聞く）: 返事は effort low で流し、次の一手はシステムプロンプトでなく会話の最後に足す")]
    public async Task ReplyRequestAndStream()
    {
        var (ai, http, _) = Create(HttpStatusCode.OK, Sse("end_turn", "ありがとう", "ございます。"), "text/event-stream");

        var chunks = await Collect(ai.StreamReplyAsync(Conversation(), new NextMove(MoveKind.AskEasierScene), Ct));

        Assert.Equal(["ありがとう", "ございます。"], chunks);
        var body = http.RequestBody;
        AssertCommon(body, http.Betas);
        Assert.True(body.GetProperty("stream").GetBoolean());
        Assert.Equal("low", body.GetProperty("output_config").GetProperty("effort").GetString());
        Assert.False(body.GetProperty("output_config").TryGetProperty("format", out _));

        var messages = body.GetProperty("messages").EnumerateArray().ToList();
        Assert.Equal("system", messages[^1].GetProperty("role").GetString());
        Assert.Contains("<next_move>AskEasierScene</next_move>", messages[^1].GetProperty("content").ContentText());
        Assert.Equal("user", messages[^2].GetProperty("role").GetString());
        Assert.Contains(SecretAnswer, messages[^2].GetProperty("content").ContentText());
    }

    [Fact(DisplayName = "discover-3（選んでも書いてもよい）: assistant の問いには、選択肢も区切りの行と一緒に文として含める")]
    public async Task AssistantTurnsIncludeChoices()
    {
        var (ai, http, _) = Create(HttpStatusCode.OK, Sse("end_turn", "はい"), "text/event-stream");

        await Collect(ai.StreamReplyAsync(Conversation(), new NextMove(MoveKind.AskWhatYouDid), Ct));

        var messages = http.RequestBody.GetProperty("messages").EnumerateArray().ToList();
        // 固定の user の一文 → 最初の問い → 答え → 返事 → 答え → 次の一手
        Assert.Equal(["user", "assistant", "user", "assistant", "user", "system"], messages.Select(m => m.GetProperty("role").GetString()));
        Assert.Contains(ClaudeConversationAi.StartMessage, messages[0].GetProperty("content").ContentText());
        var opening = messages[1].GetProperty("content").ContentText();
        Assert.Contains(ReplyStreamSplitter.Delimiter, opening);
        foreach (var choice in DiscoverText.OpeningChoices)
        {
            Assert.Contains(choice, opening);
        }
    }

    [Fact(DisplayName = "discover-10（つらい状態のサインに応える）: 読み取りは effort medium の構造化出力で、5 つの見分けをすべて求める")]
    public async Task ReadRequestAndParse()
    {
        var (ai, http, _) = Create(HttpStatusCode.OK, MessageJson(ReadingJson, "end_turn"));

        var reading = await ai.ReadAsync(Conversation(), Ct);

        Assert.Equal(new HashSet<AnswerSignal> { AnswerSignal.ConcreteEvent, AnswerSignal.FamilyIllness }, reading.Signals);
        var body = http.RequestBody;
        AssertCommon(body, http.Betas);
        var outputConfig = body.GetProperty("output_config");
        Assert.Equal("medium", outputConfig.GetProperty("effort").GetString());
        var format = outputConfig.GetProperty("format");
        Assert.Equal("json_schema", format.GetProperty("type").GetString());
        var schema = format.GetProperty("schema");
        Assert.False(schema.GetProperty("additionalProperties").GetBoolean());
        string[] expected = ["concreteEvent", "generalOnly", "dontKnow", "familyIllness", "distress"];
        Assert.Equal(expected.Append("evidence").Order(), schema.GetProperty("required").EnumerateArray().Select(e => e.GetString()!).Order());
        foreach (var name in expected)
        {
            Assert.Equal("boolean", schema.GetProperty("properties").GetProperty(name).GetProperty("type").GetString());
        }

        // 読み取りには次の一手を足さない。最後は利用者の答え
        var messages = body.GetProperty("messages").EnumerateArray().ToList();
        Assert.Equal("user", messages[^1].GetProperty("role").GetString());
        Assert.DoesNotContain("next_move", body.GetRawText());
    }

    /// <summary>力をデータに出す前の reader.md の、力の表の部分（一字一句そのまま）。</summary>
    private const string AbilityTableBeforeData = """
        見る力は 3 つです。力ごとに、核となる行動を 3 つ決めています。

        | 力 | `ability` | `action` 1 | `action` 2 | `action` 3 |
        |---|---|---|---|---|
        | 見立てる力 | `noticing` | 変化に自分で気づく | 判断の手がかりを挙げる | いつもの様子や前と比べる |
        | 調整する力 | `coordinating` | 都合の違う 2 者以上が関わる | 本人から働きかける | 代わりの案を出すか、双方の都合を合わせる |
        | 優先順位をつける力 | `prioritizing` | 全部はこなせないほど用事が重なる | 何を先にし、何を後に回すかを具体的に決める | 決めた理由や基準がある |
        """;

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 読み取りの指示の力の表は、判定に使う力からコードが作って差し込み、いまの表と一字一句同じ")]
    public void ReaderPromptInsertsAbilityTableFromData()
    {
        var file = PromptFiles.Read(PromptFiles.Reader);
        var prompt = PromptFiles.ReaderPrompt();

        // 差し込みの印は 1 か所だけで、力の id はファイルに書かない
        Assert.Single(file.Split(PromptFiles.AbilityTableMarker)[1..]);
        Assert.DoesNotContain("`noticing`", file);

        Assert.Equal(AbilityTableBeforeData, PromptFiles.AbilityTable());
        Assert.Equal(file.Replace(PromptFiles.AbilityTableMarker, AbilityTableBeforeData, StringComparison.Ordinal), prompt);
        Assert.DoesNotContain("{{", prompt);

        // 毎回同じ文字列（キャッシュが効く）
        Assert.Equal(prompt, PromptFiles.ReaderPrompt());
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 読み取りのシステムプロンプトは、力の表を差し込んだ指示")]
    public async Task ReadRequestUsesReaderPromptWithTable()
    {
        var (ai, http, _) = Create(HttpStatusCode.OK, MessageJson(ReadingJson, "end_turn"));

        await ai.ReadAsync(Conversation(), Ct);

        var system = http.RequestBody.GetProperty("system");
        Assert.Equal(PromptFiles.ReaderPrompt(), system[0].GetProperty("text").GetString());
        Assert.Contains("| 見立てる力 | `noticing` |", system[0].GetProperty("text").GetString());
    }

    [Fact(DisplayName = "validate-4（根拠は本人の言葉）: 読み取りには、本人の答えに番号と答え方を付けた 1 つの文を渡し、スキーマに evidence を求める")]
    public async Task ReadRequestNumbersAnswersAndAsksEvidence()
    {
        var (ai, http, _) = Create(HttpStatusCode.OK, MessageJson(ReadingJson, "end_turn"));
        IReadOnlyList<Turn> turns =
        [
            .. Conversation(),
            new Turn { Role = TurnRoles.Assistant, Text = "架空の締め。ありがとうございました。", Move = "close", At = At },
            new Turn { Role = TurnRoles.User, Text = "架空の訂正。起こしたのは夫でした", AnswerKind = AnswerKind.Correction, At = At },
        ];

        await ai.ReadAsync(turns, Ct);

        var body = http.RequestBody;
        var messages = body.GetProperty("messages").EnumerateArray().ToList();
        var message = Assert.Single(messages);
        Assert.Equal("user", message.GetProperty("role").GetString());
        var text = message.GetProperty("content").ContentText();
        Assert.StartsWith("<conversation>", text);
        Assert.Contains("</conversation>", text);
        Assert.EndsWith("いちばん最後の答えが、いまの答えです。", text);
        Assert.Contains("聞き手: " + DiscoverText.Opening, text);
        Assert.Contains("（答えの例: 起こした / 着替えさせた / 朝ごはんを作った）", text);
        Assert.Contains("[答え 1]（自由に書いた）架空の答え。昨日は朝から子どもの支度をした", text);
        Assert.Contains("[答え 2]（選択肢から選んだ）" + SecretAnswer, text);
        Assert.Contains("[答え 3]（訂正）架空の訂正。起こしたのは夫でした", text);
        Assert.DoesNotContain(ReplyStreamSplitter.Delimiter, text);

        var schema = body.GetProperty("output_config").GetProperty("format").GetProperty("schema");
        Assert.Contains("evidence", schema.GetProperty("required").EnumerateArray().Select(e => e.GetString()));
        var evidence = schema.GetProperty("properties").GetProperty("evidence");
        Assert.Equal("array", evidence.GetProperty("type").GetString());
        var item = evidence.GetProperty("items");
        Assert.False(item.GetProperty("additionalProperties").GetBoolean());
        string[] fields = ["ability", "action", "quote", "answer", "event", "general", "linkedQuote", "linkedAnswer"];
        Assert.Equal(fields.Order(), item.GetProperty("required").EnumerateArray().Select(e => e.GetString()!).Order());
        var properties = item.GetProperty("properties");
        Assert.Equal(["noticing", "coordinating", "prioritizing"], properties.GetProperty("ability").GetProperty("enum").EnumerateArray().Select(e => e.GetString()));
        Assert.Equal("integer", properties.GetProperty("action").GetProperty("type").GetString());
        Assert.Equal("string", properties.GetProperty("quote").GetProperty("type").GetString());
        Assert.Equal("integer", properties.GetProperty("answer").GetProperty("type").GetString());
        Assert.Equal("integer", properties.GetProperty("event").GetProperty("type").GetString());
        Assert.Equal("boolean", properties.GetProperty("general").GetProperty("type").GetString());
        Assert.Equal("string", properties.GetProperty("linkedQuote").GetProperty("type").GetString());
        Assert.Equal("integer", properties.GetProperty("linkedAnswer").GetProperty("type").GetString());
    }

    [Fact(DisplayName = "validate-4（根拠は本人の言葉）: 読み取りの evidence を根拠の候補に読み、形の合わない要素は捨てる")]
    public void ParseReadingReadsEvidenceCandidates()
    {
        const string json = """
            {"concreteEvent":true,"generalOnly":false,"dontKnow":false,"familyIllness":false,"distress":false,
             "evidence":[
               {"ability":"coordinating","action":2,"quote":"二人に電話しました","answer":1,"event":1,"general":false,"linkedQuote":"","linkedAnswer":0},
               {"ability":"cooking","action":1,"quote":"x","answer":1,"event":1,"general":false,"linkedQuote":"","linkedAnswer":0},
               {"ability":"noticing","action":"3","quote":"x","answer":1,"event":1,"general":false,"linkedQuote":"","linkedAnswer":0},
               {"ability":"noticing","action":1,"answer":1,"event":1,"general":false,"linkedQuote":"","linkedAnswer":0},
               {"ability":"prioritizing","action":1.5,"quote":"x","answer":1,"event":1,"general":false,"linkedQuote":"","linkedAnswer":0},
               "壊れた要素",
               {"ability":"prioritizing","action":3,"quote":"ので","answer":2,"event":1,"general":true,"linkedQuote":"先に","linkedAnswer":1}
             ]}
            """;

        var reading = ClaudeConversationAi.ParseReading(json);

        Assert.Equal(
            [
                new EvidenceCandidate(Ability.Coordinating, 2, "二人に電話しました", 1, 1, false, "", 0),
                new EvidenceCandidate(Ability.Prioritizing, 3, "ので", 2, 1, true, "先に", 1),
            ],
            reading.Candidates!);

        // evidence がない、または配列でなければ、候補なしとして読む
        Assert.Empty(ClaudeConversationAi.ParseReading(ReadingJson).Candidates ?? []);
        Assert.Empty(ClaudeConversationAi.ParseReading(ReadingJson.Replace("}", ""","evidence":"x"}""")).Candidates ?? []);
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 足りない行動を聞く返事では、会話の最後に一手と手がかりだけを渡し、システムプロンプトには入れない")]
    public async Task AskMissingActionPassesHint()
    {
        var (ai, http, _) = Create(HttpStatusCode.OK, Sse("end_turn", "はい"), "text/event-stream");
        var target = new ActionRef(Ability.Coordinating, 3);

        await Collect(ai.StreamReplyAsync(Conversation(), new NextMove(MoveKind.AskMissingAction, target), Ct));

        var body = http.RequestBody;
        AssertCommon(body, http.Betas);
        var messages = body.GetProperty("messages").EnumerateArray().ToList();
        Assert.Equal("system", messages[^1].GetProperty("role").GetString());
        Assert.Equal(
            "<next_move>AskMissingAction</next_move>\n<hint>" + AbilityText.Hint(target) + "</hint>",
            messages[^1].GetProperty("content").ContentText());
        var system = body.GetProperty("system").GetRawText();
        Assert.DoesNotContain("<hint>" + AbilityText.Hint(target), system);
        Assert.DoesNotContain(AbilityText.Hint(target), system);
        Assert.DoesNotContain("coordinating.3", body.GetRawText());
    }

    [Fact(DisplayName = "discover-10（つらい状態のサインに応える）: 読み取りが断られたら拒否、読めなければ失敗として知らせる")]
    public async Task ReadRefusalAndFailure()
    {
        var refused = Create(HttpStatusCode.OK, MessageJson("", "refusal")).Ai;
        Assert.Equal("refusal", (await Assert.ThrowsAsync<ConversationAiException>(() => refused.ReadAsync(Conversation(), Ct))).Kind);

        var unreadable = Create(HttpStatusCode.OK, MessageJson("読めない", "end_turn")).Ai;
        Assert.Equal("failure", (await Assert.ThrowsAsync<ConversationAiException>(() => unreadable.ReadAsync(Conversation(), Ct))).Kind);

        var cutOff = Create(HttpStatusCode.OK, MessageJson("""{"concreteEvent":""", "max_tokens")).Ai;
        Assert.Equal("failure", (await Assert.ThrowsAsync<ConversationAiException>(() => cutOff.ReadAsync(Conversation(), Ct))).Kind);

        var broken = Create(HttpStatusCode.InternalServerError, """{"type":"error","error":{"type":"api_error","message":"x"}}""").Ai;
        Assert.Equal("failure", (await Assert.ThrowsAsync<ConversationAiException>(() => broken.ReadAsync(Conversation(), Ct))).Kind);
    }

    [Fact(DisplayName = "discover-7（返答が少しずつ流れる）: 返事の途中で断られたら、流したあとでも拒否として知らせる")]
    public async Task StreamRefusalAfterPartial()
    {
        var (ai, _, _) = Create(HttpStatusCode.OK, Sse("refusal", "途中まで"), "text/event-stream");
        var chunks = new List<string>();

        var error = await Assert.ThrowsAsync<ConversationAiException>(async () =>
        {
            await foreach (var chunk in ai.StreamReplyAsync(Conversation(), new NextMove(MoveKind.AskWhatYouDid), Ct))
            {
                chunks.Add(chunk);
            }
        });

        Assert.Equal("refusal", error.Kind);
        Assert.Equal(["途中まで"], chunks);
    }

    [Fact(DisplayName = "discover-7（返答が少しずつ流れる）: 返事を始められなければ失敗として知らせる")]
    public async Task StreamFailure()
    {
        var (ai, _, _) = Create(HttpStatusCode.InternalServerError, """{"type":"error","error":{"type":"api_error","message":"x"}}""");

        var error = await Assert.ThrowsAsync<ConversationAiException>(() => Collect(ai.StreamReplyAsync(Conversation(), new NextMove(MoveKind.AskWhatYouDid), Ct)));

        Assert.Equal("failure", error.Kind);
    }

    private sealed class ListMeter : IAiUsageMeter
    {
        public ConcurrentQueue<AiUsage> Usages { get; } = new();

        public void Record(AiUsage usage) => Usages.Enqueue(usage);
    }

    [Fact(DisplayName = "評価: 読み取りと返事のトークン数を、評価の数え役に渡す")]
    public async Task ReportsTokenUsageToMeter()
    {
        var readMeter = new ListMeter();
        await Create(HttpStatusCode.OK, MessageJson(ReadingJson, "end_turn"), meter: readMeter).Ai.ReadAsync(Conversation(), Ct);
        var replyMeter = new ListMeter();
        await Collect(Create(HttpStatusCode.OK, Sse("end_turn", "ありがとう。"), "text/event-stream", replyMeter).Ai
            .StreamReplyAsync(Conversation(), new NextMove(MoveKind.AskWhatYouDid), Ct));

        Assert.Equal(new AiUsage("read", 100, 80, 0, 20), Assert.Single(readMeter.Usages));
        Assert.Equal(new AiUsage("reply", 100, 0, 0, 30), Assert.Single(replyMeter.Usages));
    }

    [Fact(DisplayName = "common-2（ログに中身を書かない）: AI の呼び出しのログに、話した内容と AI の返答を書かない")]
    public async Task LogsHaveNoContent()
    {
        var (readAi, _, readLogs) = Create(HttpStatusCode.OK, MessageJson(ReadingJson, "end_turn"));
        await readAi.ReadAsync(Conversation(), Ct);
        var (replyAi, _, replyLogs) = Create(HttpStatusCode.OK, Sse("end_turn", "返答の目印-5d1e"), "text/event-stream");
        await Collect(replyAi.StreamReplyAsync(Conversation(), new NextMove(MoveKind.AskWhatYouDid), Ct));
        var (failAi, _, failLogs) = Create(HttpStatusCode.InternalServerError, """{"type":"error","error":{"type":"api_error","message":"x"}}""");
        await Assert.ThrowsAsync<ConversationAiException>(() => failAi.ReadAsync(Conversation(), Ct));

        var lines = readLogs.Lines.Concat(replyLogs.Lines).Concat(failLogs.Lines).ToList();
        Assert.NotEmpty(readLogs.Lines);
        Assert.NotEmpty(replyLogs.Lines);
        Assert.NotEmpty(failLogs.Lines);
        foreach (var line in lines)
        {
            Assert.DoesNotContain(SecretAnswer, line);
            Assert.DoesNotContain("返答の目印", line);
            Assert.DoesNotContain("concreteEvent", line);
        }
    }

    [Fact(DisplayName = "discover-2（受け止めてから一つだけ聞く）: プロンプトのファイルが出力にあり、固定の文として読める")]
    public void PromptsAreAvailable()
    {
        var listener = PromptFiles.Read(PromptFiles.Listener);
        var reader = PromptFiles.Read(PromptFiles.Reader);

        Assert.Contains(ReplyStreamSplitter.Delimiter, listener);
        foreach (var move in Enum.GetNames<MoveKind>().Where(m => m != nameof(MoveKind.Distress)))
        {
            Assert.Contains(move, listener);
        }

        foreach (var name in new[] { "concreteEvent", "generalOnly", "dontKnow", "familyIllness", "distress" })
        {
            Assert.Contains(name, reader);
        }
    }

    [Fact(DisplayName = "discover-9（病気の詳しいことは聞かない）: 返事の指示は、どの一手でも病気の詳しいことを聞かないと書いている")]
    public void ListenerForbidsIllnessDetailsInEveryMove()
    {
        var listener = PromptFiles.Read(PromptFiles.Listener);

        // 一手ごとの書き方（ReturnFromIllness）だけでなく、どの一手にも効く「守ること」に書く。
        // 読み取りが家族の病気の話を拾い損ねても、ほかの一手で病気の詳しいことを聞かないように
        var rules = listener[listener.IndexOf("# 守ること", StringComparison.Ordinal)..];
        Assert.Contains("どの一手でも", rules);
        Assert.Contains("病気や症状", rules);
    }

    /// <summary>返事の指示の「次の一手」から、その一手の説明の行を取り出す。</summary>
    private static string MoveLine(string listener, MoveKind move) =>
        listener.Split('\n').Single(l => l.StartsWith($"- `{move}`", StringComparison.Ordinal));

    [Fact(DisplayName = "discover-4（「何もない」も受け止める）: 返事の指示は、行動を話していれば「何もない」が添えてあっても映し返し、その場面の中で聞くと書いている")]
    public void ListenerReflectsActionsEvenWithNothingSpecial()
    {
        var listener = PromptFiles.Read(PromptFiles.Listener);

        // 映し返しを省くのは、行動を話していないときだけ。「特別なことは何も」に黙って同意したように受け取られないように
        var easier = MoveLine(listener, MoveKind.AskEasierScene);
        Assert.Contains("行動を話していないときは、映し返しは書かない", easier);
        Assert.Contains("行動を話しているときは", easier);
        Assert.Contains("その場面の中で一つ聞く", easier);

        var shape = listener[listener.IndexOf("# 返事の形", StringComparison.Ordinal)..listener.IndexOf("# 次の一手", StringComparison.Ordinal)];
        Assert.Contains("特別なことは何も", shape);
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 返事の指示は、「その日のほかのことを話したい」を選んだ人に、前の出来事を聞き直さず、同じ日のほかのことを一つ聞くと書いている")]
    public void ListenerAsksOtherPartOfDayWithoutRevisiting()
    {
        var line = MoveLine(PromptFiles.Read(PromptFiles.Listener), MoveKind.AskOtherPartOfDay);

        Assert.Contains("同じ日の、ほかの時間や出来事を一つ聞く", line);
        Assert.Contains("聞き直したり映し返したりしない", line);
        Assert.Contains("映し返しは書かず", line);
    }

    [Fact(DisplayName = "discover-9（病気の詳しいことは聞かない）: 返事の指示は、本人がすでにしたことを話していれば、映し返してその流れのまま聞くと書いている")]
    public void ListenerKeepsFlowWhenActionsAreAlreadyTold()
    {
        var line = MoveLine(PromptFiles.Read(PromptFiles.Listener), MoveKind.ReturnFromIllness);

        Assert.Contains("すでに自分のしたことを話しているときは", line);
        Assert.Contains("その流れのまま一つ聞く", line);
        Assert.Contains("病気の話を避けているように聞こえる言い方をしない", line);
    }

    [Fact(DisplayName = "discover-4（「何もない」も受け止める）: 読み取りの指示は、「特別なことは何も」が添えてあっても、行動を話していれば具体的な出来事とすると書いている")]
    public void ReaderKeepsConcreteEventWithNothingSpecial()
    {
        // 「見分けるもの」の定義の行（「迷ったとき」の行ではない）
        var line = PromptFiles.Read(PromptFiles.Reader).Split('\n').Single(l => l.StartsWith("- `concreteEvent`（", StringComparison.Ordinal));

        Assert.Contains("特別なことは何も", line);
        Assert.Contains("添えてあっても", line);
    }

    [Fact(DisplayName = "validate-3（結果で見立てを変えない）: 読み取りの指示は、核となる行動の一覧、一字一句の抜き出し、結果で変えないこと、訂正を優先することを書いている")]
    public void ReaderDescribesEvidence()
    {
        var reader = PromptFiles.ReaderPrompt();

        foreach (var key in new[] { "noticing", "coordinating", "prioritizing", "evidence", "quote", "answer", "event", "general", "linkedQuote", "linkedAnswer" })
        {
            Assert.Contains($"`{key}`", reader);
        }

        Assert.Contains("一字一句そのまま", reader);
        Assert.Contains("聞き手の言葉や、答えの例の言葉からは取らない", reader);
        Assert.Contains("結果で判断を変えない", reader);
        Assert.Contains("結果を話していない話も", reader);
        Assert.Contains("前の答えより優先", reader);
        Assert.Contains("本人以外", reader);
        Assert.Contains("[答え N]", reader);
        Assert.Contains("（選択肢から選んだ）", reader);
        Assert.Contains("（訂正）", reader);
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 読み取りの指示は、優先順位をつける力の 3 を、本人が理由や基準を言葉にしたときだけ根拠にし、事実から推し量らないと書いている")]
    public void ReaderDoesNotInferPrioritizingReason()
    {
        var reader = PromptFiles.Read(PromptFiles.Reader);
        var rules = reader[reader.IndexOf("## 根拠にしないもの", StringComparison.Ordinal)..reader.IndexOf("## 選んだ答え", StringComparison.Ordinal)];
        var line = rules.Split('\n').Single(l => l.StartsWith("- 優先順位をつける力の 3", StringComparison.Ordinal));

        Assert.Contains("理由や基準を言葉にしているときだけ根拠にする", line);
        Assert.Contains("理由を推し量らない", line);
        // 台本（e19）の答えの言葉を、指示に写さない
        Assert.DoesNotContain("締め切り", line);
        Assert.DoesNotContain("サイト", line);
    }

    [Fact(DisplayName = "revisit-4（いまの話を聞き切る）: 返事の指示は、本人がしたことを聞く一手で、移動の手段や持ち物の中身のような行動の細部を聞かないと書いている")]
    public void ListenerDoesNotAskActionDetails()
    {
        var line = MoveLine(PromptFiles.Read(PromptFiles.Listener), MoveKind.AskWhatYouDid);

        Assert.DoesNotContain("どうやって", line);
        Assert.Contains("行動の細部は聞かず", line);
        Assert.Contains("本人がしたことを聞く", line);
        // どの力にも寄らない一手なので、優先順位をつける力の 2（先と後を決める）に寄った「決めたこと」を聞かせない
        Assert.DoesNotContain("決めたこと", line);
    }

    [Fact(DisplayName = "discover-2（受け止めてから一つだけ聞く）: 返事の指示は、最初の問いの答えの例を選んだだけの答えに、映し返しを書かず、その日にあったことを一つ聞くと書いている")]
    public void ListenerAsksWhatHappenedAfterOpeningChoice()
    {
        var line = MoveLine(PromptFiles.Read(PromptFiles.Listener), MoveKind.AskWhatYouDid);

        Assert.Contains("最初の問いの答えの例を選んだだけ", line);
        Assert.Contains("映し返しを書かず", line);
        Assert.Contains("その日にどんなことがあったかを一つ聞く", line);
    }

    [Fact(DisplayName = "validate-3（結果で見立てを変えない）: 返事の指示は、どの一手でも、うまくいかなかった日を選んだ人にも話した人にも、うまくいかなかったわけを聞かないと書いている")]
    public void ListenerDoesNotProbeWhyItWentWrong()
    {
        var listener = PromptFiles.Read(PromptFiles.Listener);

        // 選んだか書いたかで分けない。一手ごとではなく、どの一手にも効く「守ること」に書く
        var rules = listener[listener.IndexOf("# 守ること", StringComparison.Ordinal)..];
        var line = rules.Split('\n').Single(l => l.Contains("うまくいかなかったわけ", StringComparison.Ordinal));
        Assert.Contains("どの一手でも", line);
        Assert.Contains("選んだ人", line);
        Assert.Contains("話した人", line);
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 返事の指示は、手がかりについてだけ一つ聞き、したことを前提にせず、答えの例で誘導しないと書いている")]
    public void ListenerDescribesAskMissingAction()
    {
        var line = MoveLine(PromptFiles.Read(PromptFiles.Listener), MoveKind.AskMissingAction);

        Assert.Contains("<hint>", line);
        Assert.Contains("その手がかりについてだけ、一つ聞く", line);
        Assert.Contains("前提にした聞き方をしない", line);
        Assert.Contains("正解のように並べない", line);
        Assert.Contains("そのまま読み上げず", line);
    }

    [Fact(DisplayName = "discover-10（つらい状態のサインに応える）: 読み取りの指示は、寝不足を暮らしの事情として話すだけではサインにせず、見落とさない側に倒す方針は残している")]
    public void ReaderSeparatesShortSleepFromDistress()
    {
        var reader = PromptFiles.Read(PromptFiles.Reader);

        Assert.Contains("見落とさない側に倒す", reader);
        Assert.Contains("暮らしの事情", reader);
        Assert.Contains("夜泣き", reader);
    }
}

internal static class ContentJson
{
    /// <summary>message の content を文字列にする（文字列でも、text ブロックの並びでも）。</summary>
    public static string ContentText(this JsonElement content) =>
        content.ValueKind == JsonValueKind.String
            ? content.GetString()!
            : string.Concat(content.EnumerateArray().Select(b => b.TryGetProperty("text", out var t) ? t.GetString() : ""));
}
