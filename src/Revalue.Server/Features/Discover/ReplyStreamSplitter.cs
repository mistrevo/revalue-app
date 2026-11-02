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
/// </summary>
public sealed partial class ReplyStreamSplitter
{
    public const string Delimiter = "---選択肢---";

    private const int ChoiceCount = 3;

    private readonly StringBuilder _streamed = new();
    private readonly StringBuilder _choicesText = new();
    private string _held = "";
    private bool _delimiterFound;

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
        var index = pending.IndexOf(Delimiter, StringComparison.Ordinal);
        if (index >= 0)
        {
            _delimiterFound = true;
            _held = "";
            _choicesText.Append(pending, index + Delimiter.Length, pending.Length - index - Delimiter.Length);
            return Emit(pending[..index]);
        }

        var holdLength = OverlapWithDelimiterStart(pending);
        _held = pending[(pending.Length - holdLength)..];
        return Emit(pending[..(pending.Length - holdLength)]);
    }

    /// <summary>返事を最後まで受け取ったあとに呼ぶ。</summary>
    /// <param name="expectChoices">選択肢を求めるか。締めの返事では false。</param>
    public ReplyParts Complete(bool expectChoices = true)
    {
        var tail = _held;
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
}
