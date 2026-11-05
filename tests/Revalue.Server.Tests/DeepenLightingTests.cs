using Revalue.Server.Features.Deepen;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;
using static Revalue.Server.Tests.DeepenTestKit;

namespace Revalue.Server.Tests;

public sealed class DeepenLightingTests
{
    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 登録した業務は、使える力なら状態と根拠の言葉を、そうでなければまだ確かめていない力を示す")]
    public void RegisteredTasksAreLit()
    {
        var inputs = Inputs();
        var lights = DeepenLighting.Light(Target(Options(CombineChoice())), null, inputs);

        var schedule = lights.Single(l => l.Id == "online-secretary-schedule");
        Assert.Equal(TestAbilities.BalancingInterests, schedule.Usable!.Ability);
        Assert.Equal(inputs.Abilities[0].Quotes, schedule.Usable.Quotes);
        Assert.False(schedule.Drafted);

        var check = lights.Single(l => l.Id == "accounting-check");
        Assert.Null(check.Usable);
        Assert.Equal(Catalog.FindTask("accounting-check")!.Knowledge, check.Knowledge);
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 本人が外した力の業務は、根拠の言葉を出さずに、まだ確かめていない力として示す")]
    public void ExcludedAbilityIsNotYet()
    {
        var excluded = Inputs() with { Abilities = [], Excluded = [TestAbilities.BalancingInterests] };
        var lights = DeepenLighting.Light(Target(Options(CombineChoice())), null, excluded);

        Assert.Null(lights.Single(l => l.Id == "online-secretary-schedule").Usable);
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 業務の力が画面に出さない力なら、使えるところとして示さない")]
    public void HiddenAbilityIsNotLit()
    {
        // 利害調整力と優先順位設定力（どちらも行動 3 つ、同じ分類）が同じ出来事でそろう。見せるのは辞書の順で前の利害調整力
        var episode = new EpisodeItem
        {
            Id = "episode-1",
            UserKey = "u",
            Type = EpisodeItem.ItemType,
            Status = EpisodeStatus.Finished,
            StartedAt = Now,
            FinishedAt = Now,
            Evidence =
            [
                E(TestAbilities.BalancingInterests, 1, Q1),
                E(TestAbilities.BalancingInterests, 2, Q2),
                E(TestAbilities.BalancingInterests, 3, "迎えの時間をずらしてもらいました"),
                E(TestAbilities.SettingPriorities, 1, "用事が三つ重なって"),
                E(TestAbilities.SettingPriorities, 2, "病院を先にしました"),
                E(TestAbilities.SettingPriorities, 3, "熱が高かったからです"),
            ],
        };
        var inputs = OptionsInputsReader.From(null, [episode], AbilityBook.View([episode], null), null) with { Conditions = Conditions() };
        var choice = new OptionChoice(ChoiceKind.Card, Now, CardKind.Choose,
            new ChooseCard("online-secretary", "オンライン秘書", "要約",
                [CardTaskOf("online-secretary-schedule"), CardTaskOf("online-secretary-email")], new WorkRange(3, 10, 15000, 80000), "理由です。",
                new CardAbility(TestAbilities.BalancingInterests, AbilityState.Confirmed, [E(TestAbilities.BalancingInterests, 1, Q1)])),
            null, null, null);

        var lights = DeepenLighting.Light(Target(Options(choice)), null, inputs);

        Assert.Equal(TestAbilities.BalancingInterests, lights.Single(l => l.Id == "online-secretary-schedule").Usable!.Ability);
        var email = lights.Single(l => l.Id == "online-secretary-email");
        Assert.Equal(TestAbilities.SettingPriorities, email.Ability);
        Assert.Null(email.Usable);
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 「創る」と自分の仕事は、見立ての業務を、見立てと分かる形で照らす")]
    public void DraftedTasksAreLit()
    {
        var content = new DeepenContent(
            Now, "b",
            [
                new DeepenTask("t1", "予定の取りまとめ", "中身", TestAbilities.BalancingInterests, "表計算"),
                new DeepenTask("t2", "順番決め", "中身", TestAbilities.SettingPriorities, ""),
            ],
            false, [], [], false);
        var target = Target(Options(CreateChoice()));

        var lights = DeepenLighting.Light(target, content, Inputs());

        Assert.All(lights, l => Assert.True(l.Drafted));
        Assert.Equal(["表計算"], lights[0].Knowledge);
        Assert.NotNull(lights[0].Usable);
        Assert.Empty(lights[1].Knowledge);
        Assert.Null(lights[1].Usable);
        Assert.Empty(DeepenLighting.Light(target, null, Inputs()));
    }

    [Theory(DisplayName = "deepen-3（最初の一歩は小さく）: 一歩の候補は 1〜3 時間で、週の時間と場所に収まるときだけ条件に合う")]
    [InlineData(1, TaskPlace.Home, 10, Place.HomeOnly, true)]
    [InlineData(3, TaskPlace.Home, 2, Place.HomeOnly, false)]
    [InlineData(4, TaskPlace.Home, 10, Place.HomeOnly, false)]
    [InlineData(1, TaskPlace.Out, 10, Place.HomeOnly, false)]
    [InlineData(1, TaskPlace.Out, 10, Place.CanGoOut, true)]
    public void StepFitRules(int hours, TaskPlace place, int week, Place userPlace, bool expected)
    {
        var step = new StepCandidate("s1", "すること", hours, place, false);
        Assert.Equal(expected, StepFit.Fits(step, Conditions(hours: week, place: userPlace)));
    }
}
