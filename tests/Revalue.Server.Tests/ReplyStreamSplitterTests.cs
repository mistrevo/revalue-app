using Revalue.Server.Features.Discover;

namespace Revalue.Server.Tests;

public sealed class ReplyStreamSplitterTests
{
    /// <summary>かけらを順に流し、画面に流した本文のかけら（最後の Tail を含む）と、まとめた結果を返す。</summary>
    private static (List<string> Streamed, ReplyParts Parts) Run(bool expectChoices, params string[] chunks)
    {
        var splitter = new ReplyStreamSplitter();
        var streamed = new List<string>();
        foreach (var chunk in chunks)
        {
            streamed.AddRange(splitter.Push(chunk));
        }

        var parts = splitter.Complete(expectChoices);
        if (parts.Tail.Length > 0)
        {
            streamed.Add(parts.Tail);
        }

        return (streamed, parts);
    }

    [Fact(DisplayName = "discover-7（返答が少しずつ流れる）: 区切りの行が分かれて届いても本文に漏れない")]
    public void DelimiterSplitAcrossChunksDoesNotLeak()
    {
        var (streamed, parts) = Run(true, "ありがとう。\n---選", "択肢---\n- A\n- B\n- C");

        Assert.Equal("ありがとう。\n", string.Concat(streamed));
        Assert.Equal(["A", "B", "C"], parts.Choices);
        Assert.False(parts.UsedFallback);
        Assert.Equal("ありがとう。", parts.Body);
    }

    [Fact(DisplayName = "discover-7（返答が少しずつ流れる）: 区切りが 1 文字ずつ届いても、選択肢は本文に漏れない")]
    public void DelimiterArrivingCharByCharDoesNotLeak()
    {
        const string reply = "朝の支度を一人で回したんですね。\nそのとき、最初に何をしましたか？\n---選択肢---\n1. 子どもを起こした\n2) お弁当を作った\n・洗濯機を回した\n";
        var (streamed, parts) = Run(true, reply.Select(c => c.ToString()).ToArray());

        var text = string.Concat(streamed);
        Assert.Equal("朝の支度を一人で回したんですね。\nそのとき、最初に何をしましたか？\n", text);
        Assert.DoesNotContain("---", text);
        Assert.DoesNotContain("お弁当", text);
        Assert.Equal(["子どもを起こした", "お弁当を作った", "洗濯機を回した"], parts.Choices);
    }

    [Fact(DisplayName = "discover-3（選んでも書いてもよい）: 選択肢の先頭の記号や番号を外し、3 つまで取る")]
    public void ChoiceMarkersAreStripped()
    {
        var (_, parts) = Run(true, "本文\n---選択肢---\n- 一つ目\n\n＊ 二つ目\n３．三つ目\n- 四つ目");

        Assert.Equal(["一つ目", "二つ目", "三つ目"], parts.Choices);
        Assert.False(parts.UsedFallback);
    }

    [Fact(DisplayName = "discover-3（選んでも書いてもよい）: 選択肢が読み取れなければ汎用の 3 つで補う")]
    public void FallbackWhenChoicesMissing()
    {
        var (streamedNone, none) = Run(true, "区切りのない返事です。", "どんな日でしたか？");
        Assert.Equal(DiscoverText.FallbackChoices, none.Choices);
        Assert.True(none.UsedFallback);
        Assert.Equal("区切りのない返事です。どんな日でしたか？", string.Concat(streamedNone));
        Assert.Equal("区切りのない返事です。どんな日でしたか？", none.Body);

        var (_, two) = Run(true, "本文\n---選択肢---\n- A\n- B\n");
        Assert.Equal(DiscoverText.FallbackChoices, two.Choices);
        Assert.True(two.UsedFallback);
        Assert.Equal("本文", two.Body);
    }

    [Fact(DisplayName = "discover-6（一場面ずつ区切り、続きから話せる）: 締めの返事は選択肢を求めない")]
    public void CloseExpectsNoChoices()
    {
        var (streamed, parts) = Run(false, "今日はここまでにしましょう。", "話してくれてありがとうございました。");

        Assert.Empty(parts.Choices);
        Assert.False(parts.UsedFallback);
        Assert.Equal("今日はここまでにしましょう。話してくれてありがとうございました。", string.Concat(streamed));

        // 締めでも区切りを書いてきたら、選択肢は捨てて本文だけにする
        var (streamed2, withDelimiter) = Run(false, "おつかれさまでした。\n---選択肢---\n- A\n- B\n- C");
        Assert.Empty(withDelimiter.Choices);
        Assert.Equal("おつかれさまでした。", withDelimiter.Body);
        Assert.Equal("おつかれさまでした。\n", string.Concat(streamed2));
    }

    [Fact(DisplayName = "discover-7（返答が少しずつ流れる）: 本文が長く、区切りがないときも、本文は少しずつ流れる")]
    public void LongBodyStreamsIncrementally()
    {
        var splitter = new ReplyStreamSplitter();

        Assert.Equal("一つ目の文です。", string.Concat(splitter.Push("一つ目の文です。")));
        Assert.Equal("二つ目の文です。\n", string.Concat(splitter.Push("二つ目の文です。\n")));
        Assert.Equal("三つ目", string.Concat(splitter.Push("三つ目")));

        // 区切りの始まりかもしれない部分だけを待つ
        Assert.Equal("の文です。\n", string.Concat(splitter.Push("の文です。\n--")));
        Assert.Equal("--ではなかった", string.Concat(splitter.Push("ではなかった")));

        var parts = splitter.Complete(true);
        Assert.Equal("", parts.Tail);
        Assert.Equal("一つ目の文です。二つ目の文です。\n三つ目の文です。\n--ではなかった", parts.Body);
    }

    [Fact(DisplayName = "discover-7（返答が少しずつ流れる）: 最後に待っていた部分は Tail で渡す")]
    public void HeldTailIsReturnedOnComplete()
    {
        var splitter = new ReplyStreamSplitter();

        Assert.Equal("本文\n", string.Concat(splitter.Push("本文\n-")));
        var parts = splitter.Complete(true);

        Assert.Equal("-", parts.Tail);
        Assert.Equal("本文\n-", parts.Body);
        Assert.True(parts.UsedFallback);
    }
}
