using System.Text.Json;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

public sealed class AbilityTextTests
{
    private static IEnumerable<ActionRef> AllActions() =>
        AbilityCatalog.Active.SelectMany(a => Enumerable.Range(1, AbilityCatalog.ActionCount(a)).Select(n => new ActionRef(a, n)));

    private static IEnumerable<string> AllTexts() =>
    [
        .. AbilityCatalog.Active.Select(AbilityText.Name),
        .. AllActions().Select(AbilityCatalog.ActionText),
        .. AllActions().Select(AbilityText.Hint),
        .. AllActions().Select(AbilityText.ResumeAsk),
        .. AbilityText.ResumeChoices,
        AbilityText.ResumeLead,
        AbilityText.ResumeMirror("本人の言葉"),
        AbilityText.ResumeOpenAsk,
        AbilityText.ResumeConcreteAsk,
        AbilityText.ConcreteDayHint,
        .. AbilityText.ConcreteDayChoices,
    ];

    [Fact(DisplayName = "validate-6（否定の言葉を使わない）: 話から確かめる力の名前、行動の文、手がかり、続きの問いに、使わない言葉がない")]
    public void AbilityTextHasNoForbiddenWords()
    {
        var words = DiscoverTextTests.ForbiddenWords();
        Assert.Contains("診断", words);
        Assert.Contains("判定", words);
        Assert.Contains("スコア", words);

        foreach (var text in AllTexts())
        {
            // 「優先順位設定力」は能力辞書の力の名前。使わない言葉の「順位」は人や仕事の順位づけのことなので、
            // 「優先順位」の言葉だけは除いて照らし合わせる（Claude の判断）
            var checkedText = text.Replace(AllowedCompound, "", StringComparison.Ordinal);
            foreach (var word in words)
            {
                Assert.False(checkedText.Contains(word, StringComparison.Ordinal), $"「{word}」が含まれている: {text}");
            }
        }
    }

    private const string AllowedCompound = "優先順位";

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 手がかりは、話から確かめる力の行動ごとにあり、空でない")]
    public void HintsCoverAllActions()
    {
        var hints = AllActions().Select(AbilityText.Hint).ToList();

        Assert.Equal(AbilityCatalog.Active.Sum(AbilityCatalog.ActionCount), hints.Count);
        Assert.All(hints, h => Assert.False(string.IsNullOrWhiteSpace(h)));
        Assert.Equal(hints.Count, hints.Distinct().Count());
        Assert.Equal("ほかに関わっていた人と、その人たちの都合", AbilityText.Hint(new ActionRef(TestAbilities.BalancingInterests, 1)));
        Assert.Equal("変化への気づき", AbilityText.Name(TestAbilities.NoticingChanges));
        Assert.Equal("利害調整力", AbilityText.Name(TestAbilities.BalancingInterests));
        Assert.Equal("優先順位設定力", AbilityText.Name(TestAbilities.SettingPriorities));
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 続きの問いは、話から確かめる力の行動ごとにあり、「その日」で始まり「ありましたか？」か「いましたか？」で終わる")]
    public void ResumeQuestionsComeFromTheCatalog()
    {
        Assert.All(AbilityCatalog.Active, a =>
        {
            var count = AbilityCatalog.ActionCount(a);
            for (var n = 1; n <= count; n++)
            {
                var question = AbilityText.ResumeAsk(new ActionRef(a, n));
                Assert.Equal(AbilityCatalog.ResumeQuestion(new ActionRef(a, n)), question);
                // 新しく書いた問いは「その日、」で始める。いまの 9 つの文から引き継いだ問いには「その日の」で始まるものがある
                Assert.True(question.StartsWith("その日、", StringComparison.Ordinal) || question.StartsWith("その日の", StringComparison.Ordinal), question);
                Assert.True(question.EndsWith("ありましたか？", StringComparison.Ordinal) || question.EndsWith("いましたか？", StringComparison.Ordinal), question);
            }

            Assert.Throws<ArgumentOutOfRangeException>(() => AbilityText.ResumeAsk(new ActionRef(a, count + 1)));
        });
        Assert.Throws<ArgumentOutOfRangeException>(() => AbilityCatalog.ResumeQuestion(new ActionRef(TestAbilities.Old("noticing"), 1)));
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 置き換え先の 3 つの力の続きの問いは、いまの 9 つの文と同じ")]
    public void ReplacementAbilitiesKeepTheResumeQuestions()
    {
        string[] questions =
        [
            "その日、いつもと違うと気づいたことはありましたか？",
            "その日、いつもと違うと思ったことがあれば、そのとき目に入ったことや耳にしたことはありましたか？",
            "その日の様子を、いつもや前のときと比べたことはありましたか？",
            "その日、あなたのほかに、予定や都合が関わっていた人はいましたか？",
            "その日、だれかに声をかけたり、頼んだりしたことはありましたか？",
            "その日、みんなの都合を合わせたり、別の案を出したりしたことはありましたか？",
            "その日、重なっていた用事はありましたか？",
            "その日の用事の中で、先にしたことや、後に回したことはありましたか？",
            "その日、どれを先にするか決めるときに、気にしていたことはありましたか？",
        ];

        Assert.Equal(
            questions,
            new[] { TestAbilities.NoticingChanges, TestAbilities.BalancingInterests, TestAbilities.SettingPriorities }
                .SelectMany(a => Enumerable.Range(1, 3).Select(n => AbilityText.ResumeAsk(new ActionRef(a, n)))));
    }

    [Fact(DisplayName = "validate-7（見えた力と、もう少し聞きたいことを示す）: 力の名前と手がかりは、能力辞書のデータから出る")]
    public void NamesAndHintsComeFromTheCatalog()
    {
        // 裏側の言葉の 1 か所は能力辞書。AbilityText は辞書をそのまま返す
        Assert.All(AbilityCatalog.Active, a => Assert.Equal(AbilityCatalog.Name(a), AbilityText.Name(a)));
        Assert.All(AllActions(), a => Assert.Equal(AbilityCatalog.Hint(a), AbilityText.Hint(a)));
        Assert.Throws<ArgumentOutOfRangeException>(() => AbilityText.Hint(new ActionRef(TestAbilities.NoticingChanges, 4)));
        Assert.Throws<ArgumentOutOfRangeException>(() => AbilityText.Name(new Ability("cooking")));
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 続きの問いは、決まった受け止めの一文、本人の言葉の映し返し、行動ごとの問い一つの順。選択肢は 3 つ")]
    public void ResumeOpeningAcknowledgesMirrorsThenAsksOne()
    {
        var target = new ActionRef(TestAbilities.BalancingInterests, 2);

        // 4-rules.md の「対話の決まり」: 受け止める一文、本人の行動を映し返す言葉、問い一つ、の順
        Assert.Equal(
            "続きの話を選んでくれて、ありがとうございます。前に「夫と母の予定がぶつかって」と話してくれましたね。その日、だれかに声をかけたり、頼んだりしたことはありましたか？",
            AbilityText.ResumeOpening(target, "夫と母の予定がぶつかって"));
        Assert.Equal(
            "続きの話を選んでくれて、ありがとうございます。前に「二人に電話して」と話してくれましたね。その日のことで、ほかに覚えていることはありますか？",
            AbilityText.ResumeOpening(null, "二人に電話して"));

        // 映し返す言葉がない場面（根拠がない）でも、問いの「その日」が指す日を先に示す
        Assert.Equal(
            "続きの話を選んでくれて、ありがとうございます。前に話してくれた日のことです。その日、だれかに声をかけたり、頼んだりしたことはありましたか？",
            AbilityText.ResumeOpening(target, null));
        Assert.Equal(["思い当たることがあります", "とくに思い当たりません", "その日のほかのことを話したい"], AbilityText.ResumeChoices);
        Assert.Equal("とくに思い当たりません", AbilityText.ResumeChoiceNone);
        Assert.Equal("その日のほかのことを話したい", AbilityText.ResumeChoiceOtherThings);

        // 受け止めの一文は、区切った直後に押しても、日をおいて戻っても合う言い方にする（「また」「来てくれて」のように時間を前提にしない）
        Assert.DoesNotContain("また", AbilityText.ResumeLead, StringComparison.Ordinal);
        Assert.DoesNotContain("来て", AbilityText.ResumeLead, StringComparison.Ordinal);
        // 本人がしたこと（続きを選んだ）をそのまま受け止める。「話そうとして」のように、まだしていないとも読める言い方にしない
        Assert.DoesNotContain("ようと", AbilityText.ResumeLead, StringComparison.Ordinal);

        // 一般論だけの場面は「その日」を前提にせず、最近の一日を一つ聞く（validate-10（一般論には具体的な出来事を聞く））
        Assert.Equal(
            "続きの話を選んでくれて、ありがとうございます。前に「いつも私が予定を合わせています」と話してくれましたね。特別な日でなくてかまいません。いつものことの中から、いちばん最近の一日のことを、聞かせてもらえますか？",
            AbilityText.ResumeOpeningForGeneral("いつも私が予定を合わせています。"));
        Assert.Equal(["今週のことを話したい", "先週のことを話したい", "すぐには浮かばない"], AbilityText.ConcreteDayChoices);

        // 映し返しでは、引用の文末の句読点だけを外して示す（「」の中に「。」「、」を残さない）
        Assert.Equal("前に「二人に電話しました」と話してくれましたね。", AbilityText.ResumeMirror("二人に電話しました。"));
        Assert.Equal("前に「夫と母の予定がぶつかって」と話してくれましたね。", AbilityText.ResumeMirror("夫と母の予定がぶつかって、"));
        Assert.Throws<ArgumentOutOfRangeException>(() => AbilityText.ResumeOpening(new ActionRef(TestAbilities.NoticingChanges, 4), "二人に電話して"));
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 続きの問いはすべて別の文で、その行動をしたことを前提にせず「ありましたか」「いましたか」で聞き、問いは一つ")]
    public void ResumeQuestionsDoNotPresuppose()
    {
        var questions = AllActions().Select(AbilityText.ResumeAsk).ToList();

        Assert.Equal(questions.Count, questions.Distinct().Count());
        Assert.All(questions, q =>
        {
            // 「〜したことについて」のように、したことを前提にした聞き方をしない。「ありましたか」か、「あれば」「いれば」で聞く
            Assert.DoesNotContain("について", q, StringComparison.Ordinal);
            Assert.True(new[] { "ありましたか", "いましたか" }.Any(w => q.Contains(w, StringComparison.Ordinal)), q);
            Assert.Equal(1, q.Count(c => c == '？'));
            Assert.EndsWith("？", q, StringComparison.Ordinal);
        });

        // 一度に一つだけ求める: 関わった人と、その人たちの都合を別々に求めない
        Assert.DoesNotContain("都合も", AbilityText.ResumeAsk(new ActionRef(TestAbilities.BalancingInterests, 1)), StringComparison.Ordinal);

        // 「考えたか」を疑う聞き方をしない。「なかった」と答えても、確かめている力を自分で打ち消す答えにならないようにする
        Assert.All(questions, q => Assert.DoesNotContain("考えて", q, StringComparison.Ordinal));

        // 問いは一つ: 受け止めの一文と映し返しには問いを入れない
        Assert.Equal(1, AbilityText.ResumeOpenAsk.Count(c => c == '？'));
        Assert.DoesNotContain("？", AbilityText.ResumeLead + AbilityText.ResumeMirror("二人に電話して"), StringComparison.Ordinal);
    }

    [Fact(DisplayName = "validate-7（見えた力と、もう少し聞きたいことを示す）: 手がかりは前の文脈に頼らない（「そう」などで前を指して始めない、かっこ書きを入れない）")]
    public void HintsStandAlone()
    {
        // 「答えにくそう」「なぜそうなった」のように、手がかりの中で完結する「そう」は使ってよい。前の手がかりや文を指す言葉で始めない
        // （「その日」は話した日のことなので使ってよい）
        Assert.All(AllActions().Select(AbilityText.Hint), h =>
        {
            Assert.DoesNotMatch(@"^(そう|それ|そのとき|そこ|あの|あれ|この)", h);
            Assert.DoesNotContain("（", h, StringComparison.Ordinal);
        });
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 行動の呼び名は balancing-interests.3 の形で、読み戻せる")]
    public void ActionRefRoundTrips()
    {
        var target = new ActionRef(TestAbilities.BalancingInterests, 3);

        Assert.Equal("balancing-interests.3", target.ToString());
        Assert.Equal(target, ActionRef.Parse("balancing-interests.3"));
        Assert.Null(ActionRef.Parse("balancing-interests.4"));
        Assert.Null(ActionRef.Parse("summarizing.3"));
        Assert.Null(ActionRef.Parse("cooking.1"));
        Assert.Null(ActionRef.Parse("balancing-interests"));
        Assert.Null(ActionRef.Parse("Balancing-interests.1"));
    }

    [Fact(DisplayName = "validate-4（根拠は本人の言葉）: 力と状態と答えの種類は camelCase の名前で保存する")]
    public void EnumsUseCamelCaseNames()
    {
        Assert.Equal("\"setting-priorities\"", JsonSerializer.Serialize(TestAbilities.SettingPriorities));
        Assert.Equal("\"needsCheck\"", JsonSerializer.Serialize(AbilityState.NeedsCheck));
        Assert.Equal("\"notYet\"", JsonSerializer.Serialize(AbilityState.NotYet));
        Assert.Equal("\"correction\"", JsonSerializer.Serialize(Revalue.Server.Features.Discover.AnswerKind.Correction));
    }
}
