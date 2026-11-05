using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Options;

namespace Revalue.Server.Tests;

public sealed class JobCatalogTests
{
    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: 登録データは 3 職種で、職種ごとに業務が 4 つある")]
    public void RegisteredDataHasThreeOccupationsWithFourTasks()
    {
        var catalog = JobCatalog.Load();

        Assert.Equal(["オンライン秘書", "経理事務", "採用事務"], catalog.Occupations.Select(o => o.Name));
        Assert.All(catalog.Occupations, o => Assert.Equal(4, o.Tasks.Count));
        var ids = catalog.AllTasks.Select(t => t.Id).ToList();
        Assert.Equal(ids.Count, ids.Distinct().Count());
        Assert.All(catalog.AllTasks, t => Assert.NotEmpty(t.JobTagTasks));
        Assert.Equal("accounting-check", catalog.FindTask("accounting-check")!.Id);
        Assert.Equal("経理事務", catalog.OccupationOf(catalog.FindTask("accounting-check")!).Name);
        Assert.Null(catalog.FindOccupation("no-such-occupation"));
    }

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: 出典は job tag の利用規約の記載例どおりに持つ")]
    public void SourceFollowsTheTermsOfUse()
    {
        var source = JobCatalog.Load().Source;

        Assert.Contains("簡易版数値系ダウンロードデータ　ver.7.00", source.Text);
        Assert.Contains("を加工して作成", source.Text);
        Assert.Contains("https://shigoto.mhlw.go.jp/User/download", source.Text);
    }

    [Fact(DisplayName = "common-1（使わない言葉を出さない）: 登録データの言葉に使わない言葉がない")]
    public void RegisteredDataHasNoForbiddenWords()
    {
        var forbidden = ForbiddenWordList.Load();
        var catalog = JobCatalog.Load();

        foreach (var occupation in catalog.Occupations)
        {
            Assert.Null(forbidden.FirstIn(occupation.Name));
            Assert.Null(forbidden.FirstIn(occupation.Summary));
            foreach (var task in occupation.Tasks)
            {
                Assert.Null(forbidden.FirstIn(task.Name));
                Assert.Null(forbidden.FirstIn(task.Detail));
                Assert.All(task.Knowledge, k => Assert.Null(forbidden.FirstIn(k)));
            }
        }
    }

    [Fact(DisplayName = "common-1（使わない言葉を出さない）: 力の名前の「順位」は数えず、ほかの使わない言葉は見つける")]
    public void ForbiddenWordsIgnoreAbilityNames()
    {
        var forbidden = ForbiddenWordList.Load();

        Assert.Null(forbidden.FirstIn("優先順位設定力が生かせます"));
        Assert.Equal("順位", forbidden.FirstIn("順位をつけました"));
        Assert.Equal("あなたに向いている仕事は", forbidden.FirstIn("あなたに向いている仕事は経理です"));
    }

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: 12 の業務の使う力は、置き換え先の力の id になっている")]
    public void TasksUseReplacementAbilities()
    {
        var catalog = JobCatalog.Load();

        Assert.Equal(12, catalog.AllTasks.Count());
        string[] replacements = ["noticing-changes", "balancing-interests", "setting-priorities"];
        Assert.All(catalog.AllTasks, t => Assert.Contains(t.Ability.Id, replacements));
        Assert.All(catalog.AllTasks, t => Assert.Contains(t.Ability, Revalue.Server.Features.Validate.AbilityCatalog.Active));
    }

    private static string Json(string occupationId = "o1", string taskId = "t1", int min = 3, int max = 10, string slots = "\"daytime\"", string ability = "balancing-interests")
        => $$"""
        {
          "source": { "text": "出典", "url": "https://example.com", "note": "注" },
          "occupations": [
            { "id": "{{occupationId}}", "name": "職種", "summary": "説明", "jobtag": { "number": 1, "name": "名" },
              "tasks": [
                { "id": "{{taskId}}", "name": "業務", "detail": "中身", "jobtagTasks": [1], "ability": "{{ability}}",
                  "hoursPerWeek": { "min": {{min}}, "max": {{max}} }, "timeSlots": [{{slots}}], "place": "home",
                  "hourlyYen": { "min": 1000, "max": 1500 }, "knowledge": [] }
              ] }
          ]
        }
        """;

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: 正しい小さいデータは読める")]
    public void ParseReadsValidData() => Assert.Single(JobCatalog.Parse(Json()).Occupations);

    [Theory(DisplayName = "options-2（選ぶは登録した職種から）: 壊れたデータは読み込みで止める")]
    [InlineData("same", "same", 3, 10, "\"daytime\"", "balancing-interests")]
    [InlineData("o1", "t1", 11, 10, "\"daytime\"", "balancing-interests")]
    [InlineData("o1", "t1", 0, 10, "\"daytime\"", "balancing-interests")]
    [InlineData("o1", "t1", 3, 10, "", "balancing-interests")]
    [InlineData("o1", "t1", 3, 10, "\"daytime\"", "cooking")]
    [InlineData("o1", "t1", 3, 10, "\"daytime\"", "coordinating")]
    [InlineData("o1", "t1", 3, 10, "\"noon\"", "balancing-interests")]
    public void BrokenDataStopsLoading(string occupationId, string taskId, int min, int max, string slots, string ability) =>
        Assert.Throws<InvalidOperationException>(() => JobCatalog.Parse(Json(occupationId, taskId, min, max, slots, ability)));

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: JSON でないデータも読み込みで止める")]
    public void NotJsonStopsLoading() => Assert.Throws<InvalidOperationException>(() => JobCatalog.Parse("not json"));
}
