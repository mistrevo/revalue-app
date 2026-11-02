using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Anthropic;
using Anthropic.Models.Beta.Messages;
using Microsoft.Extensions.Options;
using Revalue.Server.Features.Discover;

namespace Revalue.Server.Ai;

/// <summary>Claude の設定。設定 <c>Claude</c>（環境変数 <c>Claude__Model</c>）から読む。</summary>
public sealed class ClaudeOptions
{
    /// <summary>使うモデル。日付のついた ID は使わない。</summary>
    public string Model { get; set; } = "claude-opus-5-5";
}

/// <summary>
/// 本物の会話の AI（Anthropic の公式 C# SDK）。
/// 読み取りは構造化出力（effort medium）、返事はストリーミング（effort low）。
/// システムプロンプトは Prompts/*.md の固定の文で、キャッシュの印を付ける。次の一手は会話の最後に system メッセージで足す。
/// 断られたときに別のモデルが代わりに答えるよう、server-side fallback（既定の形）を有効にする。
/// ログに書くのは、かかった時間、トークン数、止まった理由、エラーの種類だけ。話した内容と AI の返答は書かない。
/// </summary>
public sealed class ClaudeConversationAi(AnthropicClient client, IOptions<ClaudeOptions> options, ILogger<ClaudeConversationAi> logger)
    : IConversationAi
{
    public const string ServerSideFallbackBeta = "server-side-fallback-2026-07-01";

    /// <summary>会話の最初が assistant の問いなので、その前に置く固定の user の一文。</summary>
    public const string StartMessage = "話を始めます。";

    private const int ReadMaxTokens = 4096;
    private const int ReplyMaxTokens = 4096;

    private static readonly string[] SignalNames = ["concreteEvent", "generalOnly", "dontKnow", "familyIllness", "distress"];

    private readonly string _listenerPrompt = PromptFiles.Read(PromptFiles.Listener);
    private readonly string _readerPrompt = PromptFiles.Read(PromptFiles.Reader);

    public string Model => options.Value.Model;

    public async Task<TurnReading> ReadAsync(IReadOnlyList<Turn> turns, CancellationToken ct)
    {
        var watch = Stopwatch.StartNew();
        BetaMessage response;
        try
        {
            response = await client.Beta.Messages.Create(BuildReadParams(Model, _readerPrompt, turns), ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e)
        {
            LogFailure("read", e, watch);
            throw new ConversationAiException(ConversationAiException.Failure, e);
        }

        var stopReason = response.StopReason?.Raw();
        logger.LogInformation(
            "Claude read finished in {ElapsedMs} ms. Input {InputTokens}, cache read {CacheReadTokens}, output {OutputTokens} tokens. Stop {StopReason}.",
            watch.ElapsedMilliseconds, response.Usage.InputTokens, response.Usage.CacheReadInputTokens, response.Usage.OutputTokens, stopReason);

        if (stopReason == "refusal")
        {
            throw new ConversationAiException(ConversationAiException.Refusal);
        }

        if (stopReason != "end_turn")
        {
            throw new ConversationAiException(ConversationAiException.Failure);
        }

        var text = string.Concat(response.Content.Select(b => b.TryPickText(out var t) ? t.Text : ""));
        return ParseReading(text);
    }

    public async IAsyncEnumerable<string> StreamReplyAsync(IReadOnlyList<Turn> turns, MoveKind move, [EnumeratorCancellation] CancellationToken ct)
    {
        var watch = Stopwatch.StartNew();
        long? firstTextMs = null;
        long inputTokens = 0, cacheReadTokens = 0, outputTokens = 0;
        string? stopReason = null;

        IAsyncEnumerator<BetaRawMessageStreamEvent> events;
        try
        {
            events = client.Beta.Messages.CreateStreaming(BuildReplyParams(Model, _listenerPrompt, turns, move), ct).GetAsyncEnumerator(ct);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            LogFailure("reply", e, watch);
            throw new ConversationAiException(ConversationAiException.Failure, e);
        }

        await using (events)
        {
            while (true)
            {
                BetaRawMessageStreamEvent current;
                try
                {
                    if (!await events.MoveNextAsync())
                    {
                        break;
                    }

                    current = events.Current;
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception e)
                {
                    LogFailure("reply", e, watch);
                    throw new ConversationAiException(ConversationAiException.Failure, e);
                }

                if (current.TryPickStart(out var start))
                {
                    inputTokens = start.Message.Usage.InputTokens;
                    cacheReadTokens = start.Message.Usage.CacheReadInputTokens ?? 0;
                }
                else if (current.TryPickDelta(out var delta))
                {
                    stopReason = delta.Delta.StopReason?.Raw() ?? stopReason;
                    outputTokens = delta.Usage.OutputTokens;
                }
                else if (current.TryPickContentBlockDelta(out var blockDelta) && blockDelta.Delta.TryPickText(out var text) && text.Text.Length > 0)
                {
                    firstTextMs ??= watch.ElapsedMilliseconds;
                    yield return text.Text;
                }
            }
        }

        logger.LogInformation(
            "Claude reply finished in {ElapsedMs} ms (first text at {FirstTextMs} ms). Input {InputTokens}, cache read {CacheReadTokens}, output {OutputTokens} tokens. Stop {StopReason}.",
            watch.ElapsedMilliseconds, firstTextMs, inputTokens, cacheReadTokens, outputTokens, stopReason);

        if (stopReason == "refusal")
        {
            throw new ConversationAiException(ConversationAiException.Refusal);
        }

        if (stopReason != "end_turn")
        {
            // 途中で切れた（max_tokens など）、または終わりの知らせが届かなかった
            throw new ConversationAiException(ConversationAiException.Failure);
        }
    }

    /// <summary>読み取りのリクエスト。構造化出力で 5 つの見分けを true/false で受け取る。</summary>
    internal static MessageCreateParams BuildReadParams(string model, string systemPrompt, IReadOnlyList<Turn> turns) => new()
    {
        Model = model,
        MaxTokens = ReadMaxTokens,
        System = System(systemPrompt),
        Messages = Conversation(turns),
        OutputConfig = new BetaOutputConfig
        {
            Effort = Effort.Medium,
            Format = new BetaJsonOutputFormat { Schema = ReadingSchema() },
        },
        Fallbacks = new Default(),
        Betas = [ServerSideFallbackBeta],
    };

    /// <summary>返事のリクエスト。次の一手は、会話の最後に system メッセージで足す。</summary>
    internal static MessageCreateParams BuildReplyParams(string model, string systemPrompt, IReadOnlyList<Turn> turns, MoveKind move)
    {
        var messages = Conversation(turns);
        messages.Add(new BetaSystemMessageParam { Content = $"<next_move>{move}</next_move>" });
        return new MessageCreateParams
        {
            Model = model,
            MaxTokens = ReplyMaxTokens,
            System = System(systemPrompt),
            Messages = messages,
            OutputConfig = new BetaOutputConfig { Effort = Effort.Low },
            Fallbacks = new Default(),
            Betas = [ServerSideFallbackBeta],
        };
    }

    /// <summary>読み取りの JSON を、答えの種類に直す。読めなければ失敗として扱う。</summary>
    internal static TurnReading ParseReading(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var signals = new HashSet<AnswerSignal>();
            void Add(string name, AnswerSignal signal)
            {
                if (root.GetProperty(name).GetBoolean())
                {
                    signals.Add(signal);
                }
            }

            Add("concreteEvent", AnswerSignal.ConcreteEvent);
            Add("generalOnly", AnswerSignal.GeneralOnly);
            Add("dontKnow", AnswerSignal.DontKnow);
            Add("familyIllness", AnswerSignal.FamilyIllness);
            Add("distress", AnswerSignal.Distress);
            return new TurnReading(signals);
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            throw new ConversationAiException(ConversationAiException.Failure, e);
        }
    }

    private static List<BetaTextBlockParam> System(string prompt) =>
    [
        new BetaTextBlockParam { Text = prompt, CacheControl = new BetaCacheControlEphemeral() },
    ];

    /// <summary>
    /// ターンを user と assistant の並びにする。assistant の問いには、選択肢も区切りの行と一緒に文として含める
    /// （AI が書く形と同じにする）。最初が assistant なら、先頭に固定の user の一文を置く。同じ役が続いたらまとめる。
    /// </summary>
    private static List<BetaMessageParam> Conversation(IReadOnlyList<Turn> turns)
    {
        var merged = new List<(string Role, StringBuilder Text)>();
        if (turns.Count == 0 || turns[0].Role != TurnRoles.User)
        {
            merged.Add((TurnRoles.User, new StringBuilder(StartMessage)));
        }

        foreach (var turn in turns)
        {
            var text = turn.Role == TurnRoles.Assistant && turn.Choices is { Count: > 0 } choices
                ? turn.Text + "\n" + ReplyStreamSplitter.Delimiter + "\n" + string.Join("\n", choices.Select(c => "- " + c))
                : turn.Text;
            if (merged.Count > 0 && merged[^1].Role == turn.Role)
            {
                merged[^1].Text.Append("\n\n").Append(text);
            }
            else
            {
                merged.Add((turn.Role, new StringBuilder(text)));
            }
        }

        return merged
            .Select(m => m.Role == TurnRoles.User
                ? (BetaMessageParam)new BetaUserMessageParam { Content = m.Text.ToString() }
                : new BetaAssistantMessageParam { Content = m.Text.ToString() })
            .ToList();
    }

    private static Dictionary<string, JsonElement> ReadingSchema() => new()
    {
        ["type"] = JsonSerializer.SerializeToElement("object"),
        ["properties"] = JsonSerializer.SerializeToElement(SignalNames.ToDictionary(n => n, _ => new { type = "boolean" })),
        ["required"] = JsonSerializer.SerializeToElement(SignalNames),
        ["additionalProperties"] = JsonSerializer.SerializeToElement(false),
    };

    private void LogFailure(string role, Exception e, Stopwatch watch) =>
        // 例外の中身（メッセージ）には応答の本文が入ることがあるので、種類だけを書く
        logger.LogWarning("Claude {Role} failed after {ElapsedMs} ms: {ErrorType}.", role, watch.ElapsedMilliseconds, e.GetType().Name);
}
