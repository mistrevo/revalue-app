using System.Text;
using System.Text.Json;
using Anthropic;
using Anthropic.Models.Beta.Messages;
using Revalue.Server.Ai;
using Revalue.Server.Features.Deepen;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Evals;

/// <summary>深めた中身 1 件への判定役の答え。項目は evals/judges/deepen.md に合わせる。</summary>
public sealed record DeepenVerdict(
    bool Decides, bool PushesAway, bool OverPraise, bool StepsSmall, bool QuestionsNeutral, bool QuestionsInScene, string Reason);

/// <summary>深めた中身を判定する役。答えられなかったときは null を返す（評価では、問題があったと数える）。</summary>
public interface IDeepenJudge
{
    /// <param name="record">本人の記録（<see cref="OptionsEval.RecordText"/>）。</param>
    /// <param name="content">画面に出す深めた中身の文（<see cref="DeepenEval.ContentText"/>）。</param>
    Task<DeepenVerdict?> JudgeAsync(string record, string content, CancellationToken ct);
}

/// <summary>照らし合わせの前の AI の答えを、機械で数えたもの（参考）。</summary>
/// <param name="StepsOutside">時間（1〜3 時間で、週の時間以下）か場所が、本人の条件の外の一歩の数。</param>
/// <param name="CreateNoDemand">「創る」で、需要の確かめの一歩がなかったか。</param>
public sealed record DeepenDraftCounts(int StepsOutside, bool CreateNoDemand);

/// <summary>画面に出す中身を、評価が照らし合わせとは別に数え直したもの。</summary>
/// <param name="StepsOutside">画面に出す一歩の候補のうち、いまの条件の外のもの。</param>
/// <param name="CreateNoDemand">「創る」で、画面に出す一歩の候補に需要の確かめがないか。</param>
public sealed record DeepenCheck(
    int StepsOutside,
    bool CreateNoDemand,
    IReadOnlyList<string> Forbidden,
    IReadOnlyList<string> Assertive,
    IReadOnlyList<string> Praise,
    bool Money);

/// <summary>架空の選んだ案 1 件を流した結果。<see cref="Error"/> があれば、対象を作れなかったか、AI が失敗・拒否して途中で終えた。</summary>
public sealed record DeepenRun(
    DeepenCase Case,
    ProfileCase Profile,
    DeepenTarget? Target,
    DeepenDraft? Draft,
    DeepenContent? Content,
    IReadOnlyList<DeepenRejection> Rejections,
    IReadOnlyList<TaskLight> Lights,
    IReadOnlyList<VisibleStep> Steps,
    DeepenDraftCounts Before,
    DeepenCheck? Check,
    string Text,
    DeepenVerdict? Verdict,
    string? Error);

/// <summary>
/// 選んだ案を深める評価（06-deepen.md の「評価との対応」、evals/criteria.md の「選んだ案を深める」）。
/// 製品と同じ対象づくり（<see cref="DeepenTargetReader"/>）、AI、照らし合わせ（<see cref="DeepenValidator"/>）、業務の照らし合わせ
/// （<see cref="DeepenLighting"/>）、画面に出す一歩（<see cref="DeepenSteps"/>）を通し、照らし合わせの前の AI の答えと、画面に出す中身の両方を数える。
/// 画面に出す中身は判定役も読む。
/// </summary>
public sealed class DeepenEval(IDeepenAi ai, IDeepenJudge judge, JobCatalog catalog, ForbiddenWords forbidden)
{
    private static readonly DateTimeOffset GeneratedAt = DateTimeOffset.UnixEpoch;

    public async Task<DeepenRun> RunAsync(DeepenCase c, ProfileCase profile, CancellationToken ct)
    {
        var inputs = profile.Inputs;
        var none = new DeepenDraftCounts(0, false);
        DeepenRun Stop(DeepenTarget? target, string error) => new(c, profile, target, null, null, [], [], [], none, null, "", null, error);

        var (readiness, target) = DeepenTargetReader.From(c.Options, inputs.Conditions, catalog);
        if (target is null || inputs.Conditions is not { } conditions)
        {
            return Stop(null, $"深める対象を作れなかった（{readiness}）");
        }

        DeepenDraft draft;
        try
        {
            draft = await ai.DraftAsync(target, inputs, ct);
        }
        catch (ConversationAiException e)
        {
            return Stop(target, $"AI が答えなかった（{e.Kind}）");
        }

        var (content, rejections) = DeepenValidator.Build(draft, target, conditions, ForbiddenWordList.Load(), GeneratedAt);
        var lights = DeepenLighting.Light(target, content, inputs);
        var steps = DeepenSteps.Visible(content, [], target.Kind, conditions);
        var text = ContentText(target, lights, content, steps);
        var verdict = await judge.JudgeAsync(OptionsEval.RecordText(inputs), text, ct);
        return new DeepenRun(
            c, profile, target, draft, content, rejections, lights, steps, CountDraft(draft, target, conditions), Check(target, content, steps, conditions, forbidden),
            text, verdict, null);
    }

    /// <summary>照らし合わせの前の AI の一歩の候補を数える。</summary>
    public static DeepenDraftCounts CountDraft(DeepenDraft draft, DeepenTarget target, ProfileConditions conditions)
    {
        var outside = draft.Steps.Count(s =>
            s.Place is not ("home" or "out")
            || !StepFit.Fits(new StepCandidate("", s.Text, s.Hours, s.Place == "out" ? TaskPlace.Out : TaskPlace.Home, s.DemandCheck), conditions));
        return new DeepenDraftCounts(outside, target.Kind == TargetKind.Create && !draft.Steps.Any(s => s.DemandCheck));
    }

    /// <summary>
    /// 画面に出す中身を、照らし合わせとは別に数え直す。一歩の候補の条件、「創る」の需要の確かめ、AI が書いた文（業務の見立て、問い、一歩）の
    /// 使わない言葉、言い切りと順位の言葉、褒め言葉、お金の額。言い切りと褒め言葉とお金の額は「」の中を数えない（照らし合わせと同じ）。
    /// </summary>
    public static DeepenCheck Check(DeepenTarget target, DeepenContent content, IReadOnlyList<VisibleStep> steps, ProfileConditions conditions, ForbiddenWords forbidden)
    {
        var sentences = content.Tasks.SelectMany(t => new[] { t.Name, t.Detail, t.Knowledge })
            .Concat(content.Questions.SelectMany(q => q.Choices.Prepend(q.Situation)))
            .Concat(steps.Select(s => s.Step.Text))
            .Where(s => s.Length > 0)
            .ToList();

        // 力の名前と「優先順位」（「順位」を含む）は使わない言葉として数えない（照らし合わせと同じ）
        var written = string.Join("\n", sentences);
        foreach (var allowed in ForbiddenWordList.Allowed)
        {
            written = written.Replace(allowed, "", StringComparison.Ordinal);
        }

        return new DeepenCheck(
            steps.Count(s => !StepFit.Fits(s.Step, conditions)),
            target.Kind == TargetKind.Create && !steps.Any(s => s.Fits && s.Step.DemandCheck),
            forbidden.Find(written),
            sentences.Select(OptionsValidator.AssertiveIn).OfType<string>().Distinct().ToList(),
            sentences.Select(OptionsValidator.PraiseIn).OfType<string>().Distinct().ToList(),
            sentences.Any(OptionsValidator.HasMoneyAmount));
    }

    /// <summary>画面に出す深めた中身の文。判定役に渡し、結果のファイルにも載せる。画面の決まった文（まだ確かめていません など）も並べる。</summary>
    public static string ContentText(DeepenTarget target, IReadOnlyList<TaskLight> lights, DeepenContent content, IReadOnlyList<VisibleStep> steps)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"【選んだ案】{KindName(target.Kind)}: {target.Title}");
        switch (target.Kind)
        {
            case TargetKind.Create when target.Create is { } c:
                sb.AppendLine($"誰の: {c.Who}");
                sb.AppendLine($"どんな困りごとを: {c.Trouble}");
                sb.AppendLine($"中身: {c.Summary}");
                break;
            case TargetKind.Own when target.Own is { } own:
                sb.AppendLine($"メモ: {(string.IsNullOrWhiteSpace(own.Note) ? "なし" : own.Note)}");
                break;
        }

        sb.AppendLine();
        sb.AppendLine(target.Drafts ? "業務ごとに照らす（AI の見立て（直せます））:" : "業務ごとに照らす:");
        if (lights.Count == 0)
        {
            sb.AppendLine(content.TasksRejected ? "（今回は、業務の見立てをうまく作れませんでした。業務を自分で書くこともできます。）" : "（業務なし）");
        }

        foreach (var light in lights)
        {
            sb.AppendLine($"- {light.Name}{(light.Detail.Length == 0 ? "" : $"（{light.Detail}）")}");
            if (light.Usable is { } usable)
            {
                var state = usable.State == AbilityState.Confirmed ? "あなたの話から見えた力" : "確かめ中";
                sb.AppendLine($"  - 使えるところ: {AbilityText.Name(light.Ability)}（{state}）");
                foreach (var quote in usable.Quotes)
                {
                    sb.AppendLine(quote.FromChoice ? $"    - 「{quote.Quote}」（選んだ答え）" : $"    - 「{quote.Quote}」");
                }
            }
            else
            {
                sb.AppendLine($"  - まだ確かめていないこと: この業務で使う{AbilityText.Name(light.Ability)}は、まだ確かめていません。");
            }

            foreach (var knowledge in light.Knowledge)
            {
                sb.AppendLine($"  - まだ確かめていないこと: {knowledge}");
            }
        }

        sb.AppendLine("仕事の場面で発揮できるかは、まだ確かめていません。");
        sb.AppendLine();
        sb.AppendLine("仮の場面の問い:");
        if (content.Questions.Count == 0)
        {
            sb.AppendLine("（今回は、問いをうまく作れませんでした。）");
        }

        foreach (var q in content.Questions)
        {
            sb.AppendLine($"- {q.Situation}（使う力: {AbilityText.Name(q.Ability)}）");
            foreach (var choice in q.Choices)
            {
                sb.AppendLine($"  - {choice}");
            }
        }

        sb.AppendLine();
        sb.AppendLine(content.StepsFallback ? "最初の一歩の候補（アプリが決めた候補）:" : "最初の一歩の候補:");
        foreach (var s in steps)
        {
            sb.AppendLine($"- {s.Step.Text}（{s.Step.Hours} 時間くらい、{(s.Step.Place == TaskPlace.Out ? "外に出る" : "家でできる")}" +
                $"{(s.Step.DemandCheck ? "、需要の確かめ" : "")}{(s.Fits ? "" : "、いまの条件の外")}）");
        }

        return sb.ToString().TrimEnd();
    }

    public static string KindName(TargetKind kind) => kind switch
    {
        TargetKind.Choose => "選ぶ",
        TargetKind.Combine => "組み合わせる",
        TargetKind.Create => "創る",
        _ => "本人が書いた仕事",
    };
}

/// <summary>dry-run 用の判定役。いつも「問題なし」と答える。Claude を呼ばない。</summary>
public sealed class DryRunDeepenJudge : IDeepenJudge
{
    public Task<DeepenVerdict?> JudgeAsync(string record, string content, CancellationToken ct) =>
        Task.FromResult<DeepenVerdict?>(new DeepenVerdict(false, false, false, true, true, true, ""));
}

/// <summary>Claude の、深めた中身の判定役（evals/judges/deepen.md）。構造化出力（effort high）。</summary>
public sealed class ClaudeDeepenJudge(AnthropicClient client, string model, string prompt, IAiUsageMeter meter) : IDeepenJudge
{
    private const int MaxTokens = 16000;

    private static readonly string[] BooleanFields = ["decides", "pushesAway", "overPraise", "stepsSmall", "questionsNeutral", "questionsInScene"];

    public async Task<DeepenVerdict?> JudgeAsync(string record, string content, CancellationToken ct)
    {
        var text = await ClaudeJson.CallAsync(client, BuildParams(model, prompt, record, content), meter, "deepenJudge", "深めた中身の判定役", ct);
        if (text is null)
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(text);
            var root = document.RootElement;
            bool Get(string name) => root.GetProperty(name).GetBoolean();
            return new DeepenVerdict(
                Get("decides"), Get("pushesAway"), Get("overPraise"), Get("stepsSmall"), Get("questionsNeutral"), Get("questionsInScene"),
                root.GetProperty("reason").GetString() ?? "");
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            Console.Error.WriteLine($"深めた中身の判定役の答えを読めませんでした: {e.GetType().Name}");
            return null;
        }
    }

    internal static MessageCreateParams BuildParams(string model, string prompt, string record, string content) =>
        ClaudeJson.Params(model, prompt, $"<record>\n{record}\n</record>\n<content>\n{content}\n</content>", MaxTokens, Schema());

    private static Dictionary<string, JsonElement> Schema()
    {
        var properties = BooleanFields.ToDictionary(n => n, _ => (object)new { type = "boolean" });
        properties["reason"] = new { type = "string" };
        return ClaudeJson.ObjectSchema(properties, BooleanFields.Append("reason").ToArray());
    }
}
