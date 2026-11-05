namespace Revalue.Server.Features.Options;

/// <summary>
/// AI に渡す候補。カードに使う業務のうち、本人の条件に合い、本人の使える力のどれかにつながる業務だけを、登録の ID つきで持つ。
/// <paramref name="Occupations"/> の業務も、その業務だけにする。条件に合う業務をすべて渡すと文が長くなりすぎ、理由が業務から離れるため
/// （05-options.md の「AI が書いた中身をコードで確かめる」。Claude の判断）。
/// <paramref name="ChooseBlocked"/> と <paramref name="CombineBlocked"/> は、そのカードを AI の答えを見ずに出せないとする理由（出せるなら null）。
/// </summary>
public sealed record OptionCandidates(
    IReadOnlyList<Occupation> Occupations, IReadOnlyList<JobTask> Tasks, MissingReason? ChooseBlocked, MissingReason? CombineBlocked)
{
    public bool CanChoose => ChooseBlocked is null;

    public bool CanCombine => CombineBlocked is null;

    public static OptionCandidates From(JobCatalog catalog, OptionsInputs inputs)
    {
        if (inputs.Conditions is not { } conditions)
        {
            return new OptionCandidates([], [], MissingReason.NoFit, MissingReason.NoFit);
        }

        var fitting = catalog.ActiveTasks.Where(t => ConditionFit.Fits(t, conditions)).ToList();
        if (fitting.Count == 0)
        {
            return new OptionCandidates([], [], MissingReason.NoFit, MissingReason.NoFit);
        }

        // 条件に収まる業務がないのか、収まる業務はあるが本人の使える力につながらないのかを分ける
        var usable = inputs.Abilities.Select(a => a.Ability).ToList();
        var tasks = fitting.Where(t => usable.Any(t.Uses)).ToList();
        var ids = tasks.Select(t => t.Id).ToHashSet();
        var occupations = catalog.Occupations
            .Select(o => o with { Tasks = o.Tasks.Where(t => ids.Contains(t.Id)).ToList() })
            .Where(o => o.Tasks.Count > 0)
            .ToList();
        var chooseBlocked = tasks.Count == 0 ? MissingReason.NoAbilityMatch : (MissingReason?)null;

        // 組み合わせるは、どの業務も使える力のどれかにつながる組み合わせ
        var combineBlocked = !HasCombination(catalog, fitting, conditions) ? MissingReason.NoFit
            : !HasCombination(catalog, tasks, conditions) ? MissingReason.NoAbilityMatch
            : (MissingReason?)null;
        return new OptionCandidates(occupations, tasks, chooseBlocked, combineBlocked);
    }

    /// <summary>2 つの職種にまたがり、始めやすさの合計が本人の時間に収まる 2 つの業務の組があるか。</summary>
    private static bool HasCombination(JobCatalog catalog, IReadOnlyList<JobTask> tasks, Profile.ProfileConditions conditions)
    {
        var withOccupation = tasks.Select(t => (Task: t, Occupation: catalog.OccupationOf(t).Id)).ToList();
        for (var i = 0; i < withOccupation.Count; i++)
        {
            for (var j = i + 1; j < withOccupation.Count; j++)
            {
                if (withOccupation[i].Occupation != withOccupation[j].Occupation
                    && ConditionFit.CombineFits([withOccupation[i].Task, withOccupation[j].Task], conditions))
                {
                    return true;
                }
            }
        }

        return false;
    }
}
