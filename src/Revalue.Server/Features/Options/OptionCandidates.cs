namespace Revalue.Server.Features.Options;

/// <summary>
/// AI に渡す候補。条件に合う業務だけを、登録の ID つきで持つ。<paramref name="Occupations"/> の業務も条件に合うものだけにする。
/// <paramref name="CanChoose"/> と <paramref name="CanCombine"/> が false のカードは、AI の答えを見ずに出せないとする。
/// </summary>
public sealed record OptionCandidates(IReadOnlyList<Occupation> Occupations, IReadOnlyList<JobTask> Tasks, bool CanChoose, bool CanCombine)
{
    public static OptionCandidates From(JobCatalog catalog, OptionsInputs inputs)
    {
        if (inputs.Conditions is not { } conditions)
        {
            return new OptionCandidates([], [], false, false);
        }

        var tasks = catalog.AllTasks.Where(t => ConditionFit.Fits(t, conditions)).ToList();
        var ids = tasks.Select(t => t.Id).ToHashSet();
        var occupations = catalog.Occupations
            .Select(o => o with { Tasks = o.Tasks.Where(t => ids.Contains(t.Id)).ToList() })
            .Where(o => o.Tasks.Count > 0)
            .ToList();

        var usable = inputs.Abilities.Select(a => a.Ability).ToHashSet();
        var canChoose = tasks.Any(t => usable.Contains(t.Ability));
        var canCombine = occupations.SelectMany((a, i) => occupations.Skip(i + 1).Select(b => (a, b)))
            .Any(pair => pair.a.Tasks.Any(x => pair.b.Tasks.Any(y =>
                (usable.Contains(x.Ability) || usable.Contains(y.Ability)) && ConditionFit.CombineFits([x, y], conditions))));
        return new OptionCandidates(occupations, tasks, canChoose, canCombine);
    }
}
