using Revalue.Server.Features.Deepen;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;
using static Revalue.Server.Tests.DeepenTestKit;

namespace Revalue.Server.Tests;

public sealed class DeepenValidatorTests
{
    private static readonly ForbiddenWordList Forbidden = ForbiddenWordList.Load();

    private static StepDraft Step(string text = "知りたいことを書き出してみる", int hours = 1, string place = "home", bool demand = false) =>
        new(text, hours, place, demand);

    private static IReadOnlyList<StepDraft> GoodSteps(bool demand = false) =>
        [Step("知りたいことを書き出してみる", 1, "home", demand), Step("体験談を読んでみる", 2), Step("一日の流れを書き出してみる", 3)];

    private static QuestionDraft Question(string ability = "balancing-interests", string situation = "もし同じ日に二つの依頼が届いたら、どうしますか？", string[]? choices = null) =>
        new(situation, ability, choices ?? ["それぞれに期限を聞く", "先に届いた依頼から進める", "まとめて相談する"]);

    private static TaskDraft TaskD(string name = "予定の取りまとめ", string ability = "balancing-interests", string knowledge = "") =>
        new(name, "中身です", ability, knowledge);

    private static DeepenDraft Draft(IReadOnlyList<StepDraft>? steps = null, IReadOnlyList<QuestionDraft>? questions = null, IReadOnlyList<TaskDraft>? tasks = null) =>
        new(tasks ?? [], questions ?? [Question()], steps ?? GoodSteps());

    private static (DeepenContent Content, IReadOnlyList<DeepenRejection> Rejections) Build(
        DeepenDraft draft, OptionsItem? options = null, ProfileConditions? conditions = null)
    {
        conditions ??= Conditions();
        var target = Target(options ?? Options(ChooseChoice()), conditions);
        return DeepenValidator.Build(draft, target, conditions, Forbidden, Now);
    }

    [Fact(DisplayName = "deepen-3（最初の一歩は小さく）: 条件に収まる 3 つの候補は、そのまま一歩の候補になる")]
    public void GoodStepsPass()
    {
        var (content, rejections) = Build(Draft());

        Assert.Empty(rejections);
        Assert.False(content.StepsFallback);
        Assert.Equal(["s1", "s2", "s3"], content.Steps.Select(s => s.Id));
        Assert.Equal([1, 2, 3], content.Steps.Select(s => s.Hours));
    }

    [Fact(DisplayName = "deepen-3（最初の一歩は小さく）: 条件の外の候補があれば、3 つともコードの候補に置き換える")]
    public void StepsOutsideConditionsFallBack()
    {
        var bad = new (IReadOnlyList<StepDraft> Steps, ProfileConditions Conditions)[]
        {
            ([Step(), Step(), Step(place: "out")], Conditions()),
            ([Step(), Step(), Step(hours: 4)], Conditions()),
            ([Step(), Step(), Step(hours: 3)], Conditions(hours: 2)),
            ([Step(), Step()], Conditions()),
            ([Step(), Step(), Step(place: "sky")], Conditions()),
            ([Step(), Step(), Step(hours: 0)], Conditions()),
        };

        foreach (var (steps, conditions) in bad)
        {
            var (content, rejections) = Build(Draft(steps: steps), conditions: conditions);
            Assert.True(content.StepsFallback);
            Assert.Equal(["f1", "f2", "f3"], content.Steps.Select(s => s.Id));
            Assert.Contains(rejections, r => r.Part == "steps");
        }
    }

    [Fact(DisplayName = "deepen-3（最初の一歩は小さく）: 応募、契約、お金を払うこと、勧める言い方の一歩があれば、3 つともコードの候補に置き換える")]
    public void PushyStepsFallBack()
    {
        foreach (var text in new[]
        {
            "この仕事の募集に応募してみる",
            "オンライン秘書の会社と契約してみる",
            "説明会に申し込んでみる",
            "表計算の教材を購入してみる",
            "まずは体験談を読みましょう",
            "毎日 1 時間は練習すべき",
        })
        {
            var (content, rejections) = Build(Draft(steps: [Step(), Step(), Step(text)]));
            Assert.True(content.StepsFallback, $"{text}: {string.Join(",", rejections)}");
            Assert.Contains(new DeepenRejection("steps", "pushyStep"), rejections);
        }

        // 「募集を読む」は応募ではない
        var (ok, _) = Build(Draft(steps: [Step(), Step(), Step("この仕事の募集を 2 件読んで、業務を書き出してみる")]));
        Assert.False(ok.StepsFallback);
    }

    [Fact(DisplayName = "deepen-4（創るの一歩には需要の確かめを入れる）: 「創る」で需要の確かめのない候補は、需要の確かめを含むコードの候補に置き換える")]
    public void CreateNeedsDemandCheck()
    {
        var options = Options(CreateChoice());
        var (none, rejections) = Build(Draft(steps: GoodSteps(demand: false), tasks: [TaskD(), TaskD("順番決め", "setting-priorities")]), options);
        Assert.True(none.StepsFallback);
        Assert.True(none.Steps[0].DemandCheck);
        Assert.Contains(rejections, r => r is { Part: "steps", Rule: "noDemandCheck" });

        var (ok, _) = Build(Draft(steps: GoodSteps(demand: true), tasks: [TaskD(), TaskD("順番決め", "setting-priorities")]), options);
        Assert.False(ok.StepsFallback);
        Assert.True(ok.Steps[0].DemandCheck);
    }

    [Theory(DisplayName = "deepen-3（最初の一歩は小さく）: コードの候補は、どの種類でも条件に収まる")]
    [InlineData(TargetKind.Choose)]
    [InlineData(TargetKind.Combine)]
    [InlineData(TargetKind.Create)]
    [InlineData(TargetKind.Own)]
    public void FallbackStepsAlwaysFit(TargetKind kind)
    {
        var steps = DeepenText.FallbackSteps(kind);
        var tight = Conditions(hours: 1, slots: [TimeSlot.Night]);

        Assert.Equal(["f1", "f2", "f3"], steps.Select(s => s.Id));
        Assert.All(steps, s => Assert.True(StepFit.Fits(s, tight)));
        Assert.All(steps, s => Assert.Null(DeepenValidator.TextProblem(s.Text, DeepenValidator.MaxStepText, Forbidden)));
        Assert.Equal(kind == TargetKind.Create ? 1 : 0, steps.Count(s => s.DemandCheck));
    }

    [Fact(DisplayName = "deepen-3（最初の一歩は小さく）: 条件を変えたあとは、収まらない候補を出さず、コードの候補で補って 3 つにする")]
    public void VisibleReplacesWhatNoLongerFits()
    {
        var (content, _) = Build(Draft());
        var narrow = Conditions(hours: 2);

        var visible = DeepenSteps.Visible(content, [], TargetKind.Choose, narrow);
        Assert.Equal(["s1", "s2", "f1"], visible.Select(v => v.Step.Id));
        Assert.All(visible, v => Assert.True(v.Fits));

        var chosen = DeepenSteps.Visible(content, ["s3"], TargetKind.Choose, narrow);
        Assert.Equal(["s1", "s2", "s3", "f1"], chosen.Select(v => v.Step.Id));
        var s3 = chosen.Single(v => v.Step.Id == "s3");
        Assert.False(s3.Fits);
        Assert.True(s3.Chosen);
        Assert.Equal(3, chosen.Count(v => v.Fits));
    }

    [Fact(DisplayName = "deepen-4（創るの一歩には需要の確かめを入れる）: 条件を変えて需要の確かめの候補が収まらなくなると、コードの需要の確かめを足す")]
    public void VisibleKeepsDemandCheckForCreate()
    {
        var steps = new[] { Step("書き出してみる"), Step("読んでみる", 2), Step("知人に聞いてみる", 3, demand: true) };
        var (content, _) = Build(Draft(steps: steps, tasks: [TaskD(), TaskD("順番決め", "setting-priorities")]), Options(CreateChoice()));
        Assert.False(content.StepsFallback);

        var visible = DeepenSteps.Visible(content, [], TargetKind.Create, Conditions(hours: 2));

        Assert.Equal(["s1", "s2", "f1"], visible.Select(v => v.Step.Id));
        Assert.True(visible.Single(v => v.Step.Id == "f1").Step.DemandCheck);
    }

    [Fact(DisplayName = "deepen-6（仮の場面での考え方を聞く）: 選択肢が 3 つでない問い、対象の業務で使わない力の問いは出さない")]
    public void BadQuestionsAreDropped()
    {
        var cases = new QuestionDraft[]
        {
            Question(choices: ["一つ", "二つ"]),
            Question(choices: ["同じ", "同じ", "別"]),
            Question(ability: "noticing-changes"),
            Question(ability: "cooking"),
            Question(situation: ""),
            Question(choices: ["", "二つ", "三つ"]),
        };

        foreach (var bad in cases)
        {
            var (content, rejections) = Build(Draft(questions: [bad, Question()]));
            Assert.Equal(["q1"], content.Questions.Select(q => q.Id));
            Assert.Contains(rejections, r => r.Part == "question");
        }

        var (three, _) = Build(Draft(questions: [Question(situation: "一つ目の場面です"), Question(situation: "二つ目の場面です"), Question(situation: "三つ目の場面です")]));
        Assert.Equal(["q1", "q2"], three.Questions.Select(q => q.Id));
        Assert.Equal("二つ目の場面です", three.Questions[1].Situation);
    }

    [Fact(DisplayName = "deepen-6（仮の場面での考え方を聞く）: 問いの力は、選んだ案の業務の主な力か補助の力のうち、話から確かめる力")]
    public void QuestionAbilityMayBeMainOrSubOfRegisteredTasks()
    {
        // 会議や面会の日程調整: 主な力は段取り力、補助の力に利害調整力
        var (schedule, sr) = Build(
            Draft(questions: [Question("planning-steps", "一つ目の場面です"), Question("balancing-interests", "二つ目の場面です")]),
            Options(ChooseChoice(taskId: "online-secretary-schedule")));
        Assert.Empty(sr);
        Assert.Equal([TestAbilities.PlanningSteps, TestAbilities.BalancingInterests], schedule.Questions.Select(q => q.Ability));

        // 課題の原因の見当づくり: 主な力の原因分析力は準備中なので問いにできず、補助の力の違和感察知力はできる
        var (planned, pr) = Build(
            Draft(questions: [Question("cause-analysis"), Question("sensing-incongruity")]), Options(ChooseChoice(taskId: "planning-cause-hypothesis")));
        Assert.Equal("sensing-incongruity", Assert.Single(planned.Questions).Ability.Id);
        Assert.Contains(new DeepenRejection("question", "ability"), pr);
    }

    [Fact(DisplayName = "common-1（使わない言葉を出さない）: 深める文に、使わない言葉、言い切り、褒め言葉、お金の額があれば出さない")]
    public void WordRulesApply()
    {
        var (q, qr) = Build(Draft(questions: [Question(situation: "あなたの適職を考えると、どうしますか？")]));
        Assert.Empty(q.Questions);
        Assert.Contains(new DeepenRejection("question", "forbiddenWord"), qr);

        var (assertive, ar) = Build(Draft(steps: [Step("いちばんおすすめのことをしてみる"), Step(), Step()]));
        Assert.True(assertive.StepsFallback);
        Assert.Contains(new DeepenRejection("steps", "assertiveWord"), ar);

        var (praise, pr) = Build(
            Draft(tasks: [TaskD("段取りのプロ"), TaskD("順番決め", "setting-priorities")]), Options(CreateChoice()));
        Assert.True(praise.TasksRejected);
        Assert.Contains(new DeepenRejection("tasks", "praiseWord"), pr);

        var (money, mr) = Build(Draft(steps: [Step("月 3 万円を目指してみる"), Step(), Step()]));
        Assert.True(money.StepsFallback);
        Assert.Contains(new DeepenRejection("steps", "moneyAmount"), mr);
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 「創る」と自分の仕事の業務の見立ては 2〜4 つで、通らなければ出さない")]
    public void DraftedTasksRules()
    {
        var own = OwnOptions();
        var good = new[] { TaskD(), TaskD("順番決め", "setting-priorities", "表計算") };
        var (content, rejections) = Build(Draft(tasks: good), own);
        Assert.Empty(rejections);
        Assert.False(content.TasksRejected);
        Assert.Equal(["t1", "t2"], content.Tasks.Select(t => t.Id));
        Assert.Equal("表計算", content.Tasks[1].Knowledge);

        var bads = new TaskDraft[][]
        {
            [TaskD()],
            [TaskD(), TaskD(), TaskD(), TaskD(), TaskD()],
            [TaskD(new string('あ', 31)), TaskD()],
            [TaskD(ability: "cooking"), TaskD()],
            [TaskD(name: ""), TaskD()],
            [TaskD(knowledge: new string('あ', 61)), TaskD()],
        };
        foreach (var bad in bads)
        {
            var (rejected, r) = Build(Draft(tasks: bad), own);
            Assert.True(rejected.TasksRejected);
            Assert.Empty(rejected.Tasks);
            Assert.Single(r, x => x.Part == "tasks");
        }

        var (choose, cr) = Build(Draft(tasks: good));
        Assert.Empty(choose.Tasks);
        Assert.False(choose.TasksRejected);
        Assert.DoesNotContain(cr, x => x.Part == "tasks");
    }

    [Fact(DisplayName = "deepen-6（仮の場面での考え方を聞く）: 見立てが通れば、問いの力は見立ての業務の力から、通らなければ 3 つの力のどれでもよい")]
    public void QuestionAbilityFollowsTasks()
    {
        var own = OwnOptions();
        var tasks = new[] { TaskD(), TaskD("順番決め", "setting-priorities") };

        var (passed, _) = Build(Draft(tasks: tasks, questions: [Question("noticing-changes")]), own);
        Assert.Empty(passed.Questions);

        var (rejected, _) = Build(Draft(tasks: [TaskD()], questions: [Question("noticing-changes")]), own);
        Assert.True(rejected.TasksRejected);
        Assert.Single(rejected.Questions);
    }
}
