using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using Anthropic;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Revalue.Server.Ai;
using Revalue.Server.Features.Discover;

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
        HttpStatusCode status, string body, string mediaType = "application/json")
    {
        var http = new FakeAnthropic(status, body, mediaType);
        var client = new AnthropicClient { ApiKey = "placeholder-for-tests", HttpClient = new HttpClient(http), MaxRetries = 0 };
        var logs = new ListLogger<ClaudeConversationAi>();
        var ai = new ClaudeConversationAi(client, Options.Create(new ClaudeOptions { Model = Model }), logs);
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

        var chunks = await Collect(ai.StreamReplyAsync(Conversation(), MoveKind.AskEasierScene, Ct));

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

        await Collect(ai.StreamReplyAsync(Conversation(), MoveKind.AskWhatYouDid, Ct));

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
        Assert.Equal(expected.Order(), schema.GetProperty("required").EnumerateArray().Select(e => e.GetString()!).Order());
        foreach (var name in expected)
        {
            Assert.Equal("boolean", schema.GetProperty("properties").GetProperty(name).GetProperty("type").GetString());
        }

        // 読み取りには次の一手を足さない。最後は利用者の答え
        var messages = body.GetProperty("messages").EnumerateArray().ToList();
        Assert.Equal("user", messages[^1].GetProperty("role").GetString());
        Assert.DoesNotContain("next_move", body.GetRawText());
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
            await foreach (var chunk in ai.StreamReplyAsync(Conversation(), MoveKind.AskWhatYouDid, Ct))
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

        var error = await Assert.ThrowsAsync<ConversationAiException>(() => Collect(ai.StreamReplyAsync(Conversation(), MoveKind.AskWhatYouDid, Ct)));

        Assert.Equal("failure", error.Kind);
    }

    [Fact(DisplayName = "common-2（ログに中身を書かない）: AI の呼び出しのログに、話した内容と AI の返答を書かない")]
    public async Task LogsHaveNoContent()
    {
        var (readAi, _, readLogs) = Create(HttpStatusCode.OK, MessageJson(ReadingJson, "end_turn"));
        await readAi.ReadAsync(Conversation(), Ct);
        var (replyAi, _, replyLogs) = Create(HttpStatusCode.OK, Sse("end_turn", "返答の目印-5d1e"), "text/event-stream");
        await Collect(replyAi.StreamReplyAsync(Conversation(), MoveKind.AskWhatYouDid, Ct));
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
}

internal static class ContentJson
{
    /// <summary>message の content を文字列にする（文字列でも、text ブロックの並びでも）。</summary>
    public static string ContentText(this JsonElement content) =>
        content.ValueKind == JsonValueKind.String
            ? content.GetString()!
            : string.Concat(content.EnumerateArray().Select(b => b.TryGetProperty("text", out var t) ? t.GetString() : ""));
}
