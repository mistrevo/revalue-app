using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

public sealed class EvidenceTests
{
    private static readonly DateTimeOffset At = new(2026, 11, 3, 1, 0, 0, TimeSpan.Zero);

    private static Turn Asked(string text, params string[] choices) =>
        new() { Role = TurnRoles.Assistant, Text = text, Choices = choices.Length > 0 ? choices : null, Move = "askWhatYouDid", At = At };

    private static Turn Answered(string text, AnswerKind kind = AnswerKind.Free) =>
        new() { Role = TurnRoles.User, Text = text, AnswerKind = kind, At = At };

    private static EvidenceCandidate Candidate(
        string quote, int answer = 1, Ability ability = Ability.Noticing, int action = 1, int @event = 1, bool general = false,
        string linkedQuote = "", int linkedAnswer = 0) =>
        new(ability, action, quote, answer, @event, general, linkedQuote, linkedAnswer);

    [Fact(DisplayName = "validate-4（根拠は本人の言葉）: 本人の答えに一字一句含まれる引用だけを残す")]
    public void KeepsOnlyQuotesContainedInAnswers()
    {
        IReadOnlyList<Turn> turns =
        [
            Asked("昨日はどんな一日でしたか？"),
            Answered("朝、子どもの顔色がいつもと違うと気づきました"),
        ];

        var kept = EvidenceChecker.Check(turns, [Candidate("顔色がいつもと違う"), Candidate("顔色が悪い", action: 2)]);

        var evidence = Assert.Single(kept);
        Assert.Equal("顔色がいつもと違う", evidence.Quote);
        Assert.Equal(1, evidence.Answer);
        Assert.False(evidence.FromChoice);
        Assert.Null(evidence.LinkedQuote);
    }

    [Fact(DisplayName = "validate-4（根拠は本人の言葉）: QuoteOnlyInAssistantTurnIsDropped 聞き手の問いや答えの例にだけある言葉は捨てる")]
    public void QuoteOnlyInAssistantTurnIsDropped()
    {
        IReadOnlyList<Turn> turns =
        [
            Asked("そのとき、まず何をしましたか？", "段取りを考えた", "人に頼んだ", "よく覚えていない"),
            Answered("洗濯物を取り込みました"),
        ];

        Assert.Empty(EvidenceChecker.Check(turns, [Candidate("段取りを考えた"), Candidate("まず何をしましたか")]));
    }

    [Fact(DisplayName = "validate-4（根拠は本人の言葉）: NormalizedQuoteIsDropped 整えた引用は捨てる")]
    public void NormalizedQuoteIsDropped()
    {
        IReadOnlyList<Turn> turns = [Asked("昨日の朝はどうでしたか？"), Answered("朝 8 時に送り出しました")];

        Assert.Empty(EvidenceChecker.Check(turns, [Candidate("8時に送り出しました"), Candidate("朝 8 時に送り出しました。")]));
    }

    [Fact(DisplayName = "validate-4（根拠は本人の言葉）: OutOfRangeCandidatesAreDropped 範囲外の番号は捨て、例外にしない")]
    public void OutOfRangeCandidatesAreDropped()
    {
        IReadOnlyList<Turn> turns = [Asked("昨日はどうでしたか？"), Answered("顔色がいつもと違うと気づきました")];
        const string quote = "顔色";

        var kept = EvidenceChecker.Check(turns,
        [
            Candidate(quote, answer: 0),
            Candidate(quote, answer: 2),
            Candidate(quote, action: 0),
            Candidate(quote, action: 4),
            Candidate(quote, @event: 0),
            Candidate("   "),
            Candidate(""),
        ]);

        Assert.Empty(kept);
    }

    [Fact(DisplayName = "validate-5（選んだだけでは根拠にしない）: 選んだ答えは、結びつく自由な答えの言葉がなければ捨てる")]
    public void ChoiceNeedsLinkedFreeAnswer()
    {
        IReadOnlyList<Turn> turns =
        [
            Asked("昨日はどんな日でしたか？"),
            Answered("夫と私の母の予定がぶつかっていたので、二人に電話しました"),
            Asked("そのとき、何をしましたか？", "相手の都合を聞いた", "よく覚えていない", "ほかのこと"),
            Answered("相手の都合を聞いた", AnswerKind.Choice),
        ];

        EvidenceCandidate[] dropped =
        [
            Candidate("相手の都合を聞いた", answer: 2, ability: Ability.Coordinating, action: 1),
            Candidate("相手の都合を聞いた", answer: 2, ability: Ability.Coordinating, action: 1, linkedQuote: "相手の都合を聞いた", linkedAnswer: 2),
            Candidate("相手の都合を聞いた", answer: 2, ability: Ability.Coordinating, action: 1, linkedQuote: "予定が重なって", linkedAnswer: 1),
            Candidate("相手の都合を聞いた", answer: 2, ability: Ability.Coordinating, action: 1, linkedQuote: "予定がぶつかって", linkedAnswer: 3),
        ];
        Assert.Empty(EvidenceChecker.Check(turns, dropped));

        var kept = EvidenceChecker.Check(turns,
        [
            Candidate("相手の都合を聞いた", answer: 2, ability: Ability.Coordinating, action: 1, linkedQuote: "夫と私の母の予定がぶつかっていた", linkedAnswer: 1),
        ]);

        var evidence = Assert.Single(kept);
        Assert.True(evidence.FromChoice);
        Assert.Equal("夫と私の母の予定がぶつかっていた", evidence.LinkedQuote);
        Assert.Equal(2, evidence.Answer);
    }

    [Fact(DisplayName = "validate-8（訂正したら確かめ直す）: 訂正の答えも本人の言葉として使える")]
    public void CorrectionIsUsable()
    {
        IReadOnlyList<Turn> turns =
        [
            Asked("昨日はどんな日でしたか？"),
            Answered("夫が近所の人に声をかけました"),
            Asked("話してくれてありがとうございました。"),
            Answered("声をかけたのは夫ではなく、私でした", AnswerKind.Correction),
        ];

        var kept = EvidenceChecker.Check(turns, [Candidate("声をかけたのは夫ではなく、私でした", answer: 2, ability: Ability.Coordinating, action: 2)]);

        var evidence = Assert.Single(kept);
        Assert.False(evidence.FromChoice);
        Assert.Equal(2, evidence.Answer);
    }

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: 照らし合わせを通った根拠には、どの読み取りかとして、読んだときの本人の答えの数が入る")]
    public void CheckTagsReading()
    {
        IReadOnlyList<Turn> turns =
        [
            Asked("昨日はどんな一日でしたか？"),
            Answered("朝、子どもの顔色がいつもと違うと気づきました"),
            Asked("そのとき、どうしましたか？"),
            Answered("熱を測りました"),
        ];

        var kept = Assert.Single(EvidenceChecker.Check(turns, [Candidate("熱を測りました", answer: 2, @event: 1)]));

        Assert.Equal(2, kept.Reading);
    }

    private static Evidence E(int action, string quote, int answer, int @event, int reading) =>
        new(Ability.Prioritizing, action, quote, answer, @event, false, false, null, reading);

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: EvidenceSet.Merge は前の読み取りの根拠を消さず、新しい読み取りの根拠を番号ごと足す")]
    public void MergeKeepsKnownAndAddsNewReading()
    {
        var a = E(1, "重なっていました", answer: 1, @event: 1, reading: 1);
        var b = E(2, "先に買い物を", answer: 2, @event: 2, reading: 2);
        var c = E(3, "雨が降りそう", answer: 3, @event: 1, reading: 3);

        // 新しい読み取りの根拠は、前の出来事 1 と番号が同じでも、その読み取りの番号のまま足す。同じものは 1 つにする
        Assert.Equal([a, b, c], EvidenceSet.Merge([a, b], [c, c]));

        // 新しい読み取りが a と同じ言葉を別の番号で返したら、前の a は新しいものに含まれるので残さず、新しい番号のものを残す
        var aRenumbered = a with { Event = 2, Reading = 3 };
        Assert.Equal([b, aRenumbered], EvidenceSet.Merge([a, b], [aRenumbered]));

        Assert.Equal([a, b], EvidenceSet.Merge([a, b], []));
    }

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: EvidenceSet.Merge は、新しい読み取りのある出来事に中身がすべて含まれる前の出来事だけをまとめる")]
    public void MergeDropsOnlyCoveredEarlierEvents()
    {
        var first = E(1, "重なっていました", answer: 1, @event: 1, reading: 1);
        var monday = E(1, "重なっていました", answer: 1, @event: 1, reading: 2);
        var thursday2 = E(2, "先に買い物を", answer: 2, @event: 2, reading: 2);
        var thursday3 = E(3, "雨が降りそう", answer: 2, @event: 2, reading: 2);

        // 1 回目の出来事 1（月曜）は、2 回目の出来事 1 にすべて含まれるので残さない
        Assert.Equal([monday, thursday2, thursday3], EvidenceSet.Merge([first], [monday, thursday2, thursday3]));

        // 新しい読み取りが月曜を外して木曜を出来事 1 と振り直しても、前の月曜の根拠は残し、木曜の前の根拠は新しいものに含まれるので残さない
        var thursdayAgain2 = thursday2 with { Event = 1, Reading = 3 };
        var thursdayAgain3 = thursday3 with { Event = 1, Reading = 3 };
        Assert.Equal(
            [monday, thursdayAgain2, thursdayAgain3],
            EvidenceSet.Merge([monday, thursday2, thursday3], [thursdayAgain2, thursdayAgain3]));

        // 力が違えば、同じ言葉でも含まれるとはみなさない
        var coordinating = first with { Ability = Ability.Coordinating };
        Assert.Equal([coordinating, monday], EvidenceSet.Merge([coordinating], [monday]));
    }

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: 番号を振り直す読み取りを重ねても、別の日の行動はそろわない")]
    public void RenumberingReadingsDoNotConfirmAcrossDays()
    {
        // 2 回目: 月曜（出来事 1）に行動 1、木曜（出来事 2）に行動 2 と 3。3 回目: 月曜を外し、木曜を出来事 1 に振り直す
        IReadOnlyList<Evidence> second =
        [
            E(1, "重なっていました", answer: 1, @event: 1, reading: 2),
            E(2, "先に買い物をすませて、洗濯は後回しにしました", answer: 2, @event: 2, reading: 2),
            E(3, "雨が降りそうだったので", answer: 2, @event: 2, reading: 2),
        ];
        IReadOnlyList<Evidence> third =
        [
            E(2, "先に買い物をすませて", answer: 2, @event: 1, reading: 3),
            E(3, "雨が降りそうだった", answer: 2, @event: 1, reading: 3),
        ];

        var result = AbilityStates.Evaluate(EvidenceSet.Merge(second, third)).Single(r => r.Ability == Ability.Prioritizing);

        Assert.Equal(AbilityState.NeedsCheck, result.State);
        Assert.Equal([1], result.Missing);
        Assert.All(result.Shown, e => Assert.Equal(3, e.Reading));
    }
}
