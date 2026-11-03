using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Anthropic;
using Anthropic.Models.Beta.Messages;
using Revalue.Server.Ai;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Evals;

/// <summary>カード 1 枚への判定役の答え。項目は evals/judges/options.md に合わせる。</summary>
public sealed record CardVerdict(bool Decides, bool OverPraise, bool PushesAway, bool Grounded, string Reason, bool ThirdPerson = false);

/// <summary>仕事のカードを判定する役。答えられなかったときは null を返す（評価では、問題があったと数える）。</summary>
public interface IOptionsJudge
{
    /// <param name="record">本人の記録（<see cref="OptionsEval.RecordText"/>）。</param>
    /// <param name="card">画面に出すカードの文（<see cref="OptionsEval.CardText"/>）。</param>
    Task<CardVerdict?> JudgeAsync(string record, string card, CancellationToken ct);
}

/// <summary>汎用の AI が出した仕事の選択肢 1 つを、判定役が読み取ったもの。</summary>
/// <param name="Quotes">本人の言葉だとして引いた言葉。</param>
public sealed record GenericOption(string Title, bool OverConditions, bool Decides, bool Ranked, IReadOnlyList<string> Quotes);

public sealed record GenericOptionsReading(IReadOnlyList<GenericOption> Options, string Reason);

/// <summary>汎用の AI の仕事の選択肢を読む判定役。答えられなければ null。</summary>
public interface IGenericOptionsReader
{
    Task<GenericOptionsReading?> ReadAsync(string record, string answer, CancellationToken ct);
}

/// <summary>汎用の AI に渡した結果。<see cref="Error"/> があれば数えない。</summary>
public sealed record GenericOptionsResult(string? Answer, GenericOptionsReading? Reading, string? Error);

/// <summary>照らし合わせの前の AI の答えを、機械で数えたもの（参考）。</summary>
/// <param name="Unregistered">登録にない職種や業務の ID、その職種のものでない業務を返したカードの数。</param>
/// <param name="OverConditions">登録にはあるが条件に合わない業務、始めやすさの合計が本人の時間を超える組み合わせ、条件の外の「創る」の数。</param>
/// <param name="NoEvidenceCreate">本人の根拠を一字一句引けていない「創る」の数。</param>
public sealed record DraftCounts(int Unregistered, int OverConditions, int NoEvidenceCreate);

/// <summary>画面に出すカード 1 枚を、評価が数え直したもの。</summary>
public sealed record CardCheck(
    CardKind Kind,
    string Text,
    AbilityState State,
    Ability Ability,
    bool Unregistered,
    bool OverConditions,
    bool NoEvidence,
    int QuoteCount,
    IReadOnlyList<string> QuoteMismatches,
    IReadOnlyList<string> Forbidden,
    IReadOnlyList<string> Assertive,
    CardVerdict? Verdict = null);

/// <summary>架空の記録 1 件を流した結果。<see cref="Error"/> があれば、AI が失敗・拒否して途中で終えた。</summary>
public sealed record OptionsRun(
    ProfileCase Case,
    OptionCandidates Candidates,
    OptionsDraft? Draft,
    IReadOnlyList<CardRejection> Rejections,
    OptionCards? Cards,
    DraftCounts Before,
    IReadOnlyList<CardCheck> Shown,
    GenericOptionsResult? Generic,
    string? Error);

/// <summary>
/// 仕事の選択肢の評価（05-options.md の「評価との対応」、evals/criteria.md の「仕事の選択肢」）。
/// 製品と同じ候補づくり（<see cref="OptionCandidates"/>）、AI、照らし合わせ（<see cref="OptionsValidator"/>）を通し、
/// 照らし合わせの前の AI の答えと、画面に出すカードの両方を機械で数える。画面に出すカードは判定役も見る。
/// 同じ記録を汎用の AI にも渡して比べる。
/// </summary>
public sealed partial class OptionsEval(
    IOptionsAi ai,
    IOptionsJudge judge,
    IGenericAssistant generic,
    IGenericOptionsReader genericReader,
    JobCatalog catalog,
    ForbiddenWords forbidden)
{
    /// <summary>汎用の AI に渡す問い。</summary>
    public const string GenericQuestion = "この人に合う仕事の選択肢を 3 つ、理由と一緒に教えてください。";

    private static readonly DateTimeOffset GeneratedAt = DateTimeOffset.UnixEpoch;

    [GeneratedRegex("「([^」]*)」")]
    private static partial Regex BracketPattern();

    public async Task<OptionsRun> RunAsync(ProfileCase profile, CancellationToken ct)
    {
        var inputs = profile.Inputs;
        var candidates = OptionCandidates.From(catalog, inputs);
        var none = new DraftCounts(0, 0, 0);
        OptionsDraft draft;
        try
        {
            draft = await ai.DraftAsync(inputs, candidates, ct);
        }
        catch (ConversationAiException e)
        {
            return new OptionsRun(profile, candidates, null, [], null, none, [], null, $"AI が答えなかった（{e.Kind}）");
        }

        var (cards, rejections) = OptionsValidator.Build(draft, candidates, inputs, catalog, ForbiddenWordList.Load(), GeneratedAt);
        var record = RecordText(inputs);
        var shown = new List<CardCheck>();
        foreach (var card in new object?[] { cards.Choose, cards.Combine, cards.Create })
        {
            if (card is null)
            {
                continue;
            }

            var check = CheckShown(card, inputs, catalog, forbidden);
            shown.Add(check with { Verdict = await judge.JudgeAsync(record, check.Text, ct) });
        }

        var genericResult = await RunGenericAsync(inputs, record, ct);
        return new OptionsRun(profile, candidates, draft, rejections, cards, CountDraft(draft, candidates, inputs, catalog, rejections), shown, genericResult, null);
    }

    private async Task<GenericOptionsResult> RunGenericAsync(OptionsInputs inputs, string record, CancellationToken ct)
    {
        var answer = await generic.AnswerAsync(GenericPrompt(inputs), ct);
        if (string.IsNullOrWhiteSpace(answer))
        {
            return new GenericOptionsResult(null, null, "汎用の AI が答えなかった");
        }

        var reading = await genericReader.ReadAsync(record, answer, ct);
        return reading is null
            ? new GenericOptionsResult(answer, null, "判定役が答えを読めなかった")
            : new GenericOptionsResult(answer, reading, null);
    }

    /// <summary>汎用の AI に渡す文。本人の記録と問いだけ。登録した職種や候補は渡さない。</summary>
    public static string GenericPrompt(OptionsInputs inputs) => RecordText(inputs) + "\n\n" + GenericQuestion;

    /// <summary>照らし合わせの前の AI の答えを数える。作ると答えたカードだけを見る。</summary>
    public static DraftCounts CountDraft(
        OptionsDraft draft, OptionCandidates candidates, OptionsInputs inputs, JobCatalog catalog, IReadOnlyList<CardRejection> rejections)
    {
        var conditions = inputs.Conditions!;
        var unregistered = 0;
        var over = 0;
        bool Candidate(JobTask t) => candidates.Tasks.Any(c => c.Id == t.Id);

        if (draft.Choose.Made)
        {
            var occupation = catalog.FindOccupation(draft.Choose.OccupationId);
            var tasks = draft.Choose.TaskIds.Select(catalog.FindTask).ToList();
            if (occupation is null || tasks.Any(t => t is null) || tasks.Any(t => catalog.OccupationOf(t!).Id != occupation.Id))
            {
                unregistered++;
            }
            else if (tasks.Any(t => !Candidate(t!)))
            {
                over++;
            }
        }

        if (draft.Combine.Made)
        {
            var tasks = draft.Combine.TaskIds.Select(catalog.FindTask).ToList();
            if (tasks.Any(t => t is null))
            {
                unregistered++;
            }
            else if (tasks.Any(t => !Candidate(t!)) || !ConditionFit.CombineFits(tasks.Select(t => t!).ToList(), conditions))
            {
                over++;
            }
        }

        if (draft.Create.Made)
        {
            var place = draft.Create.Place switch { "home" => TaskPlace.Home, "out" => TaskPlace.Out, _ => (TaskPlace?)null };
            var slots = draft.Create.TimeSlots.Select(SlotOf).ToList();
            if (draft.Create.HoursPerWeek < 1
                || draft.Create.HoursPerWeek > conditions.HoursPerWeek
                || place is not { } p
                || !ConditionFit.PlaceFits(p, conditions.Place)
                || slots.Count == 0
                || slots.Any(s => s is not { } slot || !conditions.TimeSlots.Contains(slot)))
            {
                over++;
            }
        }

        var noEvidence = rejections.Count(r => r.Kind == CardKind.Create && r.Rule == "quoteNotVerbatim");
        return new DraftCounts(unregistered, over, noEvidence);
    }

    /// <summary>
    /// 画面に出すカード 1 枚を、照らし合わせとは別に数え直す。登録、条件、「創る」の根拠、引用が本人の言葉と一字一句同じか、使わない言葉、
    /// 言い切りと順位の言葉（<see cref="OptionsValidator.AssertiveWords"/>。「」で引いた本人の言葉の中は数えない）。
    /// </summary>
    public static CardCheck CheckShown(object card, OptionsInputs inputs, JobCatalog catalog, ForbiddenWords forbidden)
    {
        var conditions = inputs.Conditions!;
        var evidenceWords = inputs.Abilities.SelectMany(a => a.Quotes).SelectMany(q => new[] { q.Quote, q.LinkedQuote }).OfType<string>().ToList();

        (CardKind Kind, CardAbility Ability, string[] Sentences, bool Unregistered, bool Over, bool NoEvidence) parts = card switch
        {
            ChooseCard c => (
                CardKind.Choose, c.Ability, [c.Reason],
                catalog.FindOccupation(c.OccupationId) is null
                    || c.Tasks.Any(t => catalog.FindTask(t.TaskId) is not { } task || catalog.OccupationOf(task).Id != c.OccupationId),
                c.Tasks.Any(t => catalog.FindTask(t.TaskId) is { } task && !ConditionFit.Fits(task, conditions)),
                false),
            CombineCard c => (
                CardKind.Combine, c.Ability, [c.RoleName, c.Reason],
                c.Tasks.Any(t => catalog.FindTask(t.TaskId) is null),
                c.Tasks.Select(t => catalog.FindTask(t.TaskId)).ToList() is var tasks && tasks.All(t => t is not null)
                    && !ConditionFit.CombineFits(tasks.Select(t => t!).ToList(), conditions),
                false),
            CreateCard c => (
                CardKind.Create, c.Ability, [c.Title, c.Who, c.Trouble, c.Summary, c.Reason],
                false,
                c.HoursPerWeek < 1 || c.HoursPerWeek > conditions.HoursPerWeek || !ConditionFit.PlaceFits(c.Place, conditions.Place)
                    || c.TimeSlots.Count == 0 || !c.TimeSlots.All(conditions.TimeSlots.Contains),
                c.Ability.Quotes.Count == 0 || !c.Ability.Quotes.All(q => IsEvidence(inputs, c.Ability.Ability, q))),
            _ => throw new ArgumentException("カードではありません。", nameof(card)),
        };

        var mismatches = new List<string>();
        var quoteCount = parts.Ability.Quotes.Count;
        foreach (var quote in parts.Ability.Quotes.Where(q => !IsEvidence(inputs, parts.Ability.Ability, q)))
        {
            mismatches.Add(quote.Quote);
        }

        foreach (var sentence in parts.Sentences)
        {
            foreach (Match match in BracketPattern().Matches(sentence))
            {
                quoteCount++;
                var inside = match.Groups[1].Value;
                if (inside.Length == 0 || !evidenceWords.Any(w => w.Contains(inside, StringComparison.Ordinal)))
                {
                    mismatches.Add(inside);
                }
            }
        }

        // 力の名前（「優先順位をつける力」の「順位」）は使わない言葉として数えない
        var written = string.Join("\n", parts.Sentences);
        foreach (var ability in Enum.GetValues<Ability>())
        {
            written = written.Replace(AbilityText.Name(ability), "", StringComparison.Ordinal);
        }

        var outside = parts.Sentences.Select(s => BracketPattern().Replace(s, "")).ToList();
        var assertive = OptionsValidator.AssertiveWords.Where(w => outside.Any(s => s.Contains(w, StringComparison.Ordinal))).ToList();

        return new CardCheck(
            parts.Kind,
            CardText(card),
            parts.Ability.State,
            parts.Ability.Ability,
            parts.Unregistered,
            parts.Over,
            parts.NoEvidence,
            quoteCount,
            mismatches,
            forbidden.Find(written),
            assertive);
    }

    /// <summary>その力の、本人の根拠の言葉（と選んだ答えか・結びついた言葉）と一字一句同じか。</summary>
    private static bool IsEvidence(OptionsInputs inputs, Ability ability, Evidence quote) =>
        inputs.Abilities.Any(a => a.Ability == ability
            && a.Quotes.Any(e => e.Quote == quote.Quote && e.FromChoice == quote.FromChoice && e.LinkedQuote == quote.LinkedQuote));

    /// <summary>本人の記録を、人が読む文にする。判定役と汎用の AI に渡す。登録の ID は入れない。</summary>
    public static string RecordText(OptionsInputs inputs)
    {
        var sb = new StringBuilder();
        sb.AppendLine("力と、根拠になる本人の言葉:");
        foreach (var ability in inputs.Abilities)
        {
            sb.AppendLine($"- {AbilityText.Name(ability.Ability)}（{StateText(ability.State)}）");
            foreach (var quote in ability.Quotes)
            {
                sb.AppendLine(quote.FromChoice && quote.LinkedQuote is { } linked
                    ? $"  - 「{quote.Quote}」（選んだ答え。結びついた本人の言葉: 「{linked}」）"
                    : $"  - 「{quote.Quote}」");
            }
        }

        if (inputs.Conditions is { } c)
        {
            sb.AppendLine("使える時間帯: " + string.Join("、", Enum.GetValues<TimeSlot>().Where(c.TimeSlots.Contains).Select(SlotText)));
            sb.AppendLine($"週あたりの時間: {c.HoursPerWeek} 時間まで");
            sb.AppendLine("場所: " + (c.Place == Place.CanGoOut ? "外に出ることもできる" : "家でできることだけ"));
            sb.AppendLine("月の収入の目安: " + (c.MonthlyIncome is { } income ? $"{income} 万円くらい" : "まだ決めていない"));
        }

        sb.AppendLine("好み: " + (inputs.Preferences.Count == 0 ? "まだ決めていない" : string.Join("、", inputs.Preferences)));
        sb.AppendLine("やりたいこと: " + (inputs.Wants.Count == 0 ? "まだ決めていない" : string.Join("、", inputs.Wants)));
        sb.Append("主体性: " + (string.IsNullOrWhiteSpace(inputs.Agency) ? "まだ書いていない" : inputs.Agency));
        return sb.ToString();
    }

    /// <summary>画面に出すカードの文。判定役に渡し、結果のファイルにも載せる。</summary>
    public static string CardText(object card)
    {
        var sb = new StringBuilder();
        void Ability(CardAbility a)
        {
            sb.AppendLine($"使った力: {AbilityText.Name(a.Ability)}（{StateText(a.State)}）");
            foreach (var q in a.Quotes)
            {
                sb.AppendLine(q.FromChoice && q.LinkedQuote is { } linked ? $"- 「{q.Quote}」（選んだ答え）「{linked}」" : $"- 「{q.Quote}」");
            }
        }

        void Tasks(IReadOnlyList<CardTask> tasks)
        {
            foreach (var t in tasks)
            {
                sb.AppendLine($"- {t.OccupationName}: {t.Name}（{t.Detail}）。{string.Join("、", t.TimeSlots.Select(SlotText))}、{PlaceText(t.Place)}");
            }
        }

        static string Range(WorkRange r) =>
            $"週 {r.MinHours}〜{r.MaxHours} 時間くらい、月 {r.MinMonthlyYen:N0}〜{r.MaxMonthlyYen:N0} 円くらい";

        switch (card)
        {
            case ChooseCard c:
                sb.AppendLine($"【選ぶ】{c.OccupationName}（{c.Summary}）");
                Tasks(c.Tasks);
                sb.AppendLine(Range(c.Range));
                sb.AppendLine($"理由: {c.Reason}");
                Ability(c.Ability);
                break;
            case CombineCard c:
                sb.AppendLine($"【組み合わせる】{c.RoleName}");
                Tasks(c.Tasks);
                sb.AppendLine(Range(c.Range));
                sb.AppendLine($"理由: {c.Reason}");
                Ability(c.Ability);
                break;
            case CreateCard c:
                sb.AppendLine($"【創る】{c.Title}");
                sb.AppendLine($"誰の: {c.Who}");
                sb.AppendLine($"どんな困りごとを: {c.Trouble}");
                sb.AppendLine($"中身: {c.Summary}");
                sb.AppendLine($"どの条件で: 週 {c.HoursPerWeek} 時間くらい、{string.Join("、", c.TimeSlots.Select(SlotText))}、{PlaceText(c.Place)}");
                sb.AppendLine("（事業のアイデアで、需要はまだ確かめていません。）");
                sb.AppendLine($"理由: {c.Reason}");
                Ability(c.Ability);
                break;
        }

        return sb.ToString().TrimEnd();
    }

    private static string StateText(AbilityState state) => state == AbilityState.Confirmed ? "あなたの話から見えた力" : "確かめ中";

    private static string PlaceText(TaskPlace place) => place == TaskPlace.Out ? "外に出る" : "家でできる";

    private static string SlotText(TimeSlot slot) => slot switch
    {
        TimeSlot.Morning => "朝（9 時まで）",
        TimeSlot.Daytime => "日中（9〜15 時）",
        TimeSlot.Evening => "夕方（15〜18 時）",
        _ => "夜（18 時から）",
    };

    private static TimeSlot? SlotOf(string name) => name switch
    {
        "morning" => TimeSlot.Morning,
        "daytime" => TimeSlot.Daytime,
        "evening" => TimeSlot.Evening,
        "night" => TimeSlot.Night,
        _ => null,
    };
}

/// <summary>dry-run 用の判定役。いつも「問題なし」と答える。Claude を呼ばない。</summary>
public sealed class DryRunOptionsJudge : IOptionsJudge
{
    public Task<CardVerdict?> JudgeAsync(string record, string card, CancellationToken ct) =>
        Task.FromResult<CardVerdict?>(new CardVerdict(false, false, false, true, ""));
}

/// <summary>dry-run 用の、汎用の AI の答えを読む判定役。いつも「案なし」と答える。Claude を呼ばない。</summary>
public sealed class DryRunGenericOptionsReader : IGenericOptionsReader
{
    public Task<GenericOptionsReading?> ReadAsync(string record, string answer, CancellationToken ct) =>
        Task.FromResult<GenericOptionsReading?>(new GenericOptionsReading([], ""));
}

/// <summary>Claude の、仕事のカードの判定役（evals/judges/options.md）。構造化出力（effort high）。</summary>
public sealed class ClaudeOptionsJudge(AnthropicClient client, string model, string prompt, IAiUsageMeter meter) : IOptionsJudge
{
    private const int MaxTokens = 16000;

    private static readonly string[] BooleanFields = ["decides", "overPraise", "pushesAway", "grounded", "thirdPerson"];

    public async Task<CardVerdict?> JudgeAsync(string record, string card, CancellationToken ct)
    {
        var text = await ClaudeJson.CallAsync(client, BuildParams(model, prompt, record, card), meter, "optionsJudge", "仕事のカードの判定役", ct);
        if (text is null)
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(text);
            var root = document.RootElement;
            bool Get(string name) => root.GetProperty(name).GetBoolean();
            return new CardVerdict(
                Get("decides"), Get("overPraise"), Get("pushesAway"), Get("grounded"), root.GetProperty("reason").GetString() ?? "", Get("thirdPerson"));
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            Console.Error.WriteLine($"仕事のカードの判定役の答えを読めませんでした: {e.GetType().Name}");
            return null;
        }
    }

    internal static MessageCreateParams BuildParams(string model, string prompt, string record, string card) =>
        ClaudeJson.Params(model, prompt, $"<record>\n{record}\n</record>\n<card>\n{card}\n</card>", MaxTokens, Schema());

    private static Dictionary<string, JsonElement> Schema()
    {
        var properties = BooleanFields.ToDictionary(n => n, _ => (object)new { type = "boolean" });
        properties["reason"] = new { type = "string" };
        return ClaudeJson.ObjectSchema(properties, BooleanFields.Append("reason").ToArray());
    }
}

/// <summary>汎用の AI の仕事の選択肢を読む Claude の判定役（evals/judges/generic-options.md）。構造化出力（effort high）。</summary>
public sealed class ClaudeGenericOptionsReader(AnthropicClient client, string model, string prompt, IAiUsageMeter meter) : IGenericOptionsReader
{
    private const int MaxTokens = 16000;

    public async Task<GenericOptionsReading?> ReadAsync(string record, string answer, CancellationToken ct)
    {
        var text = await ClaudeJson.CallAsync(
            client, BuildParams(model, prompt, record, answer), meter, "genericOptionsJudge", "汎用の AI の仕事の選択肢を読む判定役", ct);
        return text is null ? null : Parse(text);
    }

    internal static GenericOptionsReading? Parse(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var options = root.GetProperty("options").EnumerateArray().Select(o => new GenericOption(
                o.GetProperty("title").GetString() ?? "",
                o.GetProperty("overConditions").GetBoolean(),
                o.GetProperty("decides").GetBoolean(),
                o.GetProperty("ranked").GetBoolean(),
                o.GetProperty("quotes").EnumerateArray().Select(q => q.GetString() ?? "").ToList())).ToList();
            return new GenericOptionsReading(options, root.GetProperty("reason").GetString() ?? "");
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            Console.Error.WriteLine($"汎用の AI の仕事の選択肢を読む判定役の答えを読めませんでした: {e.GetType().Name}");
            return null;
        }
    }

    internal static MessageCreateParams BuildParams(string model, string prompt, string record, string answer) =>
        ClaudeJson.Params(model, prompt, $"<record>\n{record}\n</record>\n<answer>\n{answer}\n</answer>", MaxTokens, Schema());

    private static Dictionary<string, JsonElement> Schema()
    {
        var option = new
        {
            type = "object",
            properties = new Dictionary<string, object>
            {
                ["title"] = new { type = "string" },
                ["overConditions"] = new { type = "boolean" },
                ["decides"] = new { type = "boolean" },
                ["ranked"] = new { type = "boolean" },
                ["quotes"] = new { type = "array", items = new { type = "string" } },
            },
            required = new[] { "title", "overConditions", "decides", "ranked", "quotes" },
            additionalProperties = false,
        };
        return ClaudeJson.ObjectSchema(
            new Dictionary<string, object> { ["options"] = new { type = "array", items = option }, ["reason"] = new { type = "string" } },
            ["options", "reason"]);
    }
}

/// <summary>判定役の、構造化出力の呼び出しの共通部分。</summary>
internal static class ClaudeJson
{
    public static MessageCreateParams Params(string model, string prompt, string user, int maxTokens, Dictionary<string, JsonElement> schema) => new()
    {
        Model = model,
        MaxTokens = maxTokens,
        System = new List<BetaTextBlockParam> { new() { Text = prompt, CacheControl = new BetaCacheControlEphemeral() } },
        Messages = new List<BetaMessageParam> { new BetaUserMessageParam { Content = user } },
        OutputConfig = new BetaOutputConfig
        {
            Effort = Effort.High,
            Format = new BetaJsonOutputFormat { Schema = schema },
        },
    };

    public static Dictionary<string, JsonElement> ObjectSchema(Dictionary<string, object> properties, string[] required) => new()
    {
        ["type"] = JsonSerializer.SerializeToElement("object"),
        ["properties"] = JsonSerializer.SerializeToElement(properties),
        ["required"] = JsonSerializer.SerializeToElement(required),
        ["additionalProperties"] = JsonSerializer.SerializeToElement(false),
    };

    /// <summary>呼んで、答えの文を返す。失敗、途中で切れた、断られたときは null（理由は標準エラーに種類だけ書く）。</summary>
    public static async Task<string?> CallAsync(
        AnthropicClient client, MessageCreateParams parameters, IAiUsageMeter meter, string call, string name, CancellationToken ct)
    {
        BetaMessage response;
        try
        {
            response = await client.Beta.Messages.Create(parameters, ct);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            Console.Error.WriteLine($"{name}の呼び出しに失敗しました: {e.GetType().Name}");
            return null;
        }

        meter.Record(new AiUsage(
            call, response.Usage.InputTokens, response.Usage.CacheReadInputTokens ?? 0, response.Usage.CacheCreationInputTokens ?? 0, response.Usage.OutputTokens));
        var stopReason = response.StopReason?.Raw();
        if (stopReason != "end_turn")
        {
            Console.Error.WriteLine($"{name}が答えを終えられませんでした: {stopReason}");
            return null;
        }

        return string.Concat(response.Content.Select(b => b.TryPickText(out var t) ? t.Text : ""));
    }
}
