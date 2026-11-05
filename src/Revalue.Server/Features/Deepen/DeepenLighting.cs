using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Deepen;

/// <summary>
/// 業務 1 つの照らし合わせ。<paramref name="Ability"/> は、登録の業務なら主な力、見立ての業務ならその力。
/// <paramref name="Usable"/> は業務の力のうち本人の使える力（主な力、補助の力の順。見立ての業務は 0〜1 つ）で、外した力と画面に出さない力は入らない。
/// 主な力が使える力でなければ（<see cref="MainUsable"/> が false）、「この業務で使う○○は、まだ確かめていません」と示す。補助の力は並べない。
/// <paramref name="Scene"/> は、登録の業務で主な力が使える力のときだけの、力が生きる場面。<paramref name="Checks"/> は登録の業務の本人に確かめる条件（見立ての業務は空）。
/// <paramref name="Drafted"/> は AI の見立ての業務。
/// </summary>
public sealed record TaskLight(
    string? Id,
    string Name,
    string Detail,
    Ability Ability,
    IReadOnlyList<UsableAbility> Usable,
    string? Scene,
    IReadOnlyList<string> Checks,
    IReadOnlyList<string> Knowledge,
    bool Drafted)
{
    /// <summary>主な力（見立ての業務ならその力）が、本人の使える力か。</summary>
    public bool MainUsable => Usable.Any(u => u.Ability == Ability);
}

public static class DeepenLighting
{
    /// <summary>業務ごとに、いまの記録から使える力と根拠の言葉を引く。AI は呼ばない（deepen-2（業務ごとに照らす））。</summary>
    public static IReadOnlyList<TaskLight> Light(DeepenTarget target, DeepenContent? content, OptionsInputs inputs)
    {
        // 使える力は、見せた力のうち本人が外していない力だけ（OptionsInputs.Abilities）。話から確かめる力でない力は使えるところにしない
        UsableAbility? UsableOf(Ability ability) =>
            AbilityCatalog.IsActive(ability) ? inputs.Abilities.FirstOrDefault(a => a.Ability == ability) : null;

        if (target.Drafts)
        {
            return (content?.Tasks ?? [])
                .Select(t => new TaskLight(
                    t.Id, t.Name, t.Detail, t.Ability, UsableOf(t.Ability) is { } u ? [u] : [], null, [],
                    t.Knowledge.Length > 0 ? [t.Knowledge] : [], true))
                .ToList();
        }

        return target.Registered
            .Select(t =>
            {
                IReadOnlyList<UsableAbility> usable = t.ActiveAbilities.Select(UsableOf).OfType<UsableAbility>().ToList();
                var mainUsable = usable.Any(u => u.Ability == t.Abilities.Main);
                return new TaskLight(t.Id, t.Name, t.Detail, t.Abilities.Main, usable, mainUsable ? t.Scene : null, t.Checks, t.Knowledge, false);
            })
            .ToList();
    }
}

/// <summary>最初の一歩の候補が、いまの条件に収まるか。</summary>
public static class StepFit
{
    public const int MaxStepHours = 3;

    public static bool Fits(StepCandidate step, ProfileConditions c) =>
        step.Hours >= 1 && step.Hours <= Math.Min(MaxStepHours, c.HoursPerWeek) && ConditionFit.PlaceFits(step.Place, c.Place);
}
