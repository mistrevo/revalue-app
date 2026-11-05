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
            { "id": "coordination-execution", "name": "調整・実行・仕組み化する力" }
          ],
          "abilities": [{{string.Join(",", abilities)}}]
        }
        """;

    private static string AbilityJson(string id, int actions = 3, string category = "family-life", string status = "active") =>
        $$"""
        {
          "id": "{{id}}", "name": "{{id}} の力", "category": "{{category}}", "reason": "理由",
          "status": "{{status}}", "needsReview": false,
          "actions": [{{string.Join(",", Enumerable.Range(1, actions).Select(n => $$"""{ "number": {{n}}, "text": "行動 {{n}}", "hint": "手がかり {{n}}" }"""))}}]
        }
        """;

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: 判定に使う力は、見立てる力、調整する力、優先順位をつける力の順に並ぶ")]
    public void ActiveAbilitiesKeepTheOrder()
    {
        Assert.Equal(
            [new Ability("noticing"), new Ability("coordinating"), new Ability("prioritizing")],
            AbilityCatalog.Active);
        Assert.Equal([Ability.Noticing, Ability.Coordinating, Ability.Prioritizing], AbilityCatalog.Active);

        // 同じ数のときの選び方と表示の順は、この並びで決まる
        Assert.Equal(
            [Ability.Noticing, Ability.Coordinating, Ability.Prioritizing],
            new[] { Ability.Prioritizing, Ability.Noticing, Ability.Coordinating }.Order().ToList());
    }

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: 力ごとの核となる行動の数はデータから読み、いまは 3 つずつ")]
    public void ActionCountComesFromData()
    {
        Assert.All(AbilityCatalog.Active, a => Assert.Equal(3, AbilityCatalog.ActionCount(a)));

        // データにない力は、行動がない力として扱う（例外にしない）
        Assert.Equal(0, AbilityCatalog.ActionCount(new Ability("cooking")));
        Assert.Null(AbilityCatalog.Find("cooking"));
        Assert.NotNull(AbilityCatalog.Find("noticing"));
        Assert.Null(AbilityCatalog.Find("Noticing"));
    }

    [Fact(DisplayName = "validate-7（見えた力と、もう少し聞きたいことを示す）: 力の名前と手がかりは、データからいまの言葉のとおりに出る")]
    public void NamesAndHintsMatchTheCurrentText()
    {
        Assert.Equal("見立てる力", AbilityCatalog.Name(Ability.Noticing));
        Assert.Equal("調整する力", AbilityCatalog.Name(Ability.Coordinating));
        Assert.Equal("優先順位をつける力", AbilityCatalog.Name(Ability.Prioritizing));

        string[] hints =
        [
            "いつもと違うことに、自分で気づいたこと",
            "何を見たり聞いたりして、いつもと違うと思ったか",
            "いつもの様子や、前のときと比べたこと",
            "ほかに関わっていた人と、その人たちの都合",
            "あなたから声をかけたり、頼んだりしたこと",
            "みんなの都合を合わせたり、別の案を出したりしたこと",
            "その日に重なっていた用事",
            "何を先にして、何を後に回したか",
            "先にすること、後に回すことを、どう考えて決めたか",
        ];
        Assert.Equal(hints, AbilityCatalog.Active.SelectMany(a => Enumerable.Range(1, 3).Select(n => AbilityCatalog.Hint(new ActionRef(a, n)))));

        string[] actions =
        [
            "変化に自分で気づく",
            "判断の手がかりを挙げる",
            "いつもの様子や前と比べる",
            "都合の違う 2 者以上が関わる",
            "本人から働きかける",
            "代わりの案を出すか、双方の都合を合わせる",
            "全部はこなせないほど用事が重なる",
            "何を先にし、何を後に回すかを具体的に決める",
            "決めた理由や基準がある",
        ];
        Assert.Equal(actions, AbilityCatalog.Active.SelectMany(a => Enumerable.Range(1, 3).Select(n => AbilityCatalog.ActionText(new ActionRef(a, n)))));

        Assert.Equal("family-life", AbilityCatalog.Category(Ability.Noticing));
        Assert.Equal("coordination-execution", AbilityCatalog.Category(Ability.Coordinating));
        Assert.Equal("coordination-execution", AbilityCatalog.Category(Ability.Prioritizing));
        Assert.Throws<ArgumentOutOfRangeException>(() => AbilityCatalog.Hint(new ActionRef(Ability.Noticing, 4)));
        Assert.Throws<ArgumentOutOfRangeException>(() => AbilityCatalog.Name(new Ability("cooking")));
    }

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: 辞書のデータは、12 の分類があり、力の id と分類がそろっている")]
    public void SharedDataIsWellFormed()
    {
        var catalog = AbilityCatalog.Current;

        Assert.Equal(12, catalog.Categories.Count);
        Assert.Equal(12, catalog.Categories.Select(c => c.Id).Distinct().Count());
        Assert.Equal(AbilityCatalog.Active, catalog.ActiveAbilities);
        Assert.All(catalog.Entries, e => Assert.False(string.IsNullOrWhiteSpace(e.Reason)));
    }

    [Theory(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: 核となる行動が 2〜3 つでない力は、読み込みで止める")]
    [InlineData(1)]
    [InlineData(4)]
    [InlineData(0)]
    public void LoadRejectsWrongActionCount(int actions)
    {
        Assert.Throws<InvalidOperationException>(() => AbilityCatalog.Load(Json(AbilityJson("a", actions))));
    }

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: 行動が 2 つの力は読める")]
    public void LoadAcceptsTwoActions()
    {
        var catalog = AbilityCatalog.Load(Json(AbilityJson("a", 2), AbilityJson("b", 3)));

        Assert.Equal(2, catalog.ActionCountOf(new Ability("a")));
        Assert.Equal(3, catalog.ActionCountOf(new Ability("b")));
    }

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: id の重なり、ない分類、番号の抜けは、読み込みで止める")]
    public void LoadRejectsBrokenData()
    {
        Assert.Throws<InvalidOperationException>(() => AbilityCatalog.Load(Json(AbilityJson("a"), AbilityJson("a"))));
        Assert.Throws<InvalidOperationException>(() => AbilityCatalog.Load(Json(AbilityJson("a", category: "nothing"))));
        Assert.Throws<InvalidOperationException>(() => AbilityCatalog.Load(Json(AbilityJson("a", status: "unknown"))));
        Assert.Throws<InvalidOperationException>(() => AbilityCatalog.Load(Json(AbilityJson("a").Replace("\"number\": 2", "\"number\": 5", StringComparison.Ordinal))));
        Assert.Throws<InvalidOperationException>(() => AbilityCatalog.Load(Json(AbilityJson("a").Replace("\"hint\": \"手がかり 1\"", "\"hint\": \"\"", StringComparison.Ordinal))));
        Assert.Throws<InvalidOperationException>(() => AbilityCatalog.Load(Json(AbilityJson("A b"))));
    }

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: 準備中の力は、判定に使う力に入らない")]
    public void PreparingAbilitiesAreNotActive()
    {
        var catalog = AbilityCatalog.Load(Json(AbilityJson("a"), AbilityJson("b", status: "preparing"), AbilityJson("c", category: "coordination-execution")));

        Assert.Equal([new Ability("a"), new Ability("c")], catalog.ActiveAbilities);
        Assert.NotNull(catalog.FindEntry("b"));
        Assert.Equal(3, catalog.Entries.Count);
    }

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: 辞書にない力の根拠と、行動の数を超える番号は、例外にせずに数えない")]
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
        Assert.Null(ActionRef.Parse("noticing.4"));
        Assert.Equal(new ActionRef(Ability.Noticing, 3), ActionRef.Parse("noticing.3"));

        // 辞書にない力は、並べると辞書の力のあとに来る
        Assert.Equal([Ability.Noticing, old], new[] { old, Ability.Noticing }.Order().ToList());
    }

    [Fact(DisplayName = "validate-4（根拠は本人の言葉）: 力は id の文字列で保存し、読み戻せる。辞書のキーも id のまま")]
    public void AbilityIsSavedAsItsId()
    {
        Assert.Equal("\"noticing\"", JsonSerializer.Serialize(Ability.Noticing));
        Assert.Equal(Ability.Coordinating, JsonSerializer.Deserialize<Ability>("\"coordinating\""));

        var states = new Dictionary<Ability, AbilityState> { [Ability.Prioritizing] = AbilityState.Confirmed };
        var json = JsonSerializer.Serialize(states, DataConstants.Json);
        Assert.Equal("{\"prioritizing\":\"confirmed\"}", json);
        Assert.Equal(states, JsonSerializer.Deserialize<Dictionary<Ability, AbilityState>>(json, DataConstants.Json));

        // データにない力の id（古いデータ）も、例外にせずに読む。使うところで、判定に使う力でなければ無視する
        Assert.Equal(new Ability("old-ability"), JsonSerializer.Deserialize<Ability>("\"old-ability\""));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Ability>("1"));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Ability>("\"\""));
    }
}
