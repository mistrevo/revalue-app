using System.Text;
using System.Text.Json;
using Anthropic;
using Anthropic.Models.Beta.Messages;
using Revalue.Server.Ai;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Validate;

namespace Revalue.Evals;

/// <summary>汎用の AI の答えから読み取った、一つの力について。</summary>
/// <param name="Named">その力（に当たる強み）を、強みとして挙げたか。</param>
/// <param name="Quotes">その力の根拠として、本人の言葉だとして引いた言葉。</param>
public sealed record GenericAbility(Ability Ability, bool Named, IReadOnlyList<string> Quotes);

/// <summary>汎用の AI の答えを読んだ結果。判定役に渡した力（台本に書いた力、<see cref="EpisodeScript.Listed"/>）だけを、辞書の順に 1 つずつ持つ。</summary>
public sealed record GenericReading(IReadOnlyList<GenericAbility> Abilities, string Reason);

/// <summary>
/// 汎用の AI に渡した結果。<see cref="Error"/> があれば数えない。
/// </summary>
/// <param name="Answer">汎用の AI の答え（そのまま）。</param>
/// <param name="Reading">判定役が読み取った、挙げた力と引用。</param>
public sealed record GenericResult(string? Answer, GenericReading? Reading, string? Error);

/// <summary>特別な指示もシステムプロンプトもなしに、問いを一つ渡して答えを受け取る汎用の AI。答えられなければ null。</summary>
public interface IGenericAssistant
{
    Task<string?> AnswerAsync(string prompt, CancellationToken ct);
}

/// <summary>汎用の AI の答えを読み、渡した力ごとに「強みとして挙げたか」と「根拠として引いた言葉」を返す判定役。答えられなければ null。</summary>
public interface IGenericReader
{
    /// <param name="abilities">読む力。台本に書いた力を辞書の順で渡す。</param>
    Task<GenericReading?> ReadAsync(string transcript, string answer, IReadOnlyList<Ability> abilities, CancellationToken ct);
}

/// <summary>
/// 汎用の AI との比較（03-validate.md の「評価との対応」、6-quality.md の「確かめ方」）。
/// 製品と同じやりとりを、特別な指示のない汎用の AI に渡して強みと根拠を書いてもらい、判定役が台本に書いた力だけを読み取る。
/// 引用が本人の答えに一字一句含まれるかはコードが数える。合格の線は持たせず、比べる数字として結果に残す。
/// </summary>
public sealed class GenericComparison(IGenericAssistant assistant, IGenericReader reader)
{
    /// <summary>汎用の AI に渡す問い。</summary>
    public const string Question = "この会話の利用者の強みを、根拠になる本人の言葉と一緒に教えてください。";

    public async Task<GenericResult> RunAsync(EpisodeRun run, CancellationToken ct)
    {
        var transcript = Transcript(run.Turns);
        var answer = await assistant.AnswerAsync(transcript + "\n\n" + Question, ct);
        if (string.IsNullOrWhiteSpace(answer))
        {
            return new GenericResult(null, null, "汎用の AI が答えなかった");
        }

        var reading = await reader.ReadAsync(transcript, answer, [.. run.Script.Listed.Order()], ct);
        return reading is null
            ? new GenericResult(answer, null, "判定役が答えを読めなかった")
            : new GenericResult(answer, reading, null);
    }

    /// <summary>やりとりを、聞き手と利用者の言葉だけの文にする。選択肢は渡さない。</summary>
    public static string Transcript(IReadOnlyList<Turn> turns)
    {
        var sb = new StringBuilder();
        foreach (var turn in turns)
        {
            sb.Append(turn.Role == TurnRoles.Assistant ? "聞き手: " : "利用者: ").Append(turn.Text).Append('\n');
        }

        return sb.ToString().TrimEnd();
    }

    /// <summary>
    /// 引いた言葉が、利用者の答え（選んだ答えも含む）のどれかに一字一句含まれるか。
    /// 前後の空白と、引用の印（「」『』""）は外して比べる（Claude の判断）。
    /// </summary>
    public static bool IsVerbatim(IReadOnlyList<Turn> turns, string quote)
    {
        var trimmed = quote.Trim().Trim('「', '」', '『', '』', '"', '“', '”').Trim();
        return trimmed.Length > 0
            && turns.Any(t => t.Role == TurnRoles.User && t.Text.Contains(trimmed, StringComparison.Ordinal));
    }
}

/// <summary>dry-run 用の汎用の AI。Claude を呼ばない。</summary>
public sealed class DryRunGenericAssistant : IGenericAssistant
{
    public const string Answer = "（dry-run）汎用の AI の答えの代わり。";

    public Task<string?> AnswerAsync(string prompt, CancellationToken ct) => Task.FromResult<string?>(Answer);
}

/// <summary>dry-run 用の判定役。いつも「どの力も挙げていない」と答える。Claude を呼ばない。</summary>
public sealed class DryRunGenericReader : IGenericReader
{
    public Task<GenericReading?> ReadAsync(string transcript, string answer, IReadOnlyList<Ability> abilities, CancellationToken ct) =>
        Task.FromResult<GenericReading?>(new GenericReading(abilities.Select(a => new GenericAbility(a, false, [])).ToList(), ""));
}

/// <summary>Claude を、特別な指示もシステムプロンプトもなしに呼ぶ（effort は既定）。</summary>
public sealed class ClaudeGenericAssistant(AnthropicClient client, string model, IAiUsageMeter meter) : IGenericAssistant
{
    private const int MaxTokens = 16000;

    public async Task<string?> AnswerAsync(string prompt, CancellationToken ct)
    {
        BetaMessage response;
        try
        {
            response = await client.Beta.Messages.Create(BuildParams(model, prompt), ct);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            Console.Error.WriteLine($"汎用の AI の呼び出しに失敗しました: {e.GetType().Name}");
            return null;
        }

        meter.Record(new AiUsage(
            "generic", response.Usage.InputTokens, response.Usage.CacheReadInputTokens ?? 0, response.Usage.CacheCreationInputTokens ?? 0, response.Usage.OutputTokens));
        var stopReason = response.StopReason?.Raw();
        if (stopReason != "end_turn")
        {
            Console.Error.WriteLine($"汎用の AI が答えを終えられませんでした: {stopReason}");
            return null;
        }

        return string.Concat(response.Content.Select(b => b.TryPickText(out var t) ? t.Text : ""));
    }

    internal static MessageCreateParams BuildParams(string model, string prompt) => new()
    {
        Model = model,
        MaxTokens = MaxTokens,
        Messages = new List<BetaMessageParam> { new BetaUserMessageParam { Content = prompt } },
    };
}

/// <summary>
/// 汎用の AI の答えを読む Claude の判定役（evals/judges/generic.md）。構造化出力（effort high）。
/// 読む力（名前と核となる行動の文）は、キャッシュの効くシステムの指示ではなく、会話と一緒に渡す。
/// 答えの型は、挙げた力だけの配列（<c>{ "named": [{ "ability", "quotes" }], "reason" }</c>）にする。力ごとの欄を並べると、
/// 力の数が多いときに API が型を受け付けないため。配列にない力は、挙げていないものとして読む。
/// </summary>
public sealed class ClaudeGenericReader(AnthropicClient client, string model, string prompt, IAiUsageMeter meter) : IGenericReader
{
    private const int MaxTokens = 16000;

    public async Task<GenericReading?> ReadAsync(string transcript, string answer, IReadOnlyList<Ability> abilities, CancellationToken ct)
    {
        BetaMessage response;
        try
        {
            response = await client.Beta.Messages.Create(BuildParams(model, prompt, transcript, answer, abilities), ct);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            Console.Error.WriteLine($"汎用の AI の答えを読む判定役の呼び出しに失敗しました: {e.GetType().Name}");
            return null;
        }

        meter.Record(new AiUsage(
            "genericJudge", response.Usage.InputTokens, response.Usage.CacheReadInputTokens ?? 0, response.Usage.CacheCreationInputTokens ?? 0, response.Usage.OutputTokens));
        var stopReason = response.StopReason?.Raw();
        if (stopReason != "end_turn")
        {
            Console.Error.WriteLine($"汎用の AI の答えを読む判定役が答えを終えられませんでした: {stopReason}");
            return null;
        }

        return Parse(string.Concat(response.Content.Select(b => b.TryPickText(out var t) ? t.Text : "")), abilities);
    }

    /// <summary>
    /// 判定役の JSON を読む。渡した力ごとに、配列にあれば挙げた、なければ挙げていないとする。
    /// 形が違う、渡していない力がある、同じ力が 2 回ある、のどれかなら null（読めなかったと数える）。
    /// </summary>
    internal static GenericReading? Parse(string json, IReadOnlyList<Ability> abilities)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var named = new Dictionary<Ability, IReadOnlyList<string>>();
            foreach (var item in root.GetProperty("named").EnumerateArray())
            {
                var ability = new Ability(item.GetProperty("ability").GetString() ?? "");
                var quotes = item.GetProperty("quotes").EnumerateArray().Select(q => q.GetString() ?? "").ToList();
                if (!abilities.Contains(ability) || !named.TryAdd(ability, quotes))
                {
                    Console.Error.WriteLine("汎用の AI の答えを読む判定役の答えに、渡していない力か、同じ力の重なりがありました");
                    return null;
                }
            }

            return new GenericReading(
                abilities.Select(a => named.TryGetValue(a, out var quotes) ? new GenericAbility(a, true, quotes) : new GenericAbility(a, false, [])).ToList(),
                root.GetProperty("reason").GetString() ?? "");
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            Console.Error.WriteLine($"汎用の AI の答えを読む判定役の答えを読めませんでした: {e.GetType().Name}");
            return null;
        }
    }

    /// <summary>判定役への文。会話、汎用の AI の答え、読む力（id、名前、核となる行動の文）。</summary>
    internal static string UserMessage(string transcript, string answer, IReadOnlyList<Ability> abilities)
    {
        var sb = new StringBuilder();
        sb.Append("<conversation>\n").Append(transcript).Append("\n</conversation>\n");
        sb.Append("<answer>\n").Append(answer).Append("\n</answer>\n");
        sb.Append("<abilities>\n");
        foreach (var ability in abilities)
        {
            var actions = Enumerable.Range(1, AbilityCatalog.ActionCount(ability)).Select(n => AbilityCatalog.ActionText(new ActionRef(ability, n)));
            sb.Append($"- `{ability.Id}`（{AbilityText.Name(ability)}）: 核となる行動は「{string.Join("」「", actions)}」\n");
        }

        return sb.Append("</abilities>").ToString();
    }

    internal static MessageCreateParams BuildParams(string model, string prompt, string transcript, string answer, IReadOnlyList<Ability> abilities) => new()
    {
        Model = model,
        MaxTokens = MaxTokens,
        System = new List<BetaTextBlockParam> { new() { Text = prompt, CacheControl = new BetaCacheControlEphemeral() } },
        Messages = new List<BetaMessageParam> { new BetaUserMessageParam { Content = UserMessage(transcript, answer, abilities) } },
        OutputConfig = new BetaOutputConfig
        {
            Effort = Effort.High,
            Format = new BetaJsonOutputFormat { Schema = Schema(abilities) },
        },
    };

    /// <summary>答えの型。挙げた力の配列で、力は渡した力の id の enum から選ぶ。力ごとの欄は持たない。</summary>
    internal static Dictionary<string, JsonElement> Schema(IReadOnlyList<Ability> abilities)
    {
        var item = new
        {
            type = "object",
            properties = new Dictionary<string, object>
            {
                ["ability"] = new { type = "string", @enum = abilities.Select(ActionRef.Key).ToArray() },
                ["quotes"] = new { type = "array", items = new { type = "string" } },
            },
            required = new[] { "ability", "quotes" },
            additionalProperties = false,
        };
        var properties = new Dictionary<string, object>
        {
            ["named"] = new { type = "array", items = item },
            ["reason"] = new { type = "string" },
        };
        return new Dictionary<string, JsonElement>
        {
            ["type"] = JsonSerializer.SerializeToElement("object"),
            ["properties"] = JsonSerializer.SerializeToElement(properties),
            ["required"] = JsonSerializer.SerializeToElement(new[] { "named", "reason" }),
            ["additionalProperties"] = JsonSerializer.SerializeToElement(false),
        };
    }
}
