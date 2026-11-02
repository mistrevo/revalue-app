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
