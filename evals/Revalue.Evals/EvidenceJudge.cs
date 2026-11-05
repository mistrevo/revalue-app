using System.Text;
using System.Text.Json;
using Anthropic;
using Anthropic.Models.Beta.Messages;
using Revalue.Server.Ai;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Validate;

namespace Revalue.Evals;

/// <summary>根拠の判定役の答え（evals/judges/evidence.md）。</summary>
/// <param name="ActionsShown">行動ごとに、引用が本人のその行動を推し量らずに示しているか。行動の番号の順。</param>
/// <param name="SameEvent">引用がどれも、同じ一つの具体的な出来事の話か。</param>
public sealed record EvidenceVerdict(IReadOnlyList<bool> ActionsShown, bool SameEvent, string Reason);

/// <summary>根拠ありにした力 1 つと、判定役の答え。</summary>
/// <param name="Verdict">判定役が答えられなければ null（褒めすぎと数える）。</param>
public sealed record EvidenceJudgement(AbilityResult Result, EvidenceVerdict? Verdict)
{
    /// <summary>判定役が、すべての行動を示していて、同じ出来事の話だと答えたか。それ以外は褒めすぎと数える。</summary>
    public bool Passed =>
        Verdict is { SameEvent: true } v && v.ActionsShown.Count == Result.Shown.Count && v.ActionsShown.All(shown => shown);
}

/// <summary>
/// 根拠ありにした力の引用が、核となる行動を本当に示しているかを見る判定役（evals/criteria.md の「根拠の判定役」）。
/// 機械では見つけられない褒めすぎ（推し量り、本人以外の行動、仮の話、別々の出来事の言葉の組み合わせ）を見つける。答えられなければ null。
/// </summary>
public interface IEvidenceJudge
{
    /// <param name="transcript">本人の答えに番号を振った会話（<see cref="ClaudeEvidenceJudge.Transcript"/>）。</param>
    /// <param name="confirmed">根拠ありにした力。<see cref="AbilityResult.Shown"/> が行動ごとの見せる根拠。</param>
    Task<EvidenceVerdict?> JudgeAsync(string transcript, AbilityResult confirmed, CancellationToken ct);
}

/// <summary>dry-run 用の根拠の判定役。いつも、すべての行動を示していて同じ出来事だと答える。Claude を呼ばない。</summary>
public sealed class DryRunEvidenceJudge : IEvidenceJudge
{
    public Task<EvidenceVerdict?> JudgeAsync(string transcript, AbilityResult confirmed, CancellationToken ct) =>
        Task.FromResult<EvidenceVerdict?>(new EvidenceVerdict(confirmed.Shown.Select(_ => true).ToList(), true, ""));
}

/// <summary>
/// Claude の根拠の判定役。構造化出力（effort high）で、行動ごとの <c>shown</c> と <c>sameEvent</c> を受け取る。
/// 答えの型は、行動の配列にする（力ごとの欄を持たない。力の数で型が大きくならないため）。
/// </summary>
public sealed class ClaudeEvidenceJudge(AnthropicClient client, string model, string prompt, IAiUsageMeter meter) : IEvidenceJudge
{
    private const int MaxTokens = 16000;

    /// <summary>答えの項目。evidence.md に、すべて書く。</summary>
    internal static readonly string[] Fields = ["actions", "number", "shown", "sameEvent", "reason"];

    public async Task<EvidenceVerdict?> JudgeAsync(string transcript, AbilityResult confirmed, CancellationToken ct)
    {
        BetaMessage response;
        try
        {
            response = await client.Beta.Messages.Create(BuildParams(model, prompt, transcript, confirmed), ct);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            Console.Error.WriteLine($"根拠の判定役の呼び出しに失敗しました: {e.GetType().Name}");
            return null;
        }

        meter.Record(new AiUsage(
            "evidenceJudge", response.Usage.InputTokens, response.Usage.CacheReadInputTokens ?? 0, response.Usage.CacheCreationInputTokens ?? 0,
            response.Usage.OutputTokens));
        var stopReason = response.StopReason?.Raw();
        if (stopReason != "end_turn")
        {
            Console.Error.WriteLine($"根拠の判定役が答えを終えられませんでした: {stopReason}");
            return null;
        }

        return Parse(string.Concat(response.Content.Select(b => b.TryPickText(out var t) ? t.Text : "")), confirmed.Shown.Count);
    }

    /// <summary>判定役の JSON を読む。形が違うか、行動の番号 1〜<paramref name="actionCount"/> がちょうど 1 回ずつでなければ null。</summary>
    internal static EvidenceVerdict? Parse(string json, int actionCount)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var byNumber = new Dictionary<int, bool>();
            foreach (var item in root.GetProperty("actions").EnumerateArray())
            {
                if (!byNumber.TryAdd(item.GetProperty("number").GetInt32(), item.GetProperty("shown").GetBoolean()))
                {
                    return null;
                }
            }

            if (byNumber.Count != actionCount || Enumerable.Range(1, actionCount).Any(n => !byNumber.ContainsKey(n)))
            {
                return null;
            }

            return new EvidenceVerdict(
                Enumerable.Range(1, actionCount).Select(n => byNumber[n]).ToList(),
                root.GetProperty("sameEvent").GetBoolean(),
                root.GetProperty("reason").GetString() ?? "");
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        {
            Console.Error.WriteLine($"根拠の判定役の答えを読めませんでした: {e.GetType().Name}");
            return null;
        }
    }

    /// <summary>
    /// 判定役に渡す会話の文。読み取り（<c>reader.md</c>）と同じく、本人の答えに番号（本人の答えだけを 1 から数える）と答え方を付ける（Claude の判断）。
    /// </summary>
    public static string Transcript(IReadOnlyList<Turn> turns)
    {
        var parts = new List<string>();
        var answer = 0;
        foreach (var turn in turns)
        {
            if (turn.Role == TurnRoles.User)
            {
                answer++;
                var how = turn.AnswerKind switch
                {
                    AnswerKind.Choice => "選択肢から選んだ",
                    AnswerKind.Correction => "訂正",
                    _ => "自由に書いた",
                };
                parts.Add($"[答え {answer}]（{how}）{turn.Text}");
            }
            else
            {
                parts.Add(turn.Choices is { Count: > 0 } choices
                    ? $"聞き手: {turn.Text}\n（答えの例: {string.Join(" / ", choices)}）"
                    : $"聞き手: {turn.Text}");
            }
        }

        return string.Join("\n\n", parts);
    }

    /// <summary>判定役への文。会話、力の名前と理由、行動ごとに行動の文と、その行動の根拠として見せる引用（選んだ答えなら結びついた言葉も）。</summary>
    internal static string UserMessage(string transcript, AbilityResult confirmed)
    {
        var entry = AbilityCatalog.Find(confirmed.Ability.Id);
        var sb = new StringBuilder("<conversation>\n").Append(transcript).Append("\n</conversation>\n");
        sb.Append("<ability>\n");
        sb.Append("名前: ").Append(entry?.Name ?? confirmed.Ability.Id).Append('\n');
        sb.Append("理由: ").Append(entry?.Reason ?? "").Append('\n');
        sb.Append("</ability>\n<actions>\n");
        foreach (var evidence in confirmed.Shown)
        {
            var action = new ActionRef(confirmed.Ability, evidence.Action);
            sb.Append($"<action number=\"{evidence.Action}\">\n");
            sb.Append("行動: ").Append(AbilityCatalog.ActionText(action)).Append('\n');
            sb.Append($"引用: 「{evidence.Quote}」（[答え {evidence.Answer}]）\n");
            if (evidence.FromChoice)
            {
                sb.Append($"選んだ答えの引用。結びついた本人の言葉: 「{evidence.LinkedQuote}」\n");
            }

            sb.Append("</action>\n");
        }

        return sb.Append("</actions>").ToString();
    }

    internal static MessageCreateParams BuildParams(string model, string prompt, string transcript, AbilityResult confirmed) => new()
    {
        Model = model,
        MaxTokens = MaxTokens,
        System = new List<BetaTextBlockParam> { new() { Text = prompt, CacheControl = new BetaCacheControlEphemeral() } },
        Messages = new List<BetaMessageParam> { new BetaUserMessageParam { Content = UserMessage(transcript, confirmed) } },
        OutputConfig = new BetaOutputConfig
        {
            Effort = Effort.High,
            Format = new BetaJsonOutputFormat { Schema = Schema() },
        },
    };

    internal static Dictionary<string, JsonElement> Schema()
    {
        var action = new
        {
            type = "object",
            properties = new Dictionary<string, object>
            {
                ["number"] = new { type = "integer" },
                ["shown"] = new { type = "boolean" },
            },
            required = new[] { "number", "shown" },
            additionalProperties = false,
        };
        var properties = new Dictionary<string, object>
        {
            ["actions"] = new { type = "array", items = action },
            ["sameEvent"] = new { type = "boolean" },
            ["reason"] = new { type = "string" },
        };
        return new Dictionary<string, JsonElement>
        {
            ["type"] = JsonSerializer.SerializeToElement("object"),
            ["properties"] = JsonSerializer.SerializeToElement(properties),
            ["required"] = JsonSerializer.SerializeToElement(new[] { "actions", "sameEvent", "reason" }),
            ["additionalProperties"] = JsonSerializer.SerializeToElement(false),
        };
    }
}
