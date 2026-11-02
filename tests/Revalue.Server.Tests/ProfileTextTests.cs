using Revalue.Server.Features.Profile;

namespace Revalue.Server.Tests;

public sealed class ProfileTextTests
{
    private static IEnumerable<string> AllTexts() =>
        [ProfileText.PreferenceQuestion, .. ProfileText.PreferenceChoices, ProfileText.WantQuestion, .. ProfileText.WantChoices];

    [Fact(DisplayName = "common-1（使わない言葉を出さない）: 好みとやりたいことの問いと選択肢に、使わない言葉がない")]
    public void NoForbiddenWords()
    {
        var words = DiscoverTextTests.ForbiddenWords();
        Assert.Contains("診断", words);
        foreach (var text in AllTexts())
        {
            foreach (var word in words)
            {
                Assert.False(text.Contains(word, StringComparison.Ordinal), $"「{word}」が含まれている: {text}");
            }
        }
    }

    [Fact(DisplayName = "profile-5（好みとやりたいことを一つずつ聞く）: 問いはそれぞれ一つで、選択肢は 3 つ、重ならない")]
    public void OneQuestionThreeChoices()
    {
        Assert.Equal(1, ProfileText.PreferenceQuestion.Count(c => c == '？'));
        Assert.Equal(1, ProfileText.WantQuestion.Count(c => c == '？'));
        Assert.Equal(["自分のペースで進められる", "人とやりとりしながら進められる", "決まった手順がある"], ProfileText.PreferenceChoices);
        Assert.Equal(["これまでの経験を活かしたい", "人の役に立つことをしたい", "新しいことを覚えたい"], ProfileText.WantChoices);
        Assert.Equal(6, ProfileText.PreferenceChoices.Concat(ProfileText.WantChoices).Distinct().Count());
    }

    [Fact(DisplayName = "profile-1（5 つを分けて残す）: 好みとやりたいことの選択肢に、条件（時間、場所、収入）と重なる言葉を入れない")]
    public void ChoicesDoNotOverlapConditions()
    {
        foreach (var choice in ProfileText.PreferenceChoices.Concat(ProfileText.WantChoices))
        {
            foreach (var word in new[] { "家", "外", "時間", "朝", "夜", "収入", "万円" })
            {
                Assert.False(choice.Contains(word, StringComparison.Ordinal), $"条件の「{word}」が含まれている: {choice}");
            }
        }
    }
}
