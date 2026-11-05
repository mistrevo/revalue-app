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

        var arrangement = lights.Single(l => l.Id == "online-secretary-arrangement");
        var usable = Assert.Single(arrangement.Usable);
        Assert.Equal(TestAbilities.BalancingInterests, usable.Ability);
        Assert.Equal(inputs.Abilities[0].Quotes, usable.Quotes);
        Assert.True(arrangement.MainUsable);
        Assert.False(arrangement.Drafted);

        var check = lights.Single(l => l.Id == "accounting-check");
        Assert.Empty(check.Usable);
        Assert.False(check.MainUsable);
        Assert.Equal(TestAbilities.NoticingChanges, check.Ability);
        Assert.Equal(Catalog.FindTask("accounting-check")!.Knowledge, check.Knowledge);
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 本人が外した力の業務は、根拠の言葉を出さずに、まだ確かめていない力として示す")]
    public void ExcludedAbilityIsNotYet()
    {
        var excluded = Inputs() with { Abilities = [], Excluded = [TestAbilities.BalancingInterests] };
        var lights = DeepenLighting.Light(Target(Options(CombineChoice())), null, excluded);

        var arrangement = lights.Single(l => l.Id == "online-secretary-arrangement");
        Assert.Empty(arrangement.Usable);
        Assert.False(arrangement.MainUsable);
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 業務の力が画面に出さない力なら、使えるところとして示さない")]
    public void HiddenAbilityIsNotLit()
    {
        var inputs = HiddenSettingPrioritiesInputs();
        var choice = new OptionChoice(ChoiceKind.Card, Now, CardKind.Choose,
            new ChooseCard("online-secretary", "オンライン秘書", "要約",
                [CardTaskOf("online-secretary-arrangement"), CardTaskOf("online-secretary-email")], new WorkRange(3, 10, 15000, 80000), "理由です。",
                new CardAbility(TestAbilities.BalancingInterests, AbilityState.Confirmed, [E(TestAbilities.BalancingInterests, 1, Q1)])),
            null, null, null);

        var lights = DeepenLighting.Light(Target(Options(choice)), null, inputs);

        Assert.Equal(TestAbilities.BalancingInterests, Assert.Single(lights.Single(l => l.Id == "online-secretary-arrangement").Usable).Ability);
        var email = lights.Single(l => l.Id == "online-secretary-email");
        Assert.Equal(TestAbilities.SettingPriorities, email.Ability);
        Assert.Empty(email.Usable);
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 登録した業務は、主な力と補助の力のうち使える力をすべて、主な力から順に、根拠の言葉と示す")]
    public void RegisteredTaskShowsAllUsableAbilities()
    {
        // 会議や面会の日程調整: 主な力は段取り力、補助の力は利害調整力と予定変更への対応力。使える力は利害調整力、段取り力の順で持つ
        var inputs = Inputs(usable: [TestAbilities.BalancingInterests, TestAbilities.PlanningSteps]);
        var light = Assert.Single(DeepenLighting.Light(Target(Options(ChooseChoice(taskId: "online-secretary-schedule"))), null, inputs));

        Assert.Equal(TestAbilities.PlanningSteps, light.Ability);
        Assert.True(light.MainUsable);
        Assert.Equal([TestAbilities.PlanningSteps, TestAbilities.BalancingInterests], light.Usable.Select(u => u.Ability));
        Assert.Equal(inputs.Abilities[1].Quotes, light.Usable[0].Quotes);
        Assert.Equal(inputs.Abilities[0].Quotes, light.Usable[1].Quotes);
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 主な力が使える力でなければ、主な力だけをまだ確かめていない力として示し、補助の力は並べない")]
    public void OnlyMainAbilityIsNotYet()
    {
        var light = Assert.Single(DeepenLighting.Light(Target(Options(ChooseChoice(taskId: "online-secretary-schedule"))), null, Inputs()));

        Assert.Equal(TestAbilities.PlanningSteps, light.Ability);
        Assert.False(light.MainUsable);
        // 使える補助の力（利害調整力）は使えるところに出し、使えない補助の力（予定変更への対応力）はどこにも並べない
        Assert.Equal([TestAbilities.BalancingInterests], light.Usable.Select(u => u.Ability));

        var dto = TaskLightDto.From(light);
        Assert.Equal(("planning-steps", AbilityText.Name(TestAbilities.PlanningSteps)), (dto.Ability, dto.AbilityName));
        Assert.Equal(["balancing-interests"], dto.Usable.Select(u => u.Key));
        Assert.Equal(AbilityText.Name(TestAbilities.BalancingInterests), dto.Usable[0].Name);
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 主な力が準備中の業務は、まだ確かめていない力の名前を出さず、使える補助の力は示す")]
    public void PreparingMainAbilityHasNoName()
    {
        // 課題の原因の見当づくり: 主な力は原因分析力（準備中）、補助の力は違和感察知力と仮説思考力（準備中）
        var sensing = new Ability("sensing-incongruity");
        var light = Assert.Single(DeepenLighting.Light(
            Target(Options(ChooseChoice(taskId: "planning-cause-hypothesis"))), null, Inputs(usable: [sensing])));

        Assert.False(AbilityCatalog.IsActive(light.Ability));
        Assert.False(light.MainUsable);
        Assert.Null(light.Scene);
        Assert.Equal([sensing], light.Usable.Select(u => u.Ability));

        var dto = TaskLightDto.From(light);
        Assert.Null(dto.Ability);
        Assert.Null(dto.AbilityName);
        Assert.Equal(["sensing-incongruity"], dto.Usable.Select(u => u.Key));
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 主な力が使える力のときだけ、力が生きる場面を添える")]
    public void SceneOnlyWhenMainIsUsable()
    {
        var lights = DeepenLighting.Light(Target(Options(CombineChoice())), null, Inputs());

        // 出張や会食の手配の主な力は利害調整力（使える力）
        var arrangement = lights.Single(l => l.Id == "online-secretary-arrangement");
        Assert.Equal(Catalog.FindTask("online-secretary-arrangement")!.Scene, arrangement.Scene);
        Assert.Equal(arrangement.Scene, TaskLightDto.From(arrangement).Scene);
        // 帳簿と口座の照合の主な力は変化察知力（使える力でない）
        Assert.Null(lights.Single(l => l.Id == "accounting-check").Scene);

        // 補助の力（利害調整力）だけが使える力の業務にも添えない
        var schedule = Assert.Single(DeepenLighting.Light(Target(Options(ChooseChoice(taskId: "online-secretary-schedule"))), null, Inputs()));
        Assert.NotEmpty(schedule.Usable);
        Assert.Null(schedule.Scene);
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 登録した業務には本人に確かめる条件を並べ、AI の見立ての業務には並べない")]
    public void ChecksOnlyForRegisteredTasks()
    {
        var lights = DeepenLighting.Light(Target(Options(CombineChoice())), null, Inputs());

        var check = lights.Single(l => l.Id == "accounting-check");
        Assert.NotEmpty(check.Checks);
        Assert.Equal(Catalog.FindTask("accounting-check")!.Checks, check.Checks);
        Assert.Equal(check.Checks, TaskLightDto.From(check).Checks);
        Assert.Empty(lights.Single(l => l.Id == "online-secretary-arrangement").Checks);

        var content = new DeepenContent(
            Now, "b", [new DeepenTask("t1", "予定の取りまとめ", "中身", TestAbilities.BalancingInterests, "表計算")], false, [], [], false);
        var drafted = Assert.Single(DeepenLighting.Light(Target(Options(CreateChoice())), content, Inputs()));
        Assert.Empty(drafted.Checks);
        Assert.Null(drafted.Scene);
    }

    [Fact(DisplayName = "validate-12（本人が見立てを外せる）: 外した力と画面に出さない力は、業務の補助の力でも使えるところに出さず、力が生きる場面も添えない")]
    public void ExcludedAndHiddenSubAbilitiesAreNotLit()
    {
        // 外した力: 会議や面会の日程調整の補助の力（利害調整力）
        var excluded = Inputs() with { Abilities = [], Excluded = [TestAbilities.BalancingInterests] };
        var schedule = Assert.Single(DeepenLighting.Light(Target(Options(ChooseChoice(taskId: "online-secretary-schedule"))), null, excluded));
        Assert.Empty(schedule.Usable);
        Assert.Null(schedule.Scene);

        // 外した力が主な力の業務（出張や会食の手配）も、使えるところと力が生きる場面を出さない
        var arrangement = Assert.Single(DeepenLighting.Light(Target(Options(ChooseChoice())), null, excluded));
        Assert.Empty(arrangement.Usable);
        Assert.Null(arrangement.Scene);

        // 画面に出さない力: 月の締めの進行管理の補助の力（優先順位設定力）。見せた補助の力（利害調整力）だけを示す
        var monthly = Assert.Single(DeepenLighting.Light(
            Target(Options(ChooseChoice(taskId: "accounting-monthly"))), null, HiddenSettingPrioritiesInputs()));
        Assert.Equal([TestAbilities.BalancingInterests], monthly.Usable.Select(u => u.Ability));
        Assert.Null(monthly.Scene);
    }

    /// <summary>利害調整力と優先順位設定力（どちらも行動 3 つ、同じ分類）が同じ出来事でそろう人。見せるのは辞書の順で前の利害調整力。</summary>
    private static OptionsInputs HiddenSettingPrioritiesInputs()
    {
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
        Assert.DoesNotContain(inputs.Abilities, a => a.Ability == TestAbilities.SettingPriorities);
        return inputs;
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
        Assert.Single(lights[0].Usable);
        Assert.True(lights[0].MainUsable);
        Assert.Empty(lights[1].Knowledge);
        Assert.Empty(lights[1].Usable);
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
