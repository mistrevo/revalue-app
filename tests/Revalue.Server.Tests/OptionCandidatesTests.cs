using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

/// <summary>AI に渡す候補の決め方（05-options.md の「AI が書いた中身をコードで確かめる」）。小さい業務マスターで確かめる。</summary>
public sealed class OptionCandidatesTests
{
    /// <summary>
    /// o1: t1（主な力は利害調整力）、t2（主な力は変化への気づき、補助の力に段取り力）、t3（準備中。主な力は利害調整力）。
    /// o2: t4（主な力は優先順位設定力、補助の力に利害調整力）、t5（主な力は共感力）。
    /// o3: t6（主な力は利害調整力。夜だけ）。どの業務も週 3 時間から、家でできる。
    /// </summary>
    private static readonly JobCatalog Catalog = JobCatalog.Parse($$"""
        {
          "source": { "text": "出典", "url": "https://example.com", "note": "注" },
          "domains": [ { "id": "d", "name": "領域" } ],
          "occupations": [
            { "id": "o1", "name": "職種 1", "domain": "d", "summary": "説明", "jobtag": { "number": 1, "name": "名" },
              "tasks": [ {{Task("t1", "active", "balancing-interests")}}, {{Task("t2", "active", "noticing-changes", "planning-steps")}},
                         {{Task("t3", "preparing", "balancing-interests")}} ] },
            { "id": "o2", "name": "職種 2", "domain": "d", "summary": "説明", "jobtag": { "number": 2, "name": "名" },
              "tasks": [ {{Task("t4", "active", "setting-priorities", "balancing-interests")}}, {{Task("t5", "active", "empathy")}} ] },
            { "id": "o3", "name": "職種 3", "domain": "d", "summary": "説明", "jobtag": { "number": 3, "name": "名" },
              "tasks": [ {{Task("t6", "active", "balancing-interests", slot: "night")}} ] }
          ]
        }
        """);

    private static string Task(string id, string status, string main, string? sub = null, string slot = "daytime") => $$"""
        { "id": "{{id}}", "name": "業務", "detail": "中身", "status": "{{status}}", "needsReview": false, "jobtagTasks": [1],
          "abilities": { "main": "{{main}}", "sub": [{{(sub is null ? "" : $"\"{sub}\"")}}] }, "scene": "場面",
          "hoursPerWeek": { "min": 3, "max": 10 }, "timeSlots": ["{{slot}}"], "place": "home",
          "hourlyYen": { "min": 1300, "max": 1500 }, "knowledge": [], "trial": "試し方", "checks": [] }
        """;

    private static OptionsInputs Inputs(int hours = 10, params Ability[] usable) =>
        new(
            new ProfileConditions([TimeSlot.Daytime], hours, Place.HomeOnly, null),
            true,
            usable.Select(a => new UsableAbility(a, AbilityState.NeedsCheck, [new Evidence(a, 1, "架空-予定を見比べました", 1, 1, false, false, null)])).ToList(),
            [],
            [],
            [],
            null);

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: AI に渡す候補は、条件に合い、使える力のどれかにつながる業務だけで、準備中の業務を含まない")]
    public void CandidatesAreFittingConnectedActiveTasks()
    {
        var candidates = OptionCandidates.From(Catalog, Inputs(usable: TestAbilities.BalancingInterests));

        Assert.Equal(["t1", "t4"], candidates.Tasks.Select(t => t.Id));
        Assert.Equal(["o1", "o2"], candidates.Occupations.Select(o => o.Id));
        Assert.Equal(["t1"], candidates.Occupations[0].Tasks.Select(t => t.Id));
        Assert.Equal(["t4"], candidates.Occupations[1].Tasks.Select(t => t.Id));
        Assert.True(candidates.CanChoose);
        Assert.True(candidates.CanCombine);
    }

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: 条件に合う業務はあるが、どれも使える力につながらなければ、選ぶは noAbilityMatch")]
    public void NoConnectedTaskIsNoAbilityMatch()
    {
        var candidates = OptionCandidates.From(Catalog, Inputs(usable: TestAbilities.Resilience));

        Assert.Empty(candidates.Tasks);
        Assert.Empty(candidates.Occupations);
        Assert.Equal(MissingReason.NoAbilityMatch, candidates.ChooseBlocked);
        Assert.Equal(MissingReason.NoAbilityMatch, candidates.CombineBlocked);
    }

    [Fact(DisplayName = "options-3（組み合わせるは登録した業務から）: 使える力につながる業務が 1 つの職種にしかなければ、組み合わせるは noAbilityMatch で、条件に合う組がなければ noFit")]
    public void CombineNeedsConnectedTasksInTwoOccupations()
    {
        // 変化への気づきにつながるのは o1 の t2 だけ。条件に合う組（o1 と o2 の業務で週 6 時間から）はある
        var single = OptionCandidates.From(Catalog, Inputs(usable: TestAbilities.NoticingChanges));
        Assert.Equal(["t2"], single.Tasks.Select(t => t.Id));
        Assert.True(single.CanChoose);
        Assert.Equal(MissingReason.NoAbilityMatch, single.CombineBlocked);

        // 週 3 時間: どの組も 6 時間からで、条件に合う組がない
        var tight = OptionCandidates.From(Catalog, Inputs(3, TestAbilities.BalancingInterests));
        Assert.True(tight.CanChoose);
        Assert.Equal(MissingReason.NoFit, tight.CombineBlocked);
    }

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: 補助の力だけでつながる業務も候補に入る")]
    public void SubAbilityConnects()
    {
        var candidates = OptionCandidates.From(Catalog, Inputs(usable: TestAbilities.PlanningSteps));

        Assert.Equal(["t2"], candidates.Tasks.Select(t => t.Id));
        Assert.True(candidates.CanChoose);
    }

    [Fact(DisplayName = "options-5（条件の範囲だけ）: 条件に合う業務がなければ、使える力にかかわらず、どちらも noFit")]
    public void NoFittingTaskIsNoFit()
    {
        var candidates = OptionCandidates.From(Catalog, Inputs(2, TestAbilities.BalancingInterests));

        Assert.Empty(candidates.Tasks);
        Assert.Equal(MissingReason.NoFit, candidates.ChooseBlocked);
        Assert.Equal(MissingReason.NoFit, candidates.CombineBlocked);
    }
}
