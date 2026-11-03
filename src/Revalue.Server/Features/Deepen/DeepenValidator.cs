using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Deepen;

/// <summary>画面に出す一歩の候補。<paramref name="Fits"/> が false で <paramref name="Chosen"/> が true のものは、選んだあとに条件が変わって収まらなくなった候補。</summary>
public sealed record VisibleStep(StepCandidate Step, bool Fits, bool Chosen);

public static class DeepenSteps
{
    /// <summary>
    /// いまの条件で画面に出す一歩の候補。中身の候補のうち、収まるものと、収まらないが選んでいたものを残し、
    /// 収まるものが 3 つに満たなければコードの候補で補う（06-deepen.md の「最初の一歩」）。
    /// 「創る」で、収まる需要の確かめがなければ、コードの需要の確かめを先に足す。
    /// </summary>
    public static IReadOnlyList<VisibleStep> Visible(
        DeepenContent content, IReadOnlyList<string> chosenIds, TargetKind kind, ProfileConditions conditions)
    {
        var visible = new List<VisibleStep>();
        foreach (var step in content.Steps)
        {
            var fits = StepFit.Fits(step, conditions);
            var chosen = chosenIds.Contains(step.Id);
            if ((fits || chosen) && visible.All(v => v.Step.Id != step.Id))
            {
                visible.Add(new VisibleStep(step, fits, chosen));
            }
        }

        var fallback = DeepenText.FallbackSteps(kind);
        if (kind == TargetKind.Create && !visible.Any(v => v.Fits && v.Step.DemandCheck))
        {
            var demand = fallback.First(s => s.DemandCheck);
            if (visible.All(v => v.Step.Id != demand.Id))
            {
                visible.Add(new VisibleStep(demand, true, chosenIds.Contains(demand.Id)));
            }
        }

        foreach (var step in fallback)
        {
            if (visible.Count(v => v.Fits) >= DeepenValidator.StepCount)
            {
                break;
            }

            if (visible.All(v => v.Step.Id != step.Id))
            {
                visible.Add(new VisibleStep(step, true, chosenIds.Contains(step.Id)));
            }
        }

        return visible;
    }
}

/// <summary>
/// 深める AI の答えを、部分ごとにコードで照らし合わせる（06-deepen.md の「AI が書いた中身をコードで確かめる」）。
/// 業務の見立てが通らなければ出さず、問いは当たったものだけを落とし、一歩の候補は当たったら 3 つともコードの候補に置き換える。
/// </summary>
public static class DeepenValidator
{
    public const int MaxTaskName = 30;
    public const int MaxTaskDetail = 80;
    public const int MaxKnowledge = 60;
    public const int MaxTasks = 5;
    public const int MinDraftTasks = 2;
    public const int MaxDraftTasks = 4;
    public const int MaxSituation = 200;
    public const int MaxChoice = 40;
    public const int MaxQuestions = 2;
    public const int ChoiceCount = 3;
    public const int MaxStepText = 100;
    public const int StepCount = 3;

    public static (DeepenContent Content, IReadOnlyList<DeepenRejection> Rejections) Build(
        DeepenDraft draft, DeepenTarget target, ProfileConditions conditions, ForbiddenWordList forbidden, DateTimeOffset now)
    {
        var rejections = new List<DeepenRejection>();

        IReadOnlyList<DeepenTask> tasks = [];
        var tasksRejected = false;
        if (target.Drafts)
        {
            if (TasksProblem(draft.Tasks, forbidden, out var built) is { } rule)
            {
                tasksRejected = true;
                rejections.Add(new DeepenRejection("tasks", rule));
            }
            else
            {
                tasks = built;
            }
        }

        var allowed = (target.Drafts ? tasks.Select(t => t.Ability) : target.Registered.Select(t => t.Ability)).Distinct().ToHashSet();
        if (allowed.Count == 0)
        {
            allowed = [.. Enum.GetValues<Ability>()];
        }

        var questions = new List<DeepenQuestion>();
        foreach (var q in draft.Questions)
        {
            if (QuestionProblem(q, allowed, forbidden, out var ability) is { } rule)
            {
                rejections.Add(new DeepenRejection("question", rule));
                continue;
            }

            if (questions.Count < MaxQuestions)
            {
                questions.Add(new DeepenQuestion(
                    $"q{questions.Count + 1}", q.Situation.Trim(), ability, q.Choices.Select(c => c.Trim()).ToList()));
            }
        }

        IReadOnlyList<StepCandidate> steps;
        var fallback = false;
        if (StepsProblem(draft.Steps, target, conditions, forbidden, out var builtSteps) is { } stepRule)
        {
            rejections.Add(new DeepenRejection("steps", stepRule));
            steps = DeepenText.FallbackSteps(target.Kind);
            fallback = true;
        }
        else
        {
            steps = builtSteps;
        }

        return (new DeepenContent(now, target.Basis, tasks, tasksRejected, questions, steps, fallback), rejections);
    }

    /// <summary>
    /// 空、長すぎる、使わない言葉、言い切りと順位の言葉、褒め言葉、お金の額の順に見て、当たった規則の名前を返す。なければ null。
    /// 前後の空白は落としてから数える。
    /// </summary>
    public static string? TextProblem(string? text, int max, ForbiddenWordList forbidden, bool allowEmpty = false)
    {
        var trimmed = text?.Trim() ?? "";
        if (!ProfileEndpoints.HasVisibleText(trimmed))
        {
            return allowEmpty && trimmed.Length == 0 ? null : "empty";
        }

        if (!ProfileEndpoints.FitsIn(trimmed, max, max * 4))
        {
            return "tooLong";
        }

        if (forbidden.FirstIn(trimmed) is not null)
        {
            return "forbiddenWord";
        }

        if (OptionsValidator.AssertiveIn(trimmed) is not null)
        {
            return "assertiveWord";
        }

        if (OptionsValidator.PraiseIn(trimmed) is not null)
        {
            return "praiseWord";
        }

        return OptionsValidator.HasMoneyAmount(trimmed) ? "moneyAmount" : null;
    }

    private static string? TasksProblem(IReadOnlyList<TaskDraft> drafts, ForbiddenWordList forbidden, out IReadOnlyList<DeepenTask> built)
    {
        built = [];
        if (drafts.Count is < MinDraftTasks or > MaxDraftTasks)
        {
            return "count";
        }

        var tasks = new List<DeepenTask>();
        foreach (var d in drafts)
        {
            if (!ActionRef.TryParseAbility(d.Ability, out var ability))
            {
                return "ability";
            }

            var problem = TextProblem(d.Name, MaxTaskName, forbidden)
                ?? TextProblem(d.Detail, MaxTaskDetail, forbidden, allowEmpty: true)
                ?? TextProblem(d.Knowledge, MaxKnowledge, forbidden, allowEmpty: true);
            if (problem is not null)
            {
                return problem;
            }

            tasks.Add(new DeepenTask($"t{tasks.Count + 1}", d.Name.Trim(), (d.Detail ?? "").Trim(), ability, (d.Knowledge ?? "").Trim()));
        }

        built = tasks;
        return null;
    }

    private static string? QuestionProblem(QuestionDraft q, HashSet<Ability> allowed, ForbiddenWordList forbidden, out Ability ability)
    {
        ability = default;
        if (q.Choices is null || q.Choices.Count != ChoiceCount)
        {
            return "choiceCount";
        }

        if (!ActionRef.TryParseAbility(q.Ability, out ability) || !allowed.Contains(ability))
        {
            return "ability";
        }

        if (TextProblem(q.Situation, MaxSituation, forbidden) is { } problem)
        {
            return problem;
        }

        foreach (var choice in q.Choices)
        {
            if (TextProblem(choice, MaxChoice, forbidden) is { } p)
            {
                return p;
            }
        }

        return q.Choices.Select(c => c.Trim()).Distinct().Count() == ChoiceCount ? null : "choiceDuplicate";
    }

    /// <summary>
    /// 一歩の候補に書かせない言葉。応募、契約、お金を払うことを最初の一歩にせず、勧める言い方にしないため（06-deepen.md の「最初の一歩」。Claude の判断）。
    /// </summary>
    public static readonly IReadOnlyList<string> PushyStepWords = ["応募", "契約", "申し込", "申込", "購入", "ましょう", "すべき"];

    private static string? StepsProblem(
        IReadOnlyList<StepDraft> drafts, DeepenTarget target, ProfileConditions conditions, ForbiddenWordList forbidden, out IReadOnlyList<StepCandidate> built)
    {
        built = [];
        if (drafts.Count != StepCount)
        {
            return "count";
        }

        var steps = new List<StepCandidate>();
        foreach (var d in drafts)
        {
            if (TextProblem(d.Text, MaxStepText, forbidden) is { } problem)
            {
                return problem;
            }

            if (PushyStepWords.Any(w => d.Text.Contains(w, StringComparison.Ordinal)))
            {
                return "pushyStep";
            }

            var place = d.Place switch
            {
                "home" => (TaskPlace?)TaskPlace.Home,
                "out" => TaskPlace.Out,
                _ => null,
            };
            if (place is null)
            {
                return "place";
            }

            var step = new StepCandidate($"s{steps.Count + 1}", d.Text.Trim(), d.Hours, place.Value, d.DemandCheck);
            if (!StepFit.Fits(step, conditions))
            {
                return "outsideConditions";
            }

            steps.Add(step);
        }

        if (target.Kind == TargetKind.Create && !steps.Any(s => s.DemandCheck))
        {
            return "noDemandCheck";
        }

        built = steps;
        return null;
    }
}
