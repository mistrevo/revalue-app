using System.Reflection;
using System.Text.Json;
using Revalue.Server.Features.Discover;

namespace Revalue.Server.Tests;

public sealed class DiscoverTextTests
{
    /// <summary>使わない言葉の一覧（src/shared/forbidden-words.json）。テストの出力にコピーしてある。</summary>
    internal static IReadOnlyList<string> ForbiddenWords() =>
        JsonSerializer.Deserialize<string[]>(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "forbidden-words.json")))!;

    /// <summary>DiscoverText の公開している文字列と、文字列の並びをすべて集める。</summary>
    private static IEnumerable<string> AllTexts()
    {
        foreach (var member in typeof(DiscoverText).GetMembers(BindingFlags.Public | BindingFlags.Static))
        {
            var value = member switch
            {
                FieldInfo f => f.GetValue(null),
                PropertyInfo p => p.GetValue(null),
                _ => null,
            };
            switch (value)
            {
                case string s:
                    yield return s;
                    break;
                case IEnumerable<string> many:
                    foreach (var s in many)
                    {
                        yield return s;
                    }

                    break;
            }
        }
    }

    [Fact(DisplayName = "common-1（使わない言葉を出さない）: 裏側が決める言葉に使わない言葉がない")]
    public void DiscoverTextHasNoForbiddenWords()
    {
        var texts = AllTexts().ToList();
        Assert.True(texts.Count >= 10, "DiscoverText の文字列を集められていない");
        var words = ForbiddenWords();
        Assert.Contains("診断", words);

        foreach (var text in texts)
        {
            foreach (var word in words)
            {
                Assert.False(text.Contains(word, StringComparison.Ordinal), $"「{word}」が含まれている: {text}");
            }
        }
    }

    [Fact(DisplayName = "discover-1（具体的な一日を一つ聞く）: 最初の問いは、気持ちが動いた日を聞き、うまくいかなかった日も同じ重さで選べる")]
    public void OpeningAsksDayWhenFeelingsMoved()
    {
        Assert.Equal("最近、気持ちが動いた日のことを、一つ聞かせてください。どんな日でしたか？", DiscoverText.Opening);
        Assert.Equal(["うまくいったと感じた日", "大変だったけど、乗り切った日", "思うようにいかなかった日"], DiscoverText.OpeningChoices);
        Assert.Equal(3, DiscoverText.OpeningChoices.Count);
        Assert.DoesNotContain("たとえば昨日", DiscoverText.Opening, StringComparison.Ordinal);
    }

    [Fact(DisplayName = "discover-1（具体的な一日を一つ聞く）: 2 つ目からの問いは「また」で始まり、選択肢は最初の問いと同じ")]
    public void AnotherDayStartsWithMata()
    {
        Assert.Equal("また、最近、気持ちが動いた日のことを、一つ聞かせてください。どんな日でしたか？", DiscoverText.OpeningAnotherDay);
        Assert.StartsWith("また、", DiscoverText.OpeningAnotherDay, StringComparison.Ordinal);
        Assert.NotEqual(DiscoverText.Opening, DiscoverText.OpeningAnotherDay);
    }

    [Fact(DisplayName = "discover-1（具体的な一日を一つ聞く）: つらい状態のサインで終わった人の問いは、気持ちを聞かない")]
    public void AfterDistressDoesNotAskFeelings()
    {
        Assert.Equal(
            "また、最近のある一日のことを、聞かせてください。特別な日でなくてかまいません。その日の朝起きてから夜までに、どんなことがありましたか？",
            DiscoverText.OpeningAfterDistress);
        Assert.Equal(["買い物に行った", "外を歩いた", "ひとりで過ごした"], DiscoverText.OpeningAfterDistressChoices);
        IEnumerable<string> texts = [DiscoverText.OpeningAfterDistress, .. DiscoverText.OpeningAfterDistressChoices];
        foreach (var heavy in new[] { "気持ち", "うまくいかなかった", "思うように" })
        {
            Assert.All(texts, text => Assert.DoesNotContain(heavy, text, StringComparison.Ordinal));
        }
    }

    [Theory(DisplayName = "discover-1（具体的な一日を一つ聞く）: つらい状態のサインで終わった人の問いと選択肢は、家族や家を前提にしない")]
    [InlineData("家族")]
    [InlineData("家")]
    [InlineData("夫")]
    [InlineData("子ども")]
    public void AfterDistressDoesNotAssumeFamilyOrHome(string word)
    {
        // つらい状態のサインには家庭内の暴力や暴言も入る。打ち明けたあとの入口で「家族と」「家で」と出すと、重い場面へ戻すきっかけになりうる。
        // サインが出た場面を飛ばしたあとも、同じ問いと選択肢で始める（TalkStreamTests の discover-5（つらい話は飛ばせる））
        IEnumerable<string> texts = [DiscoverText.OpeningAfterDistress, .. DiscoverText.OpeningAfterDistressChoices];
        Assert.All(texts, text => Assert.DoesNotContain(word, text, StringComparison.Ordinal));
    }

    [Fact(DisplayName = "discover-3（選んでも書いてもよい）: 決まった選択肢と続け方は、どれも 3 つ")]
    public void ChoicesAreThree()
    {
        Assert.Equal(3, DiscoverText.OpeningChoices.Count);
        Assert.Equal(3, DiscoverText.OpeningAfterDistressChoices.Count);
        Assert.Equal(3, DiscoverText.AfterSkipChoices.Count);
        Assert.Equal(["もう少しくわしく話す", "別の日の話にする", "よく覚えていない"], DiscoverText.FallbackChoices);
        Assert.Equal(3, DiscoverText.DistressActions.Count);
    }

    [Theory(DisplayName = "discover-3（選んでも書いてもよい）: 決まった問いと選択肢は、核となる行動へ誘導しない")]
    [InlineData("重な")]
    [InlineData("予定")]
    [InlineData("手間")]
    [InlineData("忙し")]
    [InlineData("優先")]
    [InlineData("段取り")]
    [InlineData("調整")]
    public void FixedChoicesDoNotLead(string leading)
    {
        // 「用事が重なる」「家族の予定が重なる」は、優先順位をつける力・調整する力の核となる行動をそのまま並べることになる
        IEnumerable<string> texts =
        [
            DiscoverText.Opening,
            DiscoverText.OpeningAnotherDay,
            .. DiscoverText.OpeningChoices,
            DiscoverText.OpeningAfterDistress,
            .. DiscoverText.OpeningAfterDistressChoices,
            DiscoverText.AfterSkip,
            .. DiscoverText.AfterSkipChoices,
        ];
        Assert.All(texts, text => Assert.DoesNotContain(leading, text));
    }

    [Theory(DisplayName = "discover-5（つらい話は飛ばせる）: 飛ばしたあとと、つらい状態のサインのあとの問いは、負担の重い日へ話を戻さない")]
    [InlineData("大変")]
    [InlineData("手間")]
    [InlineData("忙し")]
    [InlineData("気持ち")]
    [InlineData("うまくいかなかった")]
    [InlineData("思うように")]
    public void LightOpeningsDoNotReturnToHeavyDays(string heavy)
    {
        // 飛ばした直後や、つらい話で区切った人に「大変だった日」「思うようにいかなかった日」を聞くと、負担の重い日へ話を戻すことになる。
        // 最初の問いの「大変だったけど、乗り切った日」は、うまくいかなかった日も同じ重さで選べるようにするための選択肢なので、ここには入れない
        IEnumerable<string> texts =
        [
            DiscoverText.OpeningAfterDistress,
            .. DiscoverText.OpeningAfterDistressChoices,
            DiscoverText.AfterSkip,
            .. DiscoverText.AfterSkipChoices,
        ];
        Assert.All(texts, text => Assert.DoesNotContain(heavy, text, StringComparison.Ordinal));
    }

    [Fact(DisplayName = "discover-10（つらい状態のサインに応える）: サインのあとの続け方に「消す」を使わない")]
    public void DistressActionsAvoidErasingWords()
    {
        // 「消えたい」と書いた直後の人に「消して」を重ねない
        Assert.All(DiscoverText.DistressActions, action => Assert.DoesNotContain("消", action));
        Assert.Contains("残さず", DiscoverText.DistressActions[2]);
    }

    [Fact(DisplayName = "discover-10（つらい状態のサインに応える）: 窓口は厚生労働省のページで、電話番号を書かない")]
    public void SupportLinkIsPublicPage()
    {
        Assert.Equal("https://www.mhlw.go.jp/mamorouyokokoro/", DiscoverText.SupportLinkUrl);
        foreach (var text in AllTexts())
        {
            Assert.DoesNotMatch(@"\d{2,4}-\d{2,4}-\d{3,4}", text);
        }
    }
}
