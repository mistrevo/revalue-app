using System.Runtime.CompilerServices;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Ai;

/// <summary>
/// 決まった返事を返す偽物の AI。開発（Development）で画面を通すためと、テストのためのもの。Claude を呼ばない。
/// 読み取りは目印の言葉で決め、返事は一手ごとの決まった文を数かけらに分けて返す。言い方の品質は問わない。
/// 開発で「見えたこと」を確かめられるよう、場面の答え（自由に書いた答えか訂正）に行動の目印の言葉があれば、
/// その答えの文全体を引用にした根拠の候補を返す（出来事 1、一般論でない。Claude の判断）。
/// 本物の読み取り（reader.md）と同じく、いまの答えだけでなく場面のやりとり全体から探す。出来事の番号は読み取りごとに見分けるので
/// （03-validate.md の「力の状態」）、いまの答えだけを返すと、答えをまたいだ行動が一つの出来事にそろわない。
/// </summary>
public sealed class ScriptedConversationAi : IConversationAi
{
    private static readonly string[] DistressMarkers = ["死にたい", "消えたい", "つらくて", "つらい", "眠れない", "殴られ", "暴力"];
    private static readonly string[] DontKnowMarkers = ["分からない", "わからない", "何もない", "なにもない", "覚えていない"];
    private static readonly string[] IllnessMarkers = ["病院", "熱", "入院", "病気", "通院"];
    private static readonly string[] GeneralMarkers = ["いつも", "毎日"];

    /// <summary>根拠の候補を返す目印の言葉と、その行動。</summary>
    private static readonly (string[] Markers, Ability Ability, int Action)[] ActionMarkers =
    [
        (["いつもと違う", "気づ"], Ability.Noticing, 1),
        (["様子", "顔色"], Ability.Noticing, 2),
        (["前は", "いつもは"], Ability.Noticing, 3),
        (["都合"], Ability.Coordinating, 1),
        (["頼", "お願い", "声をかけ"], Ability.Coordinating, 2),
        (["代わり", "合わせ"], Ability.Coordinating, 3),
        (["重な"], Ability.Prioritizing, 1),
        (["先に", "後回し"], Ability.Prioritizing, 2),
        (["だから", "ので"], Ability.Prioritizing, 3),
    ];

    public Task<TurnReading> ReadAsync(IReadOnlyList<Turn> turns, CancellationToken ct)
    {
        var last = turns.LastOrDefault(t => t.Role == TurnRoles.User);
        var answer = last?.Text ?? "";
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

        return Task.FromResult(new TurnReading(signals, Candidates(turns)));
    }

    private static List<EvidenceCandidate> Candidates(IReadOnlyList<Turn> turns) =>
        turns
            .Where(t => t.Role == TurnRoles.User)
            .Select((answer, index) => (Answer: answer, Number: index + 1))
            // 選んだ答えは、それだけでは根拠にしないので、候補を返さない
            .Where(a => a.Answer.AnswerKind != AnswerKind.Choice)
            .SelectMany(a => ActionMarkers
                .Where(m => ContainsAny(a.Answer.Text, m.Markers))
                .Select(m => new EvidenceCandidate(m.Ability, m.Action, a.Answer.Text, a.Number, 1, false, "", 0)))
            .ToList();

    public async IAsyncEnumerable<string> StreamReplyAsync(IReadOnlyList<Turn> turns, NextMove move, [EnumeratorCancellation] CancellationToken ct)
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

    private static (string Body, string[]? Choices) Script(NextMove move) => move.Kind switch
    {
        MoveKind.AskMissingAction when move.Target is { } target => (
            $"（開発用の決まった返事）話してくれてありがとうございます。そのときのことを、もう少し聞かせてください。{AbilityText.ResumeAsk(target)}",
            [.. AbilityText.ResumeChoices]),
        MoveKind.AskWhatYouDid => (
            "（開発用の決まった返事）話してくれてありがとうございます。その場面で、あなたが最初にしたことは何でしたか？",
            ["まず家のことをした", "人に連絡した", "よく覚えていない"]),
        MoveKind.AskConcreteEvent => (
            "（開発用の決まった返事）いつもそうしているんですね。最近そうした日を一つ思い出すと、どんな日でしたか？",
            ["昨日のこと", "先週のこと", "先月のこと"]),
        MoveKind.AskEasierScene => (
            "（開発用の決まった返事）話してくれてありがとうございます。では、昨日の朝ごはんの前後は、どんなふうに過ごしましたか？",
            ["家族の支度をした", "ひとりで過ごした", "外に出かけた"]),
        MoveKind.ReturnFromIllness => (
            "（開発用の決まった返事）話してくれてありがとうございます。そのとき、あなたはまず何をしましたか？",
            ["予定を変えた", "人に連絡した", "よく覚えていない"]),
        MoveKind.Close => (
            "（開発用の決まった返事）たくさん聞かせてくれてありがとうございました。この場面の話は、ここで一区切りにしますね。",
            null),
        _ => (DiscoverText.DistressText, null),
    };

    private static bool ContainsAny(string text, IEnumerable<string> markers) =>
        markers.Any(m => text.Contains(m, StringComparison.Ordinal));
}
