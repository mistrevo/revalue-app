using System.Runtime.CompilerServices;
using Revalue.Server.Features.Discover;

namespace Revalue.Server.Ai;

/// <summary>
/// 決まった返事を返す偽物の AI。開発（Development）で画面を通すためと、テストのためのもの。Claude を呼ばない。
/// 読み取りは目印の言葉で決め、返事は一手ごとの決まった文を数かけらに分けて返す。言い方の品質は問わない。
/// </summary>
public sealed class ScriptedConversationAi : IConversationAi
{
    private static readonly string[] DistressMarkers = ["死にたい", "消えたい", "つらくて", "つらい", "眠れない", "殴られ", "暴力"];
    private static readonly string[] DontKnowMarkers = ["分からない", "わからない", "何もない", "なにもない", "覚えていない"];
    private static readonly string[] IllnessMarkers = ["病院", "熱", "入院", "病気", "通院"];
    private static readonly string[] GeneralMarkers = ["いつも", "毎日"];

    public Task<TurnReading> ReadAsync(IReadOnlyList<Turn> turns, CancellationToken ct)
    {
        var answer = turns.LastOrDefault(t => t.Role == TurnRoles.User)?.Text ?? "";
        var signals = new HashSet<AnswerSignal>();
        if (ContainsAny(answer, DistressMarkers))
        {
            signals.Add(AnswerSignal.Distress);
        }

        if (ContainsAny(answer, DontKnowMarkers))
        {
            signals.Add(AnswerSignal.DontKnow);
        }

        if (ContainsAny(answer, IllnessMarkers))
        {
            signals.Add(AnswerSignal.FamilyIllness);
        }

        if (ContainsAny(answer, GeneralMarkers))
        {
            signals.Add(AnswerSignal.GeneralOnly);
        }

        if (signals.Count == 0)
        {
            signals.Add(AnswerSignal.ConcreteEvent);
        }

        return Task.FromResult(new TurnReading(signals));
    }

    public async IAsyncEnumerable<string> StreamReplyAsync(IReadOnlyList<Turn> turns, MoveKind move, [EnumeratorCancellation] CancellationToken ct)
    {
        var (body, choices) = Script(move);
        var text = choices is null
            ? body
            : body + "\n" + ReplyStreamSplitter.Delimiter + "\n" + string.Join("\n", choices.Select(c => "- " + c));

        // 少しずつ流れることを画面で確かめられるよう、数かけらに分ける
        const int size = 8;
        for (var i = 0; i < text.Length; i += size)
        {
            ct.ThrowIfCancellationRequested();
            await Task.Delay(30, ct);
            yield return text.Substring(i, Math.Min(size, text.Length - i));
        }
    }

    private static (string Body, string[]? Choices) Script(MoveKind move) => move switch
    {
        MoveKind.AskWhatYouDid => (
            "（開発用の決まった返事）話してくれてありがとうございます。その場面で、あなたが最初にしたことは何でしたか？",
            ["段取りを考えた", "人に声をかけた", "とりあえず手を動かした"]),
        MoveKind.AskConcreteEvent => (
            "（開発用の決まった返事）いつもそうしているんですね。最近そうした日を一つ思い出すと、どんな日でしたか？",
            ["昨日のこと", "先週のこと", "先月のこと"]),
        MoveKind.AskEasierScene => (
            "（開発用の決まった返事）そう感じることもありますよね。では、昨日の朝ごはんの前後は、どんなふうに過ごしましたか？",
            ["家族の支度をした", "ひとりで過ごした", "外に出かけた"]),
        MoveKind.ReturnFromIllness => (
            "（開発用の決まった返事）大変な日でしたね。そのとき、あなたはまず何をしましたか？",
            ["予定を組み直した", "人に頼んだ", "必要なものをそろえた"]),
        MoveKind.Close => (
            "（開発用の決まった返事）たくさん聞かせてくれてありがとうございました。この場面の話は、ここで一区切りにしますね。",
            null),
        _ => (DiscoverText.DistressText, null),
    };

    private static bool ContainsAny(string text, IEnumerable<string> markers) =>
        markers.Any(m => text.Contains(m, StringComparison.Ordinal));
}
