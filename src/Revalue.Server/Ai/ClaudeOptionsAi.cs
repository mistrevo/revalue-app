using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Anthropic;
using Anthropic.Models.Beta.Messages;
using Microsoft.Extensions.Options;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Ai;

/// <summary>
/// 本物の仕事の選択肢の AI（Anthropic の公式 C# SDK）。構造化出力（effort high）で、3 枚のカードの下書きを受け取る。
/// システムプロンプトは Prompts/options.md の固定の文で、キャッシュの印を付ける。使える力、条件、記録、候補は 1 つの user メッセージの文で渡す。
/// 断られたときに別のモデルが代わりに答えるよう、server-side fallback（既定の形）を有効にする。
/// ログに書くのは、かかった時間、トークン数、止まった理由、エラーの種類だけ。根拠の言葉と AI の答えは書かない。
/// </summary>
public sealed class ClaudeOptionsAi(
    AnthropicClient client, IOptions<ClaudeOptions> options, ILogger<ClaudeOptionsAi> logger, IAiUsageMeter? meter = null)
    : IOptionsAi
{
    private const int MaxTokens = 16000;

    private static readonly string[] ChooseFields = ["made", "occupationId", "taskIds", "ability", "reason"];
    private static readonly string[] CombineFields = ["made", "taskIds", "roleName", "ability", "reason"];
    private static readonly string[] CreateFields =
        ["made", "title", "who", "trouble", "summary", "ability", "quotes", "hoursPerWeek", "place", "timeSlots", "reason"];

    /// <summary>時間帯の、画面の言葉（src/web/src/copy.ts の profile と同じ）。</summary>
    internal static readonly IReadOnlyDictionary<TimeSlot, string> SlotLabels = new Dictionary<TimeSlot, string>
    {
        [TimeSlot.Morning] = "朝（9 時まで）",
        [TimeSlot.Daytime] = "日中（9〜15 時）",
        [TimeSlot.Evening] = "夕方（15〜18 時）",
        [TimeSlot.Night] = "夜（18 時から）",
    };

    private readonly string _prompt = PromptFiles.Read(PromptFiles.Options);

    public string Model => options.Value.Model;

    public async Task<OptionsDraft> DraftAsync(OptionsInputs inputs, OptionCandidates candidates, CancellationToken ct)
    {
        var watch = Stopwatch.StartNew();
        BetaMessage response;
        try
        {
            response = await client.Beta.Messages.Create(BuildParams(Model, _prompt, inputs, candidates), ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e)
        {
            // 例外の中身（メッセージ）には応答の本文が入ることがあるので、種類だけを書く
            logger.LogWarning("Claude options failed after {ElapsedMs} ms: {ErrorType}.", watch.ElapsedMilliseconds, e.GetType().Name);
            throw new ConversationAiException(ConversationAiException.Failure, e);
        }

        var stopReason = response.StopReason?.Raw();
        meter?.Record(new AiUsage(
            "options", response.Usage.InputTokens, response.Usage.CacheReadInputTokens ?? 0, response.Usage.CacheCreationInputTokens ?? 0, response.Usage.OutputTokens));
        logger.LogInformation(
            "Claude options finished in {ElapsedMs} ms. Input {InputTokens}, cache read {CacheReadTokens}, output {OutputTokens} tokens. Stop {StopReason}.",
            watch.ElapsedMilliseconds, response.Usage.InputTokens, response.Usage.CacheReadInputTokens, response.Usage.OutputTokens, stopReason);

        if (stopReason == "refusal")
        {
            throw new ConversationAiException(ConversationAiException.Refusal);
        }

        if (stopReason != "end_turn")
        {
            throw new ConversationAiException(ConversationAiException.Failure);
        }

        return ParseDraft(string.Concat(response.Content.Select(b => b.TryPickText(out var t) ? t.Text : "")));
    }

    internal static MessageCreateParams BuildParams(string model, string systemPrompt, OptionsInputs inputs, OptionCandidates candidates) => new()
    {
        Model = model,
        MaxTokens = MaxTokens,
        System = new List<BetaTextBlockParam>
        {
            new() { Text = systemPrompt, CacheControl = new BetaCacheControlEphemeral() },
        },
        Messages = [new BetaUserMessageParam { Content = Brief(inputs, candidates) }],
        OutputConfig = new BetaOutputConfig
        {
            Effort = Effort.High,
            Format = new BetaJsonOutputFormat { Schema = Schema() },
        },
        Fallbacks = new Default(),
        Betas = [ClaudeConversationAi.ServerSideFallbackBeta],
    };

    /// <summary>
    /// AI に渡す 1 つの user メッセージの文。使える力、条件、記録、候補、作れるカードを、タグで区切って並べる（Claude の判断）。
    /// 根拠の本人の言葉だけを「」で囲む。記録（好み、やりたいこと、主体性）は「」で囲まない。AI が理由で「」を使ってよいのは根拠の言葉だけなので。
    /// </summary>
    internal static string Brief(OptionsInputs inputs, OptionCandidates candidates)
    {
        var sb = new StringBuilder();

        sb.Append("<abilities>\n");
        foreach (var ability in inputs.Abilities)
        {
            sb.Append("- key: ").Append(ActionRef.Key(ability.Ability)).Append('\n');
            sb.Append("  名前: ").Append(AbilityText.Name(ability.Ability)).Append('\n');
            sb.Append("  状態: ").Append(ability.State == AbilityState.Confirmed ? "見えた力" : "確かめ中").Append('\n');
            sb.Append("  根拠の言葉:\n");
            foreach (var quote in ability.Quotes)
            {
                sb.Append("    「").Append(quote.Quote).Append('」');
                if (quote.FromChoice && !string.IsNullOrEmpty(quote.LinkedQuote))
                {
                    sb.Append("（選んだ答え）結びついた本人の言葉: 「").Append(quote.LinkedQuote).Append('」');
                }

                sb.Append('\n');
            }
        }

        sb.Append("</abilities>\n\n<conditions>\n");
        if (inputs.Conditions is { } c)
        {
            var slots = Enum.GetValues<TimeSlot>().Where(c.TimeSlots.Contains).ToList();
            sb.Append("使える時間帯: ").Append(string.Join("、", slots.Select(s => $"{SlotKey(s)}（{SlotLabels[s]}）"))).Append('\n');
            sb.Append("週あたりの時間: ").Append(c.HoursPerWeek).Append(" 時間まで\n");
            sb.Append("場所: ").Append(c.Place == Place.CanGoOut ? "canGoOut（外に出ることもできる）" : "homeOnly（家でできることだけ）").Append('\n');
            sb.Append("月の収入の目安: ").Append(c.MonthlyIncome is { } income ? $"{income} 万円くらい" : "まだ決めていない").Append('\n');
        }

        sb.Append("</conditions>\n\n<records>\n");
        AppendList(sb, "好み", inputs.Preferences, "まだ決めていない");
        AppendList(sb, "やりたいこと", inputs.Wants, "まだ決めていない");
        sb.Append("主体性: ").Append(string.IsNullOrWhiteSpace(inputs.Agency) ? "まだ書いていない" : inputs.Agency).Append('\n');

        sb.Append("</records>\n\n<candidates>\n");
        foreach (var occupation in candidates.Occupations)
        {
            sb.Append("## 職種 id: ").Append(occupation.Id).Append('\n');
            sb.Append("名前: ").Append(occupation.Name).Append('\n');
            sb.Append("説明: ").Append(occupation.Summary).Append('\n');
            sb.Append("条件に合う業務:\n");
            foreach (var task in occupation.Tasks)
            {
                sb.Append("- 業務 id: ").Append(task.Id).Append('\n');
                sb.Append("  名前: ").Append(task.Name).Append('\n');
                sb.Append("  中身: ").Append(task.Detail).Append('\n');
                sb.Append("  使う力: ").Append(ActionRef.Key(task.Ability)).Append('（').Append(AbilityText.Name(task.Ability)).Append("）\n");
                sb.Append("  週あたりの時間: ").Append(task.HoursPerWeek.Min).Append(" 時間から ").Append(task.HoursPerWeek.Max).Append(" 時間まで\n");
                var slots = inputs.Conditions is { } conditions ? ConditionFit.UsableSlots(task, conditions) : task.TimeSlots;
                sb.Append("  時間帯: ").Append(string.Join("、", slots.Select(SlotKey))).Append('\n');
                sb.Append("  場所: ").Append(task.Place == TaskPlace.Out ? "out（外に出る）" : "home（家でできる）").Append('\n');
            }

            sb.Append('\n');
        }

        sb.Append("</candidates>\n\n<cards>\n");
        sb.Append("choose: ").Append(candidates.CanChoose ? "作れる" : "作れない").Append('\n');
        sb.Append("combine: ").Append(candidates.CanCombine ? "作れる" : "作れない").Append('\n');
        sb.Append("create: 根拠の言葉から組み立てられるときだけ作る\n");
        sb.Append("</cards>");
        return sb.ToString();

        static void AppendList(StringBuilder sb, string label, IReadOnlyList<string> items, string empty)
        {
            if (items.Count == 0)
            {
                sb.Append(label).Append(": ").Append(empty).Append('\n');
                return;
            }

            sb.Append(label).Append(":\n");
            foreach (var item in items)
            {
                sb.Append("- ").Append(item).Append('\n');
            }
        }
    }

    /// <summary>答えの JSON を下書きに直す。形が合わなければ失敗として扱う。値の中身はコードが照らし合わせる。</summary>
    internal static OptionsDraft ParseDraft(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var choose = root.GetProperty("choose");
            var combine = root.GetProperty("combine");
            var create = root.GetProperty("create");
            return new OptionsDraft(
                new ChooseDraft(Bool(choose, "made"), Text(choose, "occupationId"), Texts(choose, "taskIds"), Text(choose, "ability"), Text(choose, "reason")),
                new CombineDraft(Bool(combine, "made"), Texts(combine, "taskIds"), Text(combine, "roleName"), Text(combine, "ability"), Text(combine, "reason")),
                new CreateDraft(
                    Bool(create, "made"),
                    Text(create, "title"),
                    Text(create, "who"),
                    Text(create, "trouble"),
                    Text(create, "summary"),
                    Text(create, "ability"),
                    Texts(create, "quotes"),
                    create.GetProperty("hoursPerWeek").GetInt32(),
                    Text(create, "place"),
                    Texts(create, "timeSlots"),
                    Text(create, "reason")));
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        {
            throw new ConversationAiException(ConversationAiException.Failure, e);
        }

        static bool Bool(JsonElement e, string name) => e.GetProperty(name).GetBoolean();

        static string Text(JsonElement e, string name) =>
            e.GetProperty(name) is { ValueKind: JsonValueKind.String } v ? v.GetString()! : throw new InvalidOperationException(name);

        static List<string> Texts(JsonElement e, string name) =>
            e.GetProperty(name).EnumerateArray()
                .Select(v => v.ValueKind == JsonValueKind.String ? v.GetString()! : throw new InvalidOperationException(name))
                .ToList();
    }

    internal static string SlotKey(TimeSlot slot) => slot switch
    {
        TimeSlot.Morning => "morning",
        TimeSlot.Daytime => "daytime",
        TimeSlot.Evening => "evening",
        _ => "night",
    };

    private static Dictionary<string, JsonElement> Schema()
    {
        var abilities = new { type = "string", @enum = Enum.GetValues<Ability>().Select(ActionRef.Key).ToArray() };
        var text = new { type = "string" };
        var texts = new { type = "array", items = text };
        var made = new { type = "boolean" };

        object Card(string[] fields, Dictionary<string, object> properties) => new Dictionary<string, object>
        {
            ["type"] = "object",
            ["properties"] = properties,
            ["required"] = fields,
            ["additionalProperties"] = false,
        };

        var choose = Card(ChooseFields, new Dictionary<string, object>
        {
            ["made"] = made,
            ["occupationId"] = text,
            ["taskIds"] = texts,
            ["ability"] = abilities,
            ["reason"] = text,
        });
        var combine = Card(CombineFields, new Dictionary<string, object>
        {
            ["made"] = made,
            ["taskIds"] = texts,
            ["roleName"] = text,
            ["ability"] = abilities,
            ["reason"] = text,
        });
        var create = Card(CreateFields, new Dictionary<string, object>
        {
            ["made"] = made,
            ["title"] = text,
            ["who"] = text,
            ["trouble"] = text,
            ["summary"] = text,
            ["ability"] = abilities,
            ["quotes"] = texts,
            ["hoursPerWeek"] = new { type = "integer" },
            ["place"] = new { type = "string", @enum = new[] { "home", "out" } },
            ["timeSlots"] = new { type = "array", items = new { type = "string", @enum = Enum.GetValues<TimeSlot>().Select(SlotKey).ToArray() } },
            ["reason"] = text,
        });

        return new Dictionary<string, JsonElement>
        {
            ["type"] = JsonSerializer.SerializeToElement("object"),
            ["properties"] = JsonSerializer.SerializeToElement(new Dictionary<string, object> { ["choose"] = choose, ["combine"] = combine, ["create"] = create }),
            ["required"] = JsonSerializer.SerializeToElement(new[] { "choose", "combine", "create" }),
            ["additionalProperties"] = JsonSerializer.SerializeToElement(false),
        };
    }
}
