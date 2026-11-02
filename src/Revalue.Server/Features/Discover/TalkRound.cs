using System.Runtime.CompilerServices;
using Revalue.Server.Ai;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Discover;

/// <summary>1 往復の中で起きたこと。<see cref="TalkRound.RunAsync"/> が起きた順に返す。</summary>
public abstract record RoundStep
{
    private RoundStep()
    {
    }

    /// <summary>読み取りと次の一手が決まった。<paramref name="Evidence"/> は、前の根拠に照らし合わせを通った新しい根拠を足したもの。</summary>
    public sealed record Decided(TurnReading Reading, NextMove Move, IReadOnlyList<Evidence> Evidence) : RoundStep;

    /// <summary>返事の本文のかけら。画面にそのまま流してよい（選択肢は含まない）。</summary>
    public sealed record Text(string Piece) : RoundStep;

    /// <summary>
    /// うまくいかなかった。ここで 1 往復を終える。
    /// </summary>
    /// <param name="Kind">画面に知らせる種類（<see cref="ConversationAiException.Failure"/> か <see cref="ConversationAiException.Refusal"/>）。</param>
    /// <param name="AddSupport">相談窓口を添えるか。つらい状態のサインを見落としているかもしれないとき true。</param>
    /// <param name="InReading">読み取りで起きたか（false なら返事で起きた）。</param>
    /// <param name="UnexpectedError">AI の呼び出しの失敗として決めていない例外の型の名前（ログ用。中身は持たない）。</param>
    /// <param name="EmptyBody">返事を最後まで受け取ったが、本文がなかった。</param>
    public sealed record Failed(string Kind, bool AddSupport, bool InReading, string? UnexpectedError = null, bool EmptyBody = false) : RoundStep;

    /// <summary>返事ができた。保存する返事のターン。つらい状態のサインでは、決まった言葉（選択肢なし）。</summary>
    /// <param name="UsedFallbackChoices">選択肢を読み取れず、汎用の 3 つで補ったか。</param>
    public sealed record Replied(Turn Reply, bool UsedFallbackChoices) : RoundStep;
}

/// <summary>1 往復に渡すもの。</summary>
/// <param name="Turns">ここまでのやりとり。最後は、いま届いた利用者の答え。</param>
/// <param name="Known">この場面で前の往復までに確かめた根拠。</param>
/// <param name="UserTurnNumber">いまの答えが何往復目か（1 から）。</param>
/// <param name="TurnLimit">この場面の往復の上限。</param>
/// <param name="SetAside">
/// 力の確かめに使わない印（つらい状態のサイン）が付いた場面か。true なら根拠を照らし合わせず、足りない行動も聞かない（02 discover（話す）の一手だけ）。
/// 打ち明けたあとの人に、確かめのための問いを重ねないため（03-validate.md の「次の一手」）。
/// </param>
public sealed record RoundContext(IReadOnlyList<Turn> Turns, IReadOnlyList<Evidence> Known, int UserTurnNumber, int TurnLimit, bool SetAside = false);

/// <summary>
/// 1 往復の中身（保存を除く）。読み取り → 根拠の照らし合わせ → 次の一手 → 返事 → 本文と選択肢に分ける、を順に行い、起きたことを返す。
/// 製品（<see cref="TalkStream"/>）と評価（evals/Revalue.Evals の EvalRunner）の両方がこれを使う。
/// 流れの順番と、失敗したときの扱いを 1 か所に置き、製品と評価がずれないようにする。
/// </summary>
public static class TalkRound
{
    public static async IAsyncEnumerable<RoundStep> RunAsync(
        IConversationAi ai, RoundContext context, TimeProvider time, [EnumeratorCancellation] CancellationToken ct)
    {
        var turns = context.Turns;
        // 1. 読み取り。失敗したら、つらい状態のサインを見落としているかもしれないので、窓口を添える
        TurnReading? reading = null;
        RoundStep.Failed? readFailed = null;
        try
        {
            reading = await ai.ReadAsync(turns, ct);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            readFailed = Failure(e, inReading: true);
        }

        if (reading is null)
        {
            yield return readFailed ?? new RoundStep.Failed(ConversationAiException.Failure, AddSupport: true, InReading: true);
            yield break;
        }

        // 2. 根拠の照らし合わせ。前の往復の根拠は残し、新しく通ったものを足す（読み取りが往復ごとに揺れても見立てが行ったり来たりしないように）。
        // 力の確かめに使わない印のある場面では、照らし合わせず、足りない行動も聞かない
        var evidence = context.SetAside
            ? context.Known
            : EvidenceSet.Merge(context.Known, EvidenceChecker.Check(turns, reading.Candidates));
        var validation = context.SetAside ? null : ValidationContext.From(turns, evidence);

        // 3. 次の一手
        var next = NextMovePolicy.Decide(reading, context.UserTurnNumber, validation, context.TurnLimit);
        var move = next.Kind;
        yield return new RoundStep.Decided(reading, next, evidence);

        // つらい状態のサインには AI の返事を使わず、決まった言葉で応える
        if (move == MoveKind.Distress)
        {
            yield return new RoundStep.Replied(
                new Turn { Role = TurnRoles.Assistant, Text = DiscoverText.DistressText, Move = TalkStream.MoveName(move), At = time.GetUtcNow() },
                UsedFallbackChoices: false);
            yield break;
        }

        // 4. 返事。本文だけを少しずつ返し、選択肢は最後に分ける
        var splitter = new ReplyStreamSplitter();
        RoundStep.Failed? replyFailed = null;
        var reply = ai.StreamReplyAsync(turns, next, ct).GetAsyncEnumerator(ct);
        await using (reply)
        {
            while (true)
            {
                string chunk;
                try
                {
                    if (!await reply.MoveNextAsync())
                    {
                        break;
                    }

                    chunk = reply.Current;
                }
                catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
                {
                    replyFailed = Failure(e, inReading: false);
                    break;
                }

                foreach (var piece in splitter.Push(chunk))
                {
                    yield return new RoundStep.Text(piece);
                }
            }
        }

        if (replyFailed is not null)
        {
            yield return replyFailed;
            yield break;
        }

        var close = move == MoveKind.Close;
        var parts = splitter.Complete(expectChoices: !close);
        if (parts.Tail.Length > 0)
        {
            yield return new RoundStep.Text(parts.Tail);
        }

        // 本文のない返事は保存しない（受け止めの言葉がないまま場面が進まないように。Claude の判断）
        if (parts.Body.Length == 0)
        {
            yield return new RoundStep.Failed(ConversationAiException.Failure, AddSupport: false, InReading: false, EmptyBody: true);
            yield break;
        }

        yield return new RoundStep.Replied(
            new Turn
            {
                Role = TurnRoles.Assistant,
                Text = parts.Body,
                Choices = close ? null : parts.Choices,
                Move = TalkStream.MoveName(move),
                Target = next.Target?.ToString(),
                At = time.GetUtcNow(),
            },
            UsedFallbackChoices: !close && parts.UsedFallback);
    }

    /// <summary>
    /// AI の呼び出しの失敗を、知らせる種類にする。思いがけない例外は不調として扱い、型の名前だけを残す。
    /// 読み取りの失敗と、返事を AI が断ったときは、窓口を添える。断られるのはつらい内容を話したときが多く、
    /// 読み取りがサインを見落としていたかもしれないため（Claude の判断）。
    /// </summary>
    private static RoundStep.Failed Failure(Exception e, bool inReading)
    {
        var known = e as ConversationAiException;
        var kind = known?.Kind ?? ConversationAiException.Failure;
        var addSupport = inReading || kind == ConversationAiException.Refusal;
        return new RoundStep.Failed(kind, addSupport, inReading, UnexpectedError: known is null ? e.GetType().Name : null);
    }
}
