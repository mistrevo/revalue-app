using System.Runtime.CompilerServices;
using Revalue.Server.Ai;
using Revalue.Server.Features.Discover;

namespace Revalue.Server.Tests;

/// <summary>
/// テストで差し替える偽物の AI。読み取りの結果、返事のかけら、失敗する場所をテストから決める。
/// </summary>
public sealed class FakeConversationAi : IConversationAi
{
    /// <summary>選択肢を求める一手で返すかけら。区切りの行を、かけらの境目でわざと分けている。</summary>
    public static readonly string[] DefaultChunks =
        ["話してくれて", "ありがとうございます。", "そのとき、何を", "しましたか？\n---選", "択肢---\n- 段取りを考えた\n- 人に頼んだ\n- 手を動かした"];

    public static readonly string[] DefaultChoices = ["段取りを考えた", "人に頼んだ", "手を動かした"];

    public const string DefaultBody = "話してくれてありがとうございます。そのとき、何をしましたか？";

    /// <summary>締めの返事のかけら（選択肢なし）。</summary>
    public static readonly string[] CloseChunks = ["たくさん聞かせてくれて", "ありがとうございました。"];

    private readonly object _gate = new();
    private readonly List<MoveKind> _moves = [];

    /// <summary>読み取りの結果。既定は「具体的な出来事がある」。</summary>
    public Func<IReadOnlyList<Turn>, TurnReading> Reading { get; set; } =
        _ => new TurnReading(new HashSet<AnswerSignal> { AnswerSignal.ConcreteEvent });

    /// <summary>選択肢を求める一手で返すかけら。既定は <see cref="DefaultChunks"/>。</summary>
    public IReadOnlyList<string> ReplyChunks { get; set; } = DefaultChunks;

    /// <summary>次の読み取りで投げる例外の種類（refusal か failure）。1 回だけ効く。</summary>
    public string? FailNextRead { get; set; }

    /// <summary>次の返事で、何かけら返したあとに投げるか。1 回だけ効く。</summary>
    public (int AfterChunks, string Kind)? FailNextReply { get; set; }

    /// <summary>返事の最初のかけらを返す前に呼ぶ。返事の途中でほかの操作を割り込ませるときに使う。</summary>
    public Func<Task>? BeforeReply { get; set; }

    public int ReadCalls { get; private set; }

    public IReadOnlyList<MoveKind> Moves
    {
        get
        {
            lock (_gate)
            {
                return _moves.ToArray();
            }
        }
    }

    public Task<TurnReading> ReadAsync(IReadOnlyList<Turn> turns, CancellationToken ct)
    {
        ReadCalls++;
        var fail = FailNextRead;
        FailNextRead = null;
        if (fail is not null)
        {
            throw new ConversationAiException(fail);
        }

        return Task.FromResult(Reading(turns));
    }

    public async IAsyncEnumerable<string> StreamReplyAsync(IReadOnlyList<Turn> turns, MoveKind move, [EnumeratorCancellation] CancellationToken ct)
    {
        lock (_gate)
        {
            _moves.Add(move);
        }

        var fail = FailNextReply;
        FailNextReply = null;
        if (BeforeReply is { } before)
        {
            await before();
        }

        IReadOnlyList<string> chunks = move == MoveKind.Close ? CloseChunks : ReplyChunks;
        for (var i = 0; i < chunks.Count; i++)
        {
            if (fail is { } f && i == f.AfterChunks)
            {
                throw new ConversationAiException(f.Kind);
            }

            await Task.Yield();
            yield return chunks[i];
        }

        // 本物の AI は、拒否を最後（止まった理由）で知らせることがある
        if (fail is { } last && last.AfterChunks >= chunks.Count)
        {
            throw new ConversationAiException(last.Kind);
        }
    }
}
