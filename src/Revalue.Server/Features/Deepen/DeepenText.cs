using Revalue.Server.Features.Options;

namespace Revalue.Server.Features.Deepen;

/// <summary>コードが決めた一歩の候補（06-deepen.md の「AI が書いた中身をコードで確かめる」。文は Claude の判断）。</summary>
public static class DeepenText
{
    private const string WriteOut = "この仕事について、知りたいことや気になることを 3 つ書き出してみる";
    private const string ReadStory = "この仕事をしている人の体験談を、本やウェブの記事で 1 つ読んでみる";
    private const string ReadPosting = "この仕事の募集を 2〜3 件読んで、業務の中身と時間の条件を書き出してみる";
    private const string AskAcquaintances = "身近な知り合い 2〜3 人に、この困りごとがあるか、どんなときに困るかを聞いてみる";

    /// <summary>どれも 1 時間で、家でできる。どんな条件でも収まる。「創る」は 1 つ目が需要の確かめ。</summary>
    public static IReadOnlyList<StepCandidate> FallbackSteps(TargetKind kind) => kind == TargetKind.Create
        ?
        [
            new("f1", AskAcquaintances, 1, TaskPlace.Home, true),
            new("f2", WriteOut, 1, TaskPlace.Home, false),
            new("f3", ReadStory, 1, TaskPlace.Home, false),
        ]
        :
        [
            new("f1", WriteOut, 1, TaskPlace.Home, false),
            new("f2", ReadStory, 1, TaskPlace.Home, false),
            new("f3", ReadPosting, 1, TaskPlace.Home, false),
        ];
}
