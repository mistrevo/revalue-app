namespace Revalue.Server.Features.Options;

/// <summary>
/// AI に渡す候補。条件に合う業務だけを、登録の ID つきで持つ。<paramref name="Occupations"/> の業務も条件に合うものだけにする。
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

        var tasks = catalog.ActiveTasks.Where(t => ConditionFit.Fits(t, conditions)).ToList();
        var ids = tasks.Select(t => t.Id).ToHashSet();
        var occupations = catalog.Occupations
            .Select(o => o with { Tasks = o.Tasks.Where(t => ids.Contains(t.Id)).ToList() })
            .Where(o => o.Tasks.Count > 0)
            .ToList();

        // 条件に収まる業務がないのか、収まる業務はあるが本人が使える力を使わないのかを分ける
        var usable = inputs.Abilities.Select(a => a.Ability).ToHashSet();
        var chooseBlocked = tasks.Count == 0 ? MissingReason.NoFit
            : !tasks.Any(t => usable.Any(t.Uses)) ? MissingReason.NoAbilityMatch
            : (MissingReason?)null;

        var pairs = occupations.SelectMany((a, i) => occupations.Skip(i + 1).Select(b => (a, b)))
            .SelectMany(pair => pair.a.Tasks.SelectMany(x => pair.b.Tasks.Select(y => (x, y))))
            .Where(pair => ConditionFit.CombineFits([pair.x, pair.y], conditions))
            .ToList();
        var combineBlocked = pairs.Count == 0 ? MissingReason.NoFit
            : !pairs.Any(pair => usable.Any(pair.x.Uses) || usable.Any(pair.y.Uses)) ? MissingReason.NoAbilityMatch
            : (MissingReason?)null;
        return new OptionCandidates(occupations, tasks, chooseBlocked, combineBlocked);
    }
}
