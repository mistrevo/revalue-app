using System.Text.Json;
using Revalue.Server.Data;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

public sealed class AbilityCatalogTests
{
    /// <summary>テスト用の小さな辞書。<paramref name="abilities"/> に力の JSON を並べる。</summary>
    private static string Json(params string[] abilities) => $$"""
        {
          "categories": [
            { "id": "family-life", "name": "家庭・子育て・人間関係から見える力" },
            { "id": "coordination-execution", "name": "調整・実行・仕組み化" }
          ],
          "abilities": [{{string.Join(",", abilities)}}]
        }
        """;

    private static string AbilityJson(string id, int actions = 3, string category = "family-life", string status = "active", bool questions = true) =>
        $$"""
        {
          "id": "{{id}}", "name": "{{id}} の力", "category": "{{category}}", "reason": "理由",
          "status": "{{status}}", "needsReview": false,
          "actions": [{{string.Join(",", Enumerable.Range(1, actions).Select(n => ActionJson(n, questions)))}}]
        }
        """;

    private static string ActionJson(int n, bool question) =>
        $$"""{ "number": {{n}}, "text": "行動 {{n}}", "hint": "手がかり {{n}}"{{(question ? $", \"resumeQuestion\": \"その日、行動 {n} はありましたか？\"" : "")}} }""";

    /// <summary>話から確かめる 24 の力（辞書の順）。</summary>
    private static readonly string[] ActiveIds =
    [
        "info-gathering", "sensing-incongruity",
        "summarizing", "question-design", "active-listening", "helping-put-into-words", "organizing-issues",
        "considering-fairness",
        "cause-analysis", "hypothesis-thinking",
        "balancing-interests", "planning-steps", "setting-priorities", "improving-work", "managing-deadlines",
        "noticing-changes", "adapting-explanations", "handling-schedule-changes",
        "empathy", "easing-anxiety",
        "digging-deeper",
        "seeing-it-through", "persistence", "resilience",
    ];

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 辞書は 12 の分類と 126 の力を持ち、話から確かめる力は 24 で、並びは辞書の順")]
    public void CatalogHasTheDictionary()
    {
        var catalog = AbilityCatalog.Current;

        Assert.Equal(12, catalog.Categories.Count);
        Assert.Equal(12, catalog.Categories.Select(c => c.Id).Distinct().Count());
        Assert.Equal(126, catalog.Entries.Count);
        Assert.Equal(102, catalog.Entries.Count(e => e.Status == AbilityEntry.PreparingStatus));
        Assert.Equal(ActiveIds, AbilityCatalog.Active.Select(a => a.Id));
        Assert.Equal(AbilityCatalog.Active, catalog.ActiveAbilities);
        Assert.All(catalog.Entries, e => Assert.False(string.IsNullOrWhiteSpace(e.Reason)));

        // 同じ数のときの選び方と表示の順は、この並びで決まる。置き換え先の 3 つは、利害調整力、優先順位設定力、変化への気づきの順
        Assert.Equal(
            [TestAbilities.BalancingInterests, TestAbilities.SettingPriorities, TestAbilities.NoticingChanges],
            new[] { TestAbilities.NoticingChanges, TestAbilities.SettingPriorities, TestAbilities.BalancingInterests }.Order().ToList());
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: どの力も核となる行動が 2〜3 つで、番号は 1 から順")]
    public void EveryAbilityHasTwoOrThreeActions()
    {
        Assert.All(AbilityCatalog.Current.Entries, e =>
        {
            Assert.InRange(e.Actions.Count, AbilityCatalog.MinActions, AbilityCatalog.MaxActions);
            Assert.Equal(Enumerable.Range(1, e.Actions.Count), e.Actions.Select(a => a.Number));
            Assert.Equal(e.Actions.Count, AbilityCatalog.ActionCount(e.Ability));
        });
        Assert.Equal(2, AbilityCatalog.ActionCount(TestAbilities.Summarizing));
        Assert.Equal(3, AbilityCatalog.ActionCount(TestAbilities.BalancingInterests));

        // データにない力は、行動がない力として扱う（例外にしない）
        Assert.Equal(0, AbilityCatalog.ActionCount(new Ability("cooking")));
        Assert.Null(AbilityCatalog.Find("cooking"));
        Assert.NotNull(AbilityCatalog.Find("noticing-changes"));
        Assert.Null(AbilityCatalog.Find("Noticing-changes"));
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 話から確かめる力が 1 つもない辞書は、読み込みで止める")]
    public void LoadRejectsCatalogWithoutActiveAbilities()
    {
        Assert.Throws<InvalidOperationException>(() => AbilityCatalog.Load(Json(AbilityJson("a", status: "preparing", questions: false))));
        Assert.Throws<InvalidOperationException>(() => AbilityCatalog.Load(Json()));
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 話から確かめる力の行動に続きの問いがない辞書は、読み込みで止める。準備中の力にはなくてよい")]
    public void LoadRequiresResumeQuestionsForActiveAbilities()
    {
        Assert.Throws<InvalidOperationException>(() => AbilityCatalog.Load(Json(AbilityJson("a", questions: false))));
        Assert.Throws<InvalidOperationException>(() => AbilityCatalog.Load(Json(
            AbilityJson("a").Replace("その日、行動 2 はありましたか？", " ", StringComparison.Ordinal))));

        var catalog = AbilityCatalog.Load(Json(AbilityJson("a"), AbilityJson("b", status: "preparing", questions: false)));
        Assert.Equal([new Ability("a")], catalog.ActiveAbilities);
        Assert.Equal("その日、行動 2 はありましたか？", catalog.FindEntry("a")!.Actions[1].ResumeQuestion);
        Assert.Null(catalog.FindEntry("b")!.Actions[0].ResumeQuestion);
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 古い id（noticing、coordinating、prioritizing）は辞書になく、話から確かめる力として読めない")]
    public void OldIdsAreNotInTheCatalog()
    {
        foreach (var id in new[] { "noticing", "coordinating", "prioritizing" })
        {
            Assert.Null(AbilityCatalog.Find(id));
            Assert.False(ActionRef.TryParseAbility(id, out _));
            Assert.Null(ActionRef.Parse($"{id}.1"));
            Assert.DoesNotContain(TestAbilities.Old(id), AbilityCatalog.Active);
            Assert.Equal(0, AbilityCatalog.ActionCount(TestAbilities.Old(id)));
        }
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 置き換え先の 3 つの力は、いまの核となる行動の文と手がかりを引き継ぐ")]
    public void ReplacementAbilitiesKeepTheCurrentText()
    {
        static IEnumerable<string> Texts(Ability a) => Enumerable.Range(1, 3).Select(n => AbilityCatalog.ActionText(new ActionRef(a, n)));
        static IEnumerable<string> Hints(Ability a) => Enumerable.Range(1, 3).Select(n => AbilityCatalog.Hint(new ActionRef(a, n)));

        Assert.Equal("変化への気づき", AbilityCatalog.Name(TestAbilities.NoticingChanges));
        Assert.Equal("利害調整力", AbilityCatalog.Name(TestAbilities.BalancingInterests));
        Assert.Equal("優先順位設定力", AbilityCatalog.Name(TestAbilities.SettingPriorities));

        // 変化への気づきと優先順位設定力は、3 つの文と手がかりが一字一句同じ
        Assert.Equal(["変化に自分で気づく", "判断の手がかりを挙げる", "いつもの様子や前と比べる"], Texts(TestAbilities.NoticingChanges));
        Assert.Equal(
            ["いつもと違うことに、自分で気づいたこと", "何を見たり聞いたりして、いつもと違うと思ったか", "いつもの様子や、前のときと比べたこと"],
            Hints(TestAbilities.NoticingChanges));
        Assert.Equal(
            ["全部はこなせないほど用事が重なる", "何を先にし、何を後に回すかを具体的に決める", "決めた理由や基準がある"],
            Texts(TestAbilities.SettingPriorities));
        Assert.Equal(
            ["その日に重なっていた用事", "何を先にして、何を後に回したか", "先にすること、後に回すことを、どう考えて決めたか"],
            Hints(TestAbilities.SettingPriorities));

        // 利害調整力は、手がかりが同じで、行動の文の 1 と 2 が下書きのとおり
        Assert.Equal(
            ["関わる 2 者以上の、それぞれ違う都合をつかむ", "自分から働きかける", "代わりの案を出すか、双方の都合を合わせる"],
            Texts(TestAbilities.BalancingInterests));
        Assert.Equal(
            ["ほかに関わっていた人と、その人たちの都合", "あなたから声をかけたり、頼んだりしたこと", "みんなの都合を合わせたり、別の案を出したりしたこと"],
            Hints(TestAbilities.BalancingInterests));

        Assert.Equal("family-life", AbilityCatalog.Category(TestAbilities.NoticingChanges));
        Assert.Equal("coordination-execution", AbilityCatalog.Category(TestAbilities.BalancingInterests));
        Assert.Equal("coordination-execution", AbilityCatalog.Category(TestAbilities.SettingPriorities));
        Assert.Throws<ArgumentOutOfRangeException>(() => AbilityCatalog.Hint(new ActionRef(TestAbilities.NoticingChanges, 4)));
        Assert.Throws<ArgumentOutOfRangeException>(() => AbilityCatalog.Hint(new ActionRef(TestAbilities.Summarizing, 3)));
        Assert.Throws<ArgumentOutOfRangeException>(() => AbilityCatalog.Name(new Ability("cooking")));
    }

    [Theory(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 核となる行動が 2〜3 つでない力は、読み込みで止める")]
    [InlineData(1)]
    [InlineData(4)]
    [InlineData(0)]
    public void LoadRejectsWrongActionCount(int actions)
    {
        Assert.Throws<InvalidOperationException>(() => AbilityCatalog.Load(Json(AbilityJson("a", actions))));
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 行動が 2 つの力は読める")]
    public void LoadAcceptsTwoActions()
    {
        var catalog = AbilityCatalog.Load(Json(AbilityJson("a", 2), AbilityJson("b", 3)));

        Assert.Equal(2, catalog.ActionCountOf(new Ability("a")));
        Assert.Equal(3, catalog.ActionCountOf(new Ability("b")));
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: id の重なり、ない分類、番号の抜けは、読み込みで止める")]
    public void LoadRejectsBrokenData()
    {
        Assert.Throws<InvalidOperationException>(() => AbilityCatalog.Load(Json(AbilityJson("a"), AbilityJson("a"))));
        Assert.Throws<InvalidOperationException>(() => AbilityCatalog.Load(Json(AbilityJson("a", category: "nothing"))));
        Assert.Throws<InvalidOperationException>(() => AbilityCatalog.Load(Json(AbilityJson("a", status: "unknown"))));
        Assert.Throws<InvalidOperationException>(() => AbilityCatalog.Load(Json(AbilityJson("a").Replace("\"number\": 2", "\"number\": 5", StringComparison.Ordinal))));
        Assert.Throws<InvalidOperationException>(() => AbilityCatalog.Load(Json(AbilityJson("a").Replace("\"hint\": \"手がかり 1\"", "\"hint\": \"\"", StringComparison.Ordinal))));
        Assert.Throws<InvalidOperationException>(() => AbilityCatalog.Load(Json(AbilityJson("A b"))));
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 準備中の力は、判定に使う力に入らない")]
    public void PreparingAbilitiesAreNotActive()
    {
        var catalog = AbilityCatalog.Load(Json(AbilityJson("a"), AbilityJson("b", status: "preparing"), AbilityJson("c", category: "coordination-execution")));

        Assert.Equal([new Ability("a"), new Ability("c")], catalog.ActiveAbilities);
        Assert.NotNull(catalog.FindEntry("b"));
        Assert.Equal(3, catalog.Entries.Count);
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 辞書にない力の根拠と、行動の数を超える番号は、例外にせずに数えない")]
    public void UnknownAbilitiesAreIgnored()
    {
        var old = new Ability("old-ability");
        IReadOnlyList<Evidence> evidence =
        [
            new(old, 1, "架空-昔の力の言葉 1", 1, 1, false, false, null),
            new(old, 2, "架空-昔の力の言葉 2", 1, 1, false, false, null),
            new(old, 3, "架空-昔の力の言葉 3", 1, 1, false, false, null),
        ];

        var results = AbilityStates.Evaluate(evidence);

        Assert.Equal(AbilityCatalog.Active, results.Select(r => r.Ability));
        Assert.All(results, r => Assert.Equal(AbilityState.NotYet, r.State));
        Assert.Null(ActionRef.Parse("old-ability.1"));
        Assert.Null(ActionRef.Parse("noticing-changes.4"));
        Assert.Null(ActionRef.Parse("summarizing.3"));
        Assert.Equal(new ActionRef(TestAbilities.NoticingChanges, 3), ActionRef.Parse("noticing-changes.3"));
        Assert.Equal(new ActionRef(TestAbilities.Summarizing, 2), ActionRef.Parse("summarizing.2"));

        // 辞書にない力は、並べると辞書の力のあとに来る
        Assert.Equal([TestAbilities.NoticingChanges, old], new[] { old, TestAbilities.NoticingChanges }.Order().ToList());
    }

    [Fact(DisplayName = "validate-4（根拠は本人の言葉）: 力は id の文字列で保存し、読み戻せる。辞書のキーも id のまま")]
    public void AbilityIsSavedAsItsId()
    {
        Assert.Equal("\"noticing-changes\"", JsonSerializer.Serialize(TestAbilities.NoticingChanges));
        Assert.Equal(TestAbilities.BalancingInterests, JsonSerializer.Deserialize<Ability>("\"balancing-interests\""));

        var states = new Dictionary<Ability, AbilityState> { [TestAbilities.SettingPriorities] = AbilityState.Confirmed };
        var json = JsonSerializer.Serialize(states, DataConstants.Json);
        Assert.Equal("{\"setting-priorities\":\"confirmed\"}", json);
        Assert.Equal(states, JsonSerializer.Deserialize<Dictionary<Ability, AbilityState>>(json, DataConstants.Json));

        // データにない力の id（古いデータ）も、例外にせずに読む。使うところで、判定に使う力でなければ無視する
        Assert.Equal(new Ability("old-ability"), JsonSerializer.Deserialize<Ability>("\"old-ability\""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Ability>("1"));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Ability>("\"\""));
    }
}
