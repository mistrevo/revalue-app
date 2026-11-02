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

    [Fact(DisplayName = "discover-3（選んでも書いてもよい）: 決まった選択肢と続け方は、どれも 3 つ")]
    public void ChoicesAreThree()
    {
        Assert.Equal(3, DiscoverText.OpeningChoices.Count);
        Assert.Equal(3, DiscoverText.AfterSkipChoices.Count);
        Assert.Equal(["もう少しくわしく話す", "別の日の話にする", "よく覚えていない"], DiscoverText.FallbackChoices);
        Assert.Equal(3, DiscoverText.DistressActions.Count);
    }

    [Theory(DisplayName = "discover-3（選んでも書いてもよい）: 決まった選択肢と飛ばしたあとの問いは、核となる行動や負担の重い日へ誘導しない")]
    [InlineData("重な")]
    [InlineData("予定")]
    [InlineData("手間")]
    [InlineData("大変")]
    [InlineData("忙し")]
    [InlineData("優先")]
    [InlineData("段取り")]
    [InlineData("調整")]
    public void FixedChoicesDoNotLead(string leading)
    {
        // 「用事が重なる」「家族の予定が重なる」は、優先順位をつける力・調整する力の核となる行動をそのまま並べることになる。
        // 飛ばした直後に「手間がかかった日」を聞くと、負担の重い日へ話を戻すことになる
        IEnumerable<string> texts = [.. DiscoverText.OpeningChoices, DiscoverText.AfterSkip, .. DiscoverText.AfterSkipChoices];
        Assert.All(texts, text => Assert.DoesNotContain(leading, text));
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
