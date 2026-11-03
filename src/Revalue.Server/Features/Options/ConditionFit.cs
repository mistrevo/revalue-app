using Revalue.Server.Features.Profile;

namespace Revalue.Server.Features.Options;

/// <summary>週あたりの時間と月の収入の目安の幅。収入は円。</summary>
public sealed record WorkRange(int MinHours, int MaxHours, int MinMonthlyYen, int MaxMonthlyYen);

/// <summary>
/// 業務が本人の条件（時間帯、週あたりの時間、場所）に収まるか、時間と収入の幅を、コードで決める
/// （05-options.md の「条件の範囲」）。収入は絞り込みに使わない。
/// </summary>
public static class ConditionFit
{
    /// <summary>1 か月を 4 週として数える。</summary>
    private const int WeeksPerMonth = 4;

    private const int YenStep = 1000;

    public static bool Fits(JobTask task, ProfileConditions c) =>
        task.HoursPerWeek.Min <= c.HoursPerWeek
        && UsableSlots(task, c).Count > 0
        && PlaceFits(task.Place, c.Place);

    /// <summary>業務の時間帯のうち、本人の時間帯に入るもの（<see cref="TimeSlot"/> の順）。</summary>
    public static IReadOnlyList<TimeSlot> UsableSlots(JobTask task, ProfileConditions c) =>
        Enum.GetValues<TimeSlot>().Where(s => task.TimeSlots.Contains(s) && c.TimeSlots.Contains(s)).ToList();

    public static bool PlaceFits(TaskPlace place, Place userPlace) => place == TaskPlace.Home || userPlace == Place.CanGoOut;

    /// <summary>選ぶの幅。業務はどれか一つから受けられると読む。</summary>
    public static WorkRange ChooseRange(IReadOnlyList<JobTask> tasks, ProfileConditions c)
    {
        var low = tasks.Min(t => t.HoursPerWeek.Min);
        var high = Math.Min(c.HoursPerWeek, tasks.Max(t => t.HoursPerWeek.Max));
        return Range(low, high, low * tasks.Min(t => t.HourlyYen.Min), high * tasks.Max(t => t.HourlyYen.Max));
    }

    public static bool CombineFits(IReadOnlyList<JobTask> tasks, ProfileConditions c) =>
        tasks.Count > 0 && tasks.All(t => Fits(t, c)) && tasks.Sum(t => t.HoursPerWeek.Min) <= c.HoursPerWeek;

    /// <summary>組み合わせるの幅。業務を一緒に受けると読む。</summary>
    public static WorkRange CombineRange(IReadOnlyList<JobTask> tasks, ProfileConditions c)
    {
        var low = tasks.Sum(t => t.HoursPerWeek.Min);
        var high = Math.Min(c.HoursPerWeek, tasks.Sum(t => t.HoursPerWeek.Max));
        return Range(low, high, tasks.Sum(t => t.HoursPerWeek.Min * t.HourlyYen.Min), high * tasks.Max(t => t.HourlyYen.Max));
    }

    /// <summary>収入は、下を 1,000 円単位で切り下げ、上を 1,000 円単位で切り上げる。</summary>
    private static WorkRange Range(int lowHours, int highHours, int lowYenPerWeek, int highYenPerWeek) => new(
        lowHours,
        highHours,
        lowYenPerWeek * WeeksPerMonth / YenStep * YenStep,
        (highYenPerWeek * WeeksPerMonth + YenStep - 1) / YenStep * YenStep);
}
