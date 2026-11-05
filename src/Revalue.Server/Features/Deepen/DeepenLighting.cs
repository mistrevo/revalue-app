using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Deepen;

/// <summary>
/// 業務 1 つの照らし合わせ。<paramref name="Usable"/> は、その業務の「使う力」が本人の使える力のときだけ入る。
/// なければ「この業務で使う○○は、まだ確かめていません」と示す。<paramref name="Drafted"/> は AI の見立ての業務。
/// </summary>
public sealed record TaskLight(
    string? Id, string Name, string Detail, Ability Ability, UsableAbility? Usable, IReadOnlyList<string> Knowledge, bool Drafted);

public static class DeepenLighting
{
    /// <summary>業務ごとに、いまの記録から使える力と根拠の言葉を引く。AI は呼ばない（deepen-2（業務ごとに照らす））。</summary>
    public static IReadOnlyList<TaskLight> Light(DeepenTarget target, DeepenContent? content, OptionsInputs inputs)
    {
        UsableAbility? UsableOf(Ability ability) => inputs.Abilities.FirstOrDefault(a => a.Ability == ability);

        if (target.Drafts)
        {
            return (content?.Tasks ?? [])
                .Select(t => new TaskLight(
                    t.Id, t.Name, t.Detail, t.Ability, UsableOf(t.Ability), t.Knowledge.Length > 0 ? [t.Knowledge] : [], true))
                .ToList();
        }

        return target.Registered
            .Select(t => new TaskLight(t.Id, t.Name, t.Detail, t.Abilities.Main, UsableOf(t.Abilities.Main), t.Knowledge, false))
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
