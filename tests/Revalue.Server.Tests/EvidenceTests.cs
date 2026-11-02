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

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: EvidenceSet.Merge は重複をまとめ、前の根拠を消さない")]
    public void MergeKeepsKnownAndDeduplicates()
    {
        var a = new Evidence(Ability.Noticing, 1, "いつもと違う", 1, 1, false, false, null);
        var b = new Evidence(Ability.Noticing, 2, "顔色", 1, 1, false, false, null);
        var aAgain = a with { Event = 2 };
        var c = new Evidence(Ability.Noticing, 3, "前は", 2, 1, false, false, null);

        var merged = EvidenceSet.Merge([a, b], [aAgain, c]);

        Assert.Equal([a, b, c], merged);
        Assert.Equal([a, b], EvidenceSet.Merge([a, b], []));
    }
}
