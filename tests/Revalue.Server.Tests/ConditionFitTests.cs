using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;

namespace Revalue.Server.Tests;

public sealed class ConditionFitTests
{
    private static JobTask Task(int min, int max, string place = "home", string slots = "\"daytime\"", int yenMin = 1300, int yenMax = 1800)
    {
        var json = $$"""
        {
          "source": { "text": "出典", "url": "https://example.com", "note": "注" },
          "occupations": [
            { "id": "o", "name": "職種", "summary": "説明", "jobtag": { "number": 1, "name": "名" },
              "tasks": [
                { "id": "t", "name": "業務", "detail": "中身", "jobtagTasks": [1], "ability": "coordinating",
                  "hoursPerWeek": { "min": {{min}}, "max": {{max}} }, "timeSlots": [{{slots}}], "place": "{{place}}",
                  "hourlyYen": { "min": {{yenMin}}, "max": {{yenMax}} }, "knowledge": [] }
              ] }
          ]
        }
        """;
        return JobCatalog.Parse(json).Occupations[0].Tasks[0];
    }

    private static ProfileConditions Cond(int hours, Place place = Place.HomeOnly, params TimeSlot[] slots) =>
        new(slots.Length == 0 ? [TimeSlot.Daytime] : slots, hours, place, null);

    [Theory(DisplayName = "options-5（条件の範囲だけ）: 業務は、時間、時間帯、場所がそろって収まるときだけ条件に合う")]
    [InlineData("home", 3, Place.HomeOnly, TimeSlot.Daytime, true)]
    [InlineData("home", 1, Place.HomeOnly, TimeSlot.Daytime, false)]
    [InlineData("home", 3, Place.HomeOnly, TimeSlot.Night, false)]
    [InlineData("out", 3, Place.HomeOnly, TimeSlot.Daytime, false)]
    [InlineData("out", 3, Place.CanGoOut, TimeSlot.Daytime, true)]
    public void FitsNeedsTimeSlotAndPlace(string place, int hours, Place userPlace, TimeSlot slot, bool expected) =>
        Assert.Equal(expected, ConditionFit.Fits(Task(3, 10, place), Cond(hours, userPlace, slot)));

    [Fact(DisplayName = "options-5（条件の範囲だけ）: 使える時間帯は、業務と本人の重なりを時間帯の順で返す")]
    public void UsableSlotsAreTheOverlapInOrder()
    {
        var task = Task(3, 10, slots: "\"night\", \"morning\", \"daytime\"");

        Assert.Equal([TimeSlot.Morning, TimeSlot.Night], ConditionFit.UsableSlots(task, Cond(5, Place.HomeOnly, TimeSlot.Night, TimeSlot.Morning)));
    }

    [Fact(DisplayName = "options-5（条件の範囲だけ）: 選ぶの時間と収入は、いちばん小さい始めやすさから、本人の時間までの幅にする")]
    public void ChooseRangeRunsFromEasiestStartToUsersHours()
    {
        var a = Task(3, 10, yenMin: 1300, yenMax: 1800);
        var b = Task(1, 5, yenMin: 1300, yenMax: 2000);

        Assert.Equal(new WorkRange(1, 5, 5000, 40000), ConditionFit.ChooseRange([a, b], Cond(5)));
    }

    [Fact(DisplayName = "options-5（条件の範囲だけ）: 組み合わせるは、始めやすさを足した時間が本人の時間に収まるときだけ")]
    public void CombineNeedsSummedStartToFit()
    {
        var a = Task(3, 10);
        var b = Task(2, 6);

        Assert.True(ConditionFit.CombineFits([a, b], Cond(5)));
        Assert.False(ConditionFit.CombineFits([a, b], Cond(3)));
        var range = ConditionFit.CombineRange([a, b], Cond(10));
        Assert.Equal((5, 10), (range.MinHours, range.MaxHours));
        // 下 (3+2)×1300×4=26000、上 10×1800×4=72000
        Assert.Equal((26000, 72000), (range.MinMonthlyYen, range.MaxMonthlyYen));
    }

    [Fact(DisplayName = "options-5（条件の範囲だけ）: 組み合わせるの上は、業務の「何時間まで」の合計を超えない")]
    public void CombineRangeCapsAtSummedMax()
    {
        var range = ConditionFit.CombineRange([Task(1, 2), Task(1, 3)], Cond(20));

        Assert.Equal((2, 5), (range.MinHours, range.MaxHours));
    }
}
