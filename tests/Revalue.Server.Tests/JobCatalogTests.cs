using System.Text.Json.Nodes;
using Revalue.Server.Features.Deepen;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

public sealed class JobCatalogTests
{
    /// <summary>業務マスターに置き換える前からある 12 業務と、その職種。保存データが id で引くので残す。</summary>
    private static readonly (string Occupation, string[] Tasks)[] KeptTasks =
    [
        ("online-secretary", ["online-secretary-email", "online-secretary-schedule", "online-secretary-arrangement", "online-secretary-briefing"]),
        ("accounting-clerk", ["accounting-check", "accounting-invoice", "accounting-monthly", "accounting-cash"]),
        ("recruiting-clerk", ["recruiting-posting", "recruiting-interview-schedule", "recruiting-applications", "recruiting-reception"]),
    ];

    [Fact(DisplayName = "options-9（業務マスターの形を守る）: 登録データは 10 の領域、30 の職種、125 の業務を持ち、カードに使う業務は 115")]
    public void RegisteredDataHasTheTaskMaster()
    {
        var catalog = JobCatalog.Load();

        Assert.Equal(10, catalog.Domains.Count);
        Assert.Equal(30, catalog.Occupations.Count);
        Assert.Equal(125, catalog.AllTasks.Count());
        Assert.Equal(115, catalog.ActiveTasks.Count());
        Assert.All(catalog.ActiveTasks, t => Assert.True(t.IsActive));
        Assert.Equal("経理事務", catalog.Occupations[0].Name);
        var ids = catalog.AllTasks.Select(t => t.Id).ToList();
        Assert.Equal(ids.Count, ids.Distinct().Count());
        Assert.All(catalog.ActiveTasks, t => Assert.NotEmpty(t.JobTagTasks));
        Assert.Equal("経理事務", catalog.OccupationOf(catalog.FindTask("accounting-check")!).Name);
        Assert.Null(catalog.FindOccupation("no-such-occupation"));
    }

    [Fact(DisplayName = "options-9（業務マスターの形を守る）: 話から確かめる力それぞれに、カードに使う業務が 2 つ以上つながる（主な力か補助の力）")]
    public void EveryActiveAbilityHasTasks()
    {
        var catalog = JobCatalog.Load();

        Assert.All(AbilityCatalog.Active, ability =>
            Assert.True(catalog.ActiveTasks.Count(t => t.Uses(ability)) >= 2, $"{ability.Id} has fewer than two tasks."));
    }

    [Fact(DisplayName = "options-9（業務マスターの形を守る）: カードに使う業務の時給の目安の下限は 1,300 円以上で、上限は下限以上")]
    public void HourlyYenIsAtLeastTheFloor()
    {
        var catalog = JobCatalog.Load();

        Assert.All(catalog.AllTasks, t => Assert.True(t.HourlyYen.Min >= 1300 && t.HourlyYen.Max >= t.HourlyYen.Min, t.Id));
        Assert.Contains("1,300 円", catalog.Source.Note);
    }

    [Fact(DisplayName = "options-9（業務マスターの形を守る）: 保険の営業とキャリアコンサルタントの業務は準備中で、カードに使う業務のない職種はその 2 つと職種の決まっていない 3 つだけ")]
    public void PreparingOccupationsAreKnown()
    {
        var catalog = JobCatalog.Load();

        Assert.All(catalog.FindOccupation("insurance-sales")!.Tasks, t => Assert.Equal(JobTaskStatus.Preparing, t.Status));
        Assert.All(catalog.FindOccupation("career-consultant")!.Tasks, t => Assert.Equal(JobTaskStatus.Preparing, t.Status));
        Assert.Equal(
            ["career-consultant", "insurance-sales", "logistics-unassigned", "planning-unassigned", "service-unassigned"],
            catalog.Occupations.Where(o => !o.Tasks.Any(t => t.IsActive)).Select(o => o.Id).Order(StringComparer.Ordinal));
        Assert.Null(catalog.FindActiveTask("insurance-sales-hearing"));
        Assert.NotNull(catalog.FindTask("insurance-sales-hearing"));
    }

    [Fact(DisplayName = "options-9（業務マスターの形を守る）: いまの 12 業務の id は残り、カードに使う業務で、職種も前と同じ")]
    public void KeptTaskIdsRemain()
    {
        var catalog = JobCatalog.Load();

        foreach (var (occupation, tasks) in KeptTasks)
        {
            foreach (var id in tasks)
            {
                var task = catalog.FindActiveTask(id);
                Assert.NotNull(task);
                Assert.Equal(occupation, catalog.OccupationOf(task).Id);
            }
        }
    }

    [Fact(DisplayName = "options-9（業務マスターの形を守る）: 業務の力は辞書にある力で、主な力と補助の力が重ならず、補助の力は 3 つまで")]
    public void TaskAbilitiesAreInTheDictionary()
    {
        var catalog = JobCatalog.Load();

        Assert.All(catalog.AllTasks, t =>
        {
            Assert.All(t.Abilities.All, a => Assert.NotNull(AbilityCatalog.Find(a.Id)));
            Assert.DoesNotContain(t.Abilities.Main, t.Abilities.Sub);
            Assert.True(t.Abilities.Sub.Count <= 3);
            Assert.Equal(t.Abilities.Sub.Count, t.Abilities.Sub.Distinct().Count());
            Assert.Equal(t.Abilities.All.Where(AbilityCatalog.IsActive), t.ActiveAbilities);
        });
    }

    [Fact(DisplayName = "options-9（業務マスターの形を守る）: 業務の名前、中身、知識や道具、活用場面、小さな試し方は決めた長さまで")]
    public void TaskTextsFitTheirLimits()
    {
        var catalog = JobCatalog.Load();

        Assert.All(catalog.AllTasks, t =>
        {
            Assert.True(t.Name.Length <= 30, t.Id);
            Assert.True(t.Detail.Length <= 80, t.Id);
            Assert.All(t.Knowledge, k => Assert.True(k.Length <= 60, t.Id));
            Assert.True(t.Scene.Length <= 80, t.Id);
            Assert.True(t.Trial.Length <= 100, t.Id);
        });
    }

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: 出典は job tag の利用規約の記載例どおりに持つ")]
    public void SourceFollowsTheTermsOfUse()
    {
        var source = JobCatalog.Load().Source;

        Assert.Contains("簡易版数値系ダウンロードデータ　ver.7.00", source.Text);
        Assert.Contains("を加工して作成", source.Text);
        Assert.Contains("https://shigoto.mhlw.go.jp/User/download", source.Text);
    }

    [Fact(DisplayName = "common-1（使わない言葉を出さない）: 登録データの言葉に、使わない言葉、言い切りと順位の言葉、大げさな褒め言葉、お金の額がない")]
    public void RegisteredDataHasNoForbiddenWords()
    {
        var forbidden = ForbiddenWordList.Load();
        var catalog = JobCatalog.Load();

        void Clean(string text)
        {
            Assert.Null(forbidden.FirstIn(text));
            Assert.Null(OptionsValidator.AssertiveIn(text));
            Assert.Null(OptionsValidator.PraiseIn(text));
            Assert.False(OptionsValidator.HasMoneyAmount(text), text);
        }

        foreach (var occupation in catalog.Occupations)
        {
            Clean(occupation.Name);
            Clean(occupation.Summary);
            foreach (var task in occupation.Tasks)
            {
                Clean(task.Name);
                Clean(task.Detail);
                Clean(task.Scene);
                Clean(task.Trial);
                Assert.All(task.Knowledge, Clean);
                Assert.All(task.Checks, Clean);
            }
        }
    }

    [Fact(DisplayName = "options-9（業務マスターの形を守る）: 小さな試し方は、一歩で落とす言葉（応募、契約、購入など）を含まない")]
    public void TrialsHaveNoPushyWords()
    {
        var catalog = JobCatalog.Load();

        Assert.All(catalog.AllTasks, t =>
            Assert.DoesNotContain(DeepenValidator.PushyStepWords, w => t.Trial.Contains(w, StringComparison.Ordinal)));
    }

    [Fact(DisplayName = "common-1（使わない言葉を出さない）: 力の名前の「順位」は数えず、ほかの使わない言葉は見つける")]
    public void ForbiddenWordsIgnoreAbilityNames()
    {
        var forbidden = ForbiddenWordList.Load();

        Assert.Null(forbidden.FirstIn("優先順位設定力が生かせます"));
        Assert.Equal("順位", forbidden.FirstIn("順位をつけました"));
        Assert.Equal("あなたに向いている仕事は", forbidden.FirstIn("あなたに向いている仕事は経理です"));
    }

    /// <summary>
    /// 正しい小さいデータ。o1 は job tag のある職種で、t1 は補助の力を持つ業務、t2 は主な力が準備中の力（原因分析力）の業務。
    /// o2 は job tag があり業務がすべて準備中の職種、o3 は job tag がなく業務がすべて準備中の職種。
    /// </summary>
    private static JsonObject Valid() => JsonNode.Parse("""
        {
          "source": { "text": "出典", "url": "https://example.com", "note": "注" },
          "domains": [ { "id": "d1", "name": "領域" } ],
          "occupations": [
            { "id": "o1", "name": "職種", "domain": "d1", "summary": "説明", "jobtag": { "number": 1, "name": "名" },
              "tasks": [
                { "id": "t1", "name": "業務", "detail": "中身", "status": "active", "needsReview": false, "jobtagTasks": [1],
                  "abilities": { "main": "balancing-interests", "sub": ["planning-steps"] }, "scene": "場面",
                  "hoursPerWeek": { "min": 3, "max": 10 }, "timeSlots": ["daytime"], "place": "home",
                  "hourlyYen": { "min": 1300, "max": 1500 }, "knowledge": [], "trial": "試し方", "checks": ["確かめること"] },
                { "id": "t2", "name": "業務", "detail": "中身", "status": "active", "needsReview": true, "jobtagTasks": [2],
                  "abilities": { "main": "cause-analysis", "sub": ["noticing-changes"] }, "scene": "場面",
                  "hoursPerWeek": { "min": 3, "max": 10 }, "timeSlots": ["daytime"], "place": "home",
                  "hourlyYen": { "min": 1300, "max": 1500 }, "knowledge": [], "trial": "試し方", "checks": [] }
              ] },
            { "id": "o2", "name": "職種", "domain": "d1", "summary": "説明", "jobtag": { "number": 2, "name": "名" },
              "tasks": [
                { "id": "t3", "name": "業務", "detail": "中身", "status": "preparing", "needsReview": false, "jobtagTasks": [1],
                  "abilities": { "main": "active-listening", "sub": [] }, "scene": "場面",
                  "hoursPerWeek": { "min": 3, "max": 10 }, "timeSlots": ["daytime"], "place": "home",
                  "hourlyYen": { "min": 1300, "max": 1500 }, "knowledge": [], "trial": "試し方", "checks": [] }
              ] },
            { "id": "o3", "name": "職種", "domain": "d1", "summary": "説明", "jobtag": null,
              "tasks": [
                { "id": "t4", "name": "業務", "detail": "中身", "status": "preparing", "needsReview": false, "jobtagTasks": [],
                  "abilities": { "main": "active-listening", "sub": [] }, "scene": "場面",
                  "hoursPerWeek": { "min": 3, "max": 10 }, "timeSlots": ["daytime"], "place": "home",
                  "hourlyYen": { "min": 1300, "max": 1500 }, "knowledge": [], "trial": "試し方", "checks": [] }
              ] }
          ]
        }
        """)!.AsObject();

    private static JsonObject Task1(JsonObject root) => root["occupations"]![0]!["tasks"]![0]!.AsObject();

    [Fact(DisplayName = "options-9（業務マスターの形を守る）: 正しい小さいデータは読め、準備中の力を持つ業務と、業務がすべて準備中の職種（job tag あり・なし）も読める")]
    public void ParseReadsValidData()
    {
        var catalog = JobCatalog.Parse(Valid().ToJsonString());

        Assert.Equal(3, catalog.Occupations.Count);
        Assert.Equal(["t1", "t2"], catalog.ActiveTasks.Select(t => t.Id));
        Assert.Null(catalog.Occupations[2].JobTag);
        Assert.Equal("d1", catalog.Occupations[0].DomainId);

        var t1 = catalog.FindTask("t1")!;
        Assert.Equal(TestAbilities.BalancingInterests, t1.Abilities.Main);
        Assert.Equal([TestAbilities.BalancingInterests, TestAbilities.PlanningSteps], t1.Abilities.All);
        Assert.True(t1.Uses(TestAbilities.PlanningSteps));
        Assert.Equal(("場面", "試し方", "確かめること"), (t1.Scene, t1.Trial, Assert.Single(t1.Checks)));

        // 準備中の力は業務の力として持てるが、業務がつながる力には数えない
        var t2 = catalog.FindTask("t2")!;
        Assert.Equal("cause-analysis", t2.Abilities.Main.Id);
        Assert.Equal([TestAbilities.NoticingChanges], t2.ActiveAbilities);
        Assert.False(t2.Uses(t2.Abilities.Main));
        Assert.True(t2.NeedsReview);

        Assert.Null(catalog.FindActiveTask("t3"));
        Assert.Equal(JobTaskStatus.Preparing, catalog.FindTask("t3")!.Status);
    }

    [Theory(DisplayName = "options-9（業務マスターの形を守る）: 壊れたデータは読み込みで止める")]
    [InlineData("duplicate-id")]
    [InlineData("hours-reversed")]
    [InlineData("hours-zero")]
    [InlineData("no-slot")]
    [InlineData("unknown-slot")]
    [InlineData("unknown-ability")]
    [InlineData("old-ability-id")]
    [InlineData("unknown-sub-ability")]
    [InlineData("main-in-sub")]
    [InlineData("four-subs")]
    [InlineData("unknown-domain")]
    [InlineData("duplicate-domain")]
    [InlineData("unknown-status")]
    [InlineData("bad-id")]
    [InlineData("bad-occupation-id")]
    [InlineData("active-without-jobtag")]
    [InlineData("active-without-jobtag-tasks")]
    [InlineData("empty-scene")]
    [InlineData("empty-trial")]
    [InlineData("empty-name")]
    [InlineData("bad-yen")]
    public void BrokenDataStopsLoading(string broken)
    {
        var root = Valid();
        var task = Task1(root);
        switch (broken)
        {
            case "duplicate-id": task["id"] = "o1"; break;
            case "hours-reversed": task["hoursPerWeek"] = new JsonObject { ["min"] = 11, ["max"] = 10 }; break;
            case "hours-zero": task["hoursPerWeek"] = new JsonObject { ["min"] = 0, ["max"] = 10 }; break;
            case "no-slot": task["timeSlots"] = new JsonArray(); break;
            case "unknown-slot": task["timeSlots"] = new JsonArray("noon"); break;
            case "unknown-ability": task["abilities"]!["main"] = "cooking"; break;
            case "old-ability-id": task["abilities"]!["main"] = "coordinating"; break;
            case "unknown-sub-ability": task["abilities"]!["sub"] = new JsonArray("cooking"); break;
            case "main-in-sub": task["abilities"]!["sub"] = new JsonArray("balancing-interests"); break;
            case "four-subs": task["abilities"]!["sub"] = new JsonArray("planning-steps", "noticing-changes", "setting-priorities", "empathy"); break;
            case "unknown-domain": root["occupations"]![0]!["domain"] = "d9"; break;
            case "duplicate-domain": root["domains"]!.AsArray().Add(new JsonObject { ["id"] = "d1", ["name"] = "領域" }); break;
            case "unknown-status": task["status"] = "draft"; break;
            case "bad-id": task["id"] = "T01-001"; break;
            case "bad-occupation-id": root["occupations"]![0]!["id"] = "o 1"; break;
            case "active-without-jobtag": root["occupations"]![2]!["tasks"]![0]!["status"] = "active"; break;
            case "active-without-jobtag-tasks": task["jobtagTasks"] = new JsonArray(); break;
            case "empty-scene": task["scene"] = ""; break;
            case "empty-trial": task["trial"] = " "; break;
            case "empty-name": task["name"] = ""; break;
            case "bad-yen": task["hourlyYen"] = new JsonObject { ["min"] = 1500, ["max"] = 1300 }; break;
            default: throw new ArgumentOutOfRangeException(nameof(broken));
        }

        Assert.Throws<InvalidOperationException>(() => JobCatalog.Parse(root.ToJsonString()));
    }

    [Fact(DisplayName = "options-9（業務マスターの形を守る）: JSON でないデータも読み込みで止める")]
    public void NotJsonStopsLoading() => Assert.Throws<InvalidOperationException>(() => JobCatalog.Parse("not json"));

    [Fact(DisplayName = "options-9（業務マスターの形を守る）: 業務マスターの版は jobs.json の中身から決まり、中身が変われば変わる")]
    public void VersionFollowsTheContent()
    {
        var catalog = JobCatalog.Load();
        using var stream = typeof(JobCatalog).Assembly.GetManifestResourceStream("jobs.json")!;
        using var reader = new StreamReader(stream);
        var json = reader.ReadToEnd();

        Assert.Equal(64, catalog.Version.Length);
        Assert.Equal(catalog.Version, JobCatalog.Parse(json).Version);
        Assert.NotEqual(catalog.Version, JobCatalog.Parse(json.Replace("帳簿と口座の照合", "帳簿と口座の突き合わせ")).Version);
    }
}
