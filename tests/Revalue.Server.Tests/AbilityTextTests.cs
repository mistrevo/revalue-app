using System.Text.Json;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

public sealed class AbilityTextTests
{
    private static IEnumerable<ActionRef> AllActions() =>
        Enum.GetValues<Ability>().SelectMany(a => Enumerable.Range(1, 3).Select(n => new ActionRef(a, n)));

    private static IEnumerable<string> AllTexts() =>
    [
        .. Enum.GetValues<Ability>().Select(AbilityText.Name),
        .. AllActions().Select(AbilityText.Hint),
        .. AllActions().Select(AbilityText.ResumeQuestion),
        .. AbilityText.ResumeChoices,
        AbilityText.ResumeOpenQuestion,
    ];

    [Fact(DisplayName = "common-1（使わない言葉を出さない）: 力の名前、手がかり、続きの問いに使わない言葉がない")]
    public void AbilityTextHasNoForbiddenWords()
    {
        var words = DiscoverTextTests.ForbiddenWords();
        Assert.Contains("診断", words);

        foreach (var text in AllTexts())
        {
            // 「優先順位をつける力」は PRD（4-rules.md）が決めた力の名前。使わない言葉の「順位」は人や仕事の順位づけのことなので、
            // 「優先順位」の言葉だけは除いて照らし合わせる（Claude の判断）
            var checkedText = text.Replace(AllowedCompound, "", StringComparison.Ordinal);
            foreach (var word in words)
            {
                Assert.False(checkedText.Contains(word, StringComparison.Ordinal), $"「{word}」が含まれている: {text}");
            }
        }
    }

    private const string AllowedCompound = "優先順位";

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 手がかりが 9 つすべてあり、空でない")]
    public void HintsCoverAllNineActions()
    {
        var hints = AllActions().Select(AbilityText.Hint).ToList();

        Assert.Equal(9, hints.Count);
        Assert.All(hints, h => Assert.False(string.IsNullOrWhiteSpace(h)));
        Assert.Equal(9, hints.Distinct().Count());
        Assert.Equal("ほかに関わっていた人と、その人たちの都合", AbilityText.Hint(new ActionRef(Ability.Coordinating, 1)));
        Assert.Equal("見立てる力", AbilityText.Name(Ability.Noticing));
        Assert.Equal("調整する力", AbilityText.Name(Ability.Coordinating));
        Assert.Equal("優先順位をつける力", AbilityText.Name(Ability.Prioritizing));
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 続きの問いは、手がかりを一つ添えて聞く。選択肢は 3 つ")]
    public void ResumeQuestionAddsOneHint()
    {
        var target = new ActionRef(Ability.Prioritizing, 3);

        Assert.Equal("この場面の続きを聞かせてください。そう決めた理由について、覚えていることはありますか？", AbilityText.ResumeQuestion(target));
        Assert.Equal(["少し覚えています", "よく覚えていません", "その日のほかのことを話したい"], AbilityText.ResumeChoices);
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 行動の呼び名は coordinating.3 の形で、読み戻せる")]
    public void ActionRefRoundTrips()
    {
        var target = new ActionRef(Ability.Coordinating, 3);

        Assert.Equal("coordinating.3", target.ToString());
        Assert.Equal(target, ActionRef.Parse("coordinating.3"));
        Assert.Null(ActionRef.Parse("coordinating.4"));
        Assert.Null(ActionRef.Parse("cooking.1"));
        Assert.Null(ActionRef.Parse("coordinating"));
        Assert.Null(ActionRef.Parse("Coordinating.1"));
    }

    [Fact(DisplayName = "validate-4（根拠は本人の言葉）: 力と状態と答えの種類は camelCase の名前で保存する")]
    public void EnumsUseCamelCaseNames()
    {
        Assert.Equal("\"prioritizing\"", JsonSerializer.Serialize(Ability.Prioritizing));
        Assert.Equal("\"needsCheck\"", JsonSerializer.Serialize(AbilityState.NeedsCheck));
        Assert.Equal("\"notYet\"", JsonSerializer.Serialize(AbilityState.NotYet));
        Assert.Equal("\"correction\"", JsonSerializer.Serialize(Revalue.Server.Features.Discover.AnswerKind.Correction));
    }
}
