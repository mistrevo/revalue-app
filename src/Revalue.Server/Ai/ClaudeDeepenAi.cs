using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Anthropic;
using Anthropic.Models.Beta.Messages;
using Microsoft.Extensions.Options;
using Revalue.Server.Features.Deepen;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Ai;

/// <summary>
/// 本物の深める AI（Anthropic の公式 C# SDK）。構造化出力（effort high）で、業務の見立て、問い、一歩の候補の下書きを受け取る。
/// システムプロンプトは Prompts/deepen.md の固定の文で、キャッシュの印を付ける。選んだ案、条件、記録は 1 つの user メッセージの文で渡す。
/// 根拠の本人の言葉と力の状態は渡さない（06-deepen.md の「AI が書いた中身をコードで確かめる」）。
/// ログに書くのは、かかった時間、トークン数、止まった理由、エラーの種類だけ。選んだ案と AI の答えは書かない。
/// </summary>
public sealed class ClaudeDeepenAi(
    AnthropicClient client, IOptions<ClaudeOptions> options, ILogger<ClaudeDeepenAi> logger, IAiUsageMeter? meter = null)
    : IDeepenAi
{
    private const int MaxTokens = 16000;

    private static readonly string[] TaskFields = ["name", "detail", "ability", "knowledge"];
    private static readonly string[] QuestionFields = ["situation", "ability", "choices"];
    private static readonly string[] StepFields = ["text", "hours", "place", "demandCheck"];

    private readonly string _prompt = PromptFiles.Read(PromptFiles.Deepen);

    public string Model => options.Value.Model;

    public async Task<DeepenDraft> DraftAsync(DeepenTarget target, OptionsInputs inputs, CancellationToken ct)
    {
        var watch = Stopwatch.StartNew();
        BetaMessage response;
        try
        {
            response = await client.Beta.Messages.Create(BuildParams(Model, _prompt, target, inputs), ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e)
        {
            // 例外の中身（メッセージ）には応答の本文が入ることがあるので、種類だけを書く
            logger.LogWarning("Claude deepen failed after {ElapsedMs} ms: {ErrorType}.", watch.ElapsedMilliseconds, e.GetType().Name);
            throw new ConversationAiException(ConversationAiException.Failure, e);
        }

        var stopReason = response.StopReason?.Raw();
        meter?.Record(new AiUsage(
            "deepen", response.Usage.InputTokens, response.Usage.CacheReadInputTokens ?? 0, response.Usage.CacheCreationInputTokens ?? 0, response.Usage.OutputTokens));
        logger.LogInformation(
            "Claude deepen finished in {ElapsedMs} ms. Input {InputTokens}, cache read {CacheReadTokens}, output {OutputTokens} tokens. Stop {StopReason}.",
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

    internal static MessageCreateParams BuildParams(string model, string systemPrompt, DeepenTarget target, OptionsInputs inputs) => new()
    {
        Model = model,
        MaxTokens = MaxTokens,
        System = new List<BetaTextBlockParam>
        {
            new() { Text = systemPrompt, CacheControl = new BetaCacheControlEphemeral() },
        },
        Messages = [new BetaUserMessageParam { Content = Brief(target, inputs) }],
        OutputConfig = new BetaOutputConfig
        {
            Effort = Effort.High,
            Format = new BetaJsonOutputFormat { Schema = Schema() },
        },
        Fallbacks = new Default(),
        Betas = [ClaudeConversationAi.ServerSideFallbackBeta],
    };

    /// <summary>
    /// AI に渡す 1 つの user メッセージの文。選んだ案、業務の見立てが要るか、条件、記録、話から確かめる力を、タグで区切って並べる（Claude の判断）。
    /// 根拠の本人の言葉、力の状態、カードの理由、収入の目安は入れない。
    /// </summary>
    internal static string Brief(DeepenTarget target, OptionsInputs inputs)
    {
        var sb = new StringBuilder();

        sb.Append("<target>\n");
        switch (target.Kind)
        {
            case TargetKind.Choose:
            case TargetKind.Combine:
                sb.Append("種類: ").Append(target.Kind == TargetKind.Choose ? "choose（登録している職種）" : "combine（登録している業務の組み合わせ）").Append('\n');
                sb.Append("名前: ").Append(target.Title).Append('\n');
                sb.Append("業務:\n");
                foreach (var task in target.Registered)
                {
                    sb.Append("- 名前: ").Append(task.Name).Append('\n');
                    sb.Append("  中身: ").Append(task.Detail).Append('\n');
                    sb.Append("  使う力: ").Append(ActionRef.Key(task.Ability)).Append('（').Append(AbilityText.Name(task.Ability)).Append("）\n");
                    sb.Append("  要る知識や道具: ").Append(task.Knowledge.Count == 0 ? "なし" : string.Join("、", task.Knowledge)).Append('\n');
                }

                break;
            case TargetKind.Create when target.Create is { } c:
                sb.Append("種類: create（事業のアイデア）\n");
                sb.Append("題: ").Append(c.Title).Append('\n');
                sb.Append("誰の: ").Append(c.Who).Append('\n');
                sb.Append("困りごと: ").Append(c.Trouble).Append('\n');
                sb.Append("中身: ").Append(c.Summary).Append('\n');
                sb.Append("週あたりの時間: ").Append(c.HoursPerWeek).Append(" 時間\n");
                sb.Append("場所: ").Append(c.Place == TaskPlace.Out ? "out（外に出る）" : "home（家でできる）").Append('\n');
                sb.Append("時間帯: ").Append(string.Join("、", c.TimeSlots.Select(ClaudeOptionsAi.SlotKey))).Append('\n');
                break;
            case TargetKind.Own when target.Own is { } own:
                sb.Append("種類: own（本人が書いた仕事）\n");
                sb.Append("名前: ").Append(own.Title).Append('\n');
                sb.Append("メモ: ").Append(string.IsNullOrWhiteSpace(own.Note) ? "なし" : own.Note).Append('\n');
                break;
        }

        sb.Append("</target>\n\n<needTasks>").Append(target.Drafts ? "true" : "false").Append("</needTasks>\n\n<conditions>\n");
        if (inputs.Conditions is { } conditions)
        {
            var slots = Enum.GetValues<TimeSlot>().Where(conditions.TimeSlots.Contains).ToList();
            sb.Append("使える時間帯: ")
                .Append(string.Join("、", slots.Select(s => $"{ClaudeOptionsAi.SlotKey(s)}（{ClaudeOptionsAi.SlotLabels[s]}）")))
                .Append('\n');
            sb.Append("週あたりの時間: ").Append(conditions.HoursPerWeek).Append(" 時間まで\n");
            sb.Append("場所: ").Append(conditions.Place == Place.CanGoOut ? "canGoOut（外に出ることもできる）" : "homeOnly（家でできることだけ）").Append('\n');
        }

        sb.Append("</conditions>\n\n<records>\n");
        AppendList(sb, "好み", inputs.Preferences, "まだ決めていない");
        AppendList(sb, "やりたいこと", inputs.Wants, "まだ決めていない");
        sb.Append("主体性: ").Append(string.IsNullOrWhiteSpace(inputs.Agency) ? "まだ書いていない" : inputs.Agency).Append('\n');

        sb.Append("</records>\n\n<abilities>\n");
        foreach (var ability in AbilityCatalog.Active)
        {
            sb.Append("- ").Append(ActionRef.Key(ability)).Append('（').Append(AbilityText.Name(ability)).Append("）\n");
        }

        sb.Append("</abilities>");
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
    internal static DeepenDraft ParseDraft(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            return new DeepenDraft(
                root.GetProperty("tasks").EnumerateArray()
                    .Select(t => new TaskDraft(Text(t, "name"), Text(t, "detail"), Text(t, "ability"), Text(t, "knowledge")))
                    .ToList(),
                root.GetProperty("questions").EnumerateArray()
                    .Select(q => new QuestionDraft(Text(q, "situation"), Text(q, "ability"), Texts(q, "choices")))
                    .ToList(),
                root.GetProperty("steps").EnumerateArray()
                    .Select(s => new StepDraft(Text(s, "text"), s.GetProperty("hours").GetInt32(), Text(s, "place"), s.GetProperty("demandCheck").GetBoolean()))
                    .ToList());
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        {
            throw new ConversationAiException(ConversationAiException.Failure, e);
        }

        static string Text(JsonElement e, string name) =>
            e.GetProperty(name) is { ValueKind: JsonValueKind.String } v ? v.GetString()! : throw new InvalidOperationException(name);

        static List<string> Texts(JsonElement e, string name) =>
            e.GetProperty(name).EnumerateArray()
                .Select(v => v.ValueKind == JsonValueKind.String ? v.GetString()! : throw new InvalidOperationException(name))
                .ToList();
    }

    private static Dictionary<string, JsonElement> Schema()
    {
        var abilities = new { type = "string", @enum = AbilityCatalog.Active.Select(ActionRef.Key).ToArray() };
        var text = new { type = "string" };

        object ArrayOf(string[] fields, Dictionary<string, object> properties) => new
        {
            type = "array",
            items = new Dictionary<string, object>
            {
                ["type"] = "object",
                ["properties"] = properties,
                ["required"] = fields,
                ["additionalProperties"] = false,
            },
        };

        var tasks = ArrayOf(TaskFields, new Dictionary<string, object>
        {
            ["name"] = text,
            ["detail"] = text,
            ["ability"] = abilities,
            ["knowledge"] = text,
        });
        var questions = ArrayOf(QuestionFields, new Dictionary<string, object>
        {
            ["situation"] = text,
            ["ability"] = abilities,
            ["choices"] = new { type = "array", items = text },
        });
        var steps = ArrayOf(StepFields, new Dictionary<string, object>
        {
            ["text"] = text,
            ["hours"] = new { type = "integer" },
            ["place"] = new { type = "string", @enum = new[] { "home", "out" } },
            ["demandCheck"] = new { type = "boolean" },
        });

        return new Dictionary<string, JsonElement>
        {
            ["type"] = JsonSerializer.SerializeToElement("object"),
            ["properties"] = JsonSerializer.SerializeToElement(new Dictionary<string, object> { ["tasks"] = tasks, ["questions"] = questions, ["steps"] = steps }),
            ["required"] = JsonSerializer.SerializeToElement(new[] { "tasks", "questions", "steps" }),
            ["additionalProperties"] = JsonSerializer.SerializeToElement(false),
        };
    }
}
