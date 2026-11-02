using System.Text;
using System.Text.RegularExpressions;

namespace Revalue.Server.Features.Discover;

/// <summary>
/// 返事の分かれたもの。
/// </summary>
/// <param name="Body">本文（区切りの前まで。末尾の空白を除く）。保存する文。</param>
/// <param name="Choices">選択肢 3 つ。読み取れなければ <see cref="DiscoverText.FallbackChoices"/>。選択肢を求めないときは空。</param>
/// <param name="UsedFallback">汎用の選択肢で補ったか。</param>
/// <param name="Tail">区切りの始まりかもしれないので待っていたが、結局本文だった最後のかけら。Complete のあとに画面へ流す。</param>
public sealed record ReplyParts(string Body, IReadOnlyList<string> Choices, bool UsedFallback, string Tail);

/// <summary>
/// AI の返事の流れを、画面に流す本文と、最後にまとめて送る選択肢に分ける。
/// AI は本文のあとに <see cref="Delimiter"/> の行と、選択肢を 1 行に 1 つずつ書く。
/// 区切りがかけらの境目で分かれて届いても、区切りの一部と選択肢は本文として流さない。
/// そのため、いま届いた文の終わりが区切りの始まりと重なるあいだだけ、その部分を流さずに待つ。
/// AI が区切りを少し違う形（空白入り、全角のダッシュ、「選択肢:」、【選択肢】など）で書いても、
/// 一行がそれだけなら区切りとみなす。行の始まりから区切りに読めるあいだは、その行を流さずに待つ。
/// </summary>
public sealed partial class ReplyStreamSplitter
{
    public const string Delimiter = "---選択肢---";

    private const int ChoiceCount = 3;

    private readonly StringBuilder _streamed = new();
    private readonly StringBuilder _choicesText = new();
    private string _held = "";
    private bool _delimiterFound;

    // _held の先頭（何も待っていなければ、次に届く文の先頭）が、行の始まりか
    private bool _atLineStart = true;

    /// <summary>届いたかけらを渡し、画面に流してよい本文のかけらを返す（なければ何も返さない）。</summary>
    public IEnumerable<string> Push(string chunk)
    {
        if (string.IsNullOrEmpty(chunk))
        {
            return [];
        }

        if (_delimiterFound)
        {
            _choicesText.Append(chunk);
            return [];
        }

        var pending = _held + chunk;
        if (FindDelimiter(pending, _atLineStart) is var (start, end))
        {
            _delimiterFound = true;
            _held = "";
            _choicesText.Append(pending, end, pending.Length - end);
            return Emit(pending[..start]);
        }

        var holdLength = Math.Max(OverlapWithDelimiterStart(pending), LineToHold(pending, _atLineStart));
        var ready = pending[..(pending.Length - holdLength)];
        _held = pending[ready.Length..];
        if (ready.Length > 0)
        {
            _atLineStart = ready[^1] == '\n';
        }

        return Emit(ready);
    }

    /// <summary>返事を最後まで受け取ったあとに呼ぶ。</summary>
    /// <param name="expectChoices">選択肢を求めるか。締めの返事では false。</param>
    public ReplyParts Complete(bool expectChoices = true)
    {
        // 最後の行が区切りだけなら、本文に入れない
        var tail = _atLineStart && IsDelimiterLine(_held) ? "" : _held;
        _streamed.Append(tail);
        _held = "";
        var body = _streamed.ToString().TrimEnd();

        if (!expectChoices)
        {
            return new ReplyParts(body, [], false, tail);
        }

        var choices = _choicesText.ToString()
            .Split('\n')
            .Select(CleanChoice)
            .Where(c => c.Length > 0)
            .Take(ChoiceCount)
            .ToList();
        return choices.Count == ChoiceCount
            ? new ReplyParts(body, choices, false, tail)
            : new ReplyParts(body, DiscoverText.FallbackChoices, true, tail);
    }

    private IEnumerable<string> Emit(string text)
    {
        if (text.Length == 0)
        {
            return [];
        }

        _streamed.Append(text);
        return [text];
    }

    /// <summary>
    /// pending の中の区切りを探し、区切りの始まりと、選択肢が始まる位置を返す。なければ null。
    /// 決まった形（<see cref="Delimiter"/>）は行の途中でも見つける。少し違う形は、それだけで一行になっているときだけ見つける。
    /// </summary>
    private static (int Start, int End)? FindDelimiter(string pending, bool startsLine)
    {
        (int Start, int End)? found = null;
        var exact = pending.IndexOf(Delimiter, StringComparison.Ordinal);
        if (exact >= 0)
        {
            // 区切りの前の空白は、本文に入れない
            var start = exact;
            while (start > 0 && pending[start - 1] is ' ' or '\t' or '　')
            {
                start--;
            }

            found = (start, exact + Delimiter.Length);
        }

        // 行の始まりがなければ、少し違う形は探さない
        var lineStart = startsLine ? 0 : pending.IndexOf('\n') + 1;
        if (!startsLine && lineStart == 0)
        {
            return found;
        }

        // 終わっている行だけを、決まった形より前にあるかぎり見る
        while (found is null || lineStart < found.Value.Start)
        {
            var lineEnd = pending.IndexOf('\n', lineStart);
            if (lineEnd < 0)
            {
                break;
            }

            if (IsDelimiterLine(pending[lineStart..lineEnd]))
            {
                return (lineStart, lineEnd);
            }

            lineStart = lineEnd + 1;
        }

        return found;
    }

    /// <summary>pending の最後の、まだ終わっていない行が、区切りの書き始めに読めるなら、その長さ。読めなければ 0。</summary>
    private static int LineToHold(string pending, bool startsLine)
    {
        var lastBreak = pending.LastIndexOf('\n');
        if (lastBreak < 0 && !startsLine)
        {
            return 0;
        }

        var line = pending[(lastBreak + 1)..];
        return line.Length > 0 && DelimiterLineStart().IsMatch(line.Trim()) ? line.Length : 0;
    }

    private static bool IsDelimiterLine(string line) => DelimiterLine().IsMatch(line.Trim());

    /// <summary>text の終わりのうち、区切りの始まりと重なるいちばん長い部分の長さ。</summary>
    private static int OverlapWithDelimiterStart(string text)
    {
        for (var length = Math.Min(Delimiter.Length - 1, text.Length); length > 0; length--)
        {
            if (string.CompareOrdinal(text, text.Length - length, Delimiter, 0, length) == 0)
            {
                return length;
            }
        }

        return 0;
    }

    /// <summary>選択肢の行から、先頭の記号（-、・、* など）と番号（1.、2)、①など）を外す。</summary>
    private static string CleanChoice(string line) => ChoiceMarker().Replace(line.Trim(), "").Trim();

    [GeneratedRegex(@"^(?:[-‐−*＊・•●○]|[0-9０-９]+[.)．）、:：]|[①-⑳])\s*")]
    private static partial Regex ChoiceMarker();

    // 区切りだけの一行。例: ---選択肢---、--- 選択肢 ---、－－－選択肢－－－、選択肢:、【選択肢】、**選択肢**
    [GeneratedRegex(@"^[-‐‑‒–—―−－ー─━=＝*＊#＃]*\s*[【\[]?選択肢[】\]]?\s*[-‐‑‒–—―−－ー─━=＝*＊:：]*$")]
    private static partial Regex DelimiterLine();

    // 区切りだけの一行の、書き始め（まだ終わっていない行）
    [GeneratedRegex(@"^[-‐‑‒–—―−－ー─━=＝*＊#＃]*\s*[【\[]?(?:選(?:択(?:肢[】\]]?\s*[-‐‑‒–—―−－ー─━=＝*＊:：]*)?)?)?$")]
    private static partial Regex DelimiterLineStart();
}
