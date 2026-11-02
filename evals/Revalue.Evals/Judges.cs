using System.Text;
using System.Text.Json;
using Anthropic;
using Anthropic.Models.Beta.Messages;
using Revalue.Server.Ai;
using Revalue.Server.Features.Discover;

namespace Revalue.Evals;

/// <summary>判定役の答え。項目は evals/judges/discover.md に合わせる。</summary>
public sealed record JudgeVerdict(
    bool AcknowledgedFirst,
    bool SingleQuestion,
    bool ConcreteQuestion,
    bool EasierScene,
    bool NoInventedActions,
    bool NoIllnessDetails,
    bool NoOverPraise,
    bool NoDismissal,
    bool ReflectedActions,
    bool NoTraitLabel,
    bool MissingOnly,
    string Reason);

/// <summary>返事を判定する役。答えられなかったときは null を返す（評価では、問題があったと数える）。</summary>
public interface IReplyJudge
{
    /// <param name="conversation">ここまでのやりとり。最後は、いま届いた利用者の答え。</param>
    /// <param name="hint">足りない行動を聞く一手のとき、聞き手に渡した行動の手がかり。ほかの一手では null。</param>
    /// <param name="choices">返事と一緒に出した選択肢（答えの例）。締めの返事では空。</param>
    Task<JudgeVerdict?> JudgeAsync(
        IReadOnlyList<Turn> conversation, MoveKind move, string? hint, string reply, IReadOnlyList<string> choices, CancellationToken ct);
}

/// <summary>dry-run 用の偽の判定役。いつも「問題なし」と答える。Claude を呼ばない。</summary>
public sealed class DryRunJudge : IReplyJudge
{
    public Task<JudgeVerdict?> JudgeAsync(
        IReadOnlyList<Turn> conversation, MoveKind move, string? hint, string reply, IReadOnlyList<string> choices, CancellationToken ct) =>
        Task.FromResult<JudgeVerdict?>(new JudgeVerdict(true, true, true, true, true, true, true, true, true, true, true, ""));
}

/// <summary>Claude の判定役。構造化出力（effort high）で、項目ごとに true か false を受け取る。</summary>
public sealed class ClaudeJudge(AnthropicClient client, string model, string prompt, IAiUsageMeter meter) : IReplyJudge
{
    private const int MaxTokens = 16000;

    private static readonly string[] BooleanFields =
    [
        "acknowledgedFirst", "singleQuestion", "concreteQuestion", "easierScene", "noInventedActions", "noIllnessDetails", "noOverPraise",
        "noDismissal", "reflectedActions", "noTraitLabel", "missingOnly",
    ];

    public async Task<JudgeVerdict?> JudgeAsync(
        IReadOnlyList<Turn> conversation, MoveKind move, string? hint, string reply, IReadOnlyList<string> choices, CancellationToken ct)
    {
        BetaMessage response;
        try
        {
            response = await client.Beta.Messages.Create(BuildParams(model, prompt, conversation, move, hint, reply, choices), ct);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            Console.Error.WriteLine($"判定役の呼び出しに失敗しました: {e.GetType().Name}");
            return null;
        }

        meter.Record(new AiUsage(
            "judge", response.Usage.InputTokens, response.Usage.CacheReadInputTokens ?? 0, response.Usage.CacheCreationInputTokens ?? 0, response.Usage.OutputTokens));
        var stopReason = response.StopReason?.Raw();
        if (stopReason != "end_turn")
        {
            Console.Error.WriteLine($"判定役が答えを終えられませんでした: {stopReason}");
            return null;
        }

        var text = string.Concat(response.Content.Select(b => b.TryPickText(out var t) ? t.Text : ""));
        try
        {
            using var document = JsonDocument.Parse(text);
            var root = document.RootElement;
            bool Get(string name) => root.GetProperty(name).GetBoolean();
            return new JudgeVerdict(
                Get("acknowledgedFirst"), Get("singleQuestion"), Get("concreteQuestion"), Get("easierScene"), Get("noInventedActions"),
                Get("noIllnessDetails"), Get("noOverPraise"), Get("noDismissal"), Get("reflectedActions"), Get("noTraitLabel"), Get("missingOnly"),
                root.GetProperty("reason").GetString() ?? "");
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            Console.Error.WriteLine($"判定役の答えを読めませんでした: {e.GetType().Name}");
            return null;
        }
    }

    internal static MessageCreateParams BuildParams(
        string model, string prompt, IReadOnlyList<Turn> conversation, MoveKind move, string? hint, string reply, IReadOnlyList<string> choices) => new()
    {
        Model = model,
        MaxTokens = MaxTokens,
        System = new List<BetaTextBlockParam> { new() { Text = prompt, CacheControl = new BetaCacheControlEphemeral() } },
        Messages = new List<BetaMessageParam> { new BetaUserMessageParam { Content = UserMessage(conversation, move, hint, reply, choices) } },
        OutputConfig = new BetaOutputConfig
        {
            Effort = Effort.High,
            Format = new BetaJsonOutputFormat { Schema = Schema() },
        },
    };

    internal static string UserMessage(IReadOnlyList<Turn> conversation, MoveKind move, string? hint, string reply, IReadOnlyList<string> choices)
    {
        var sb = new StringBuilder("<conversation>\n");
        foreach (var turn in conversation)
        {
            if (turn.Role == TurnRoles.Assistant)
            {
                sb.Append("AI: ").Append(turn.Text).Append('\n');
                if (turn.Choices is { Count: > 0 } shown)
                {
                    sb.Append("（選択肢: ").Append(string.Join(" / ", shown)).Append("）\n");
                }
            }
            else
            {
                sb.Append("利用者: ").Append(turn.Text);
                sb.Append(turn.AnswerKind switch
                {
                    AnswerKind.Choice => "（選択肢から選んだ）\n",
                    AnswerKind.Correction => "（訂正）\n",
                    _ => "\n",
                });
            }
        }

        sb.Append("</conversation>\n");
        sb.Append("<next_move>").Append(TalkStream.MoveName(move)).Append("</next_move>\n");
        if (hint is not null)
        {
            sb.Append("<hint>").Append(hint).Append("</hint>\n");
        }

        sb.Append("<reply>\n").Append(reply).Append("\n</reply>");
        if (choices.Count > 0)
        {
            sb.Append("\n<choices>\n");
            foreach (var choice in choices)
            {
                sb.Append("- ").Append(choice).Append('\n');
            }

            sb.Append("</choices>");
        }

        return sb.ToString();
    }

    private static Dictionary<string, JsonElement> Schema()
    {
        var properties = BooleanFields.ToDictionary(n => n, _ => (object)new { type = "boolean" });
        properties["reason"] = new { type = "string" };
        return new Dictionary<string, JsonElement>
        {
            ["type"] = JsonSerializer.SerializeToElement("object"),
            ["properties"] = JsonSerializer.SerializeToElement(properties),
            ["required"] = JsonSerializer.SerializeToElement(BooleanFields.Append("reason").ToArray()),
            ["additionalProperties"] = JsonSerializer.SerializeToElement(false),
        };
    }
}
