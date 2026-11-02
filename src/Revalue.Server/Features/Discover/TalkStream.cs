using System.Globalization;
using System.Net.ServerSentEvents;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using Revalue.Server.Ai;
using Revalue.Server.Data;

namespace Revalue.Server.Features.Discover;

/// <summary>
/// 相談窓口の知らせ。<c>kind</c> は "distress"（つらい状態のサインへの応え）か "support"（読み取りに失敗したときに添える）。
/// </summary>
public sealed record SupportNotice(string Kind, string Text, string LinkUrl, string LinkLabel, IReadOnlyList<string>? Actions)
{
    public static SupportNotice Distress { get; } =
        new("distress", DiscoverText.DistressText, DiscoverText.SupportLinkUrl, DiscoverText.SupportLinkLabel, DiscoverText.DistressActions);

    public static SupportNotice ReadFailure { get; } =
        new("support", DiscoverText.ReadFailureSupportNote, DiscoverText.SupportLinkUrl, DiscoverText.SupportLinkLabel, null);
}

/// <summary>答えを送る API の本文。<c>kind</c> は "free"（自由に書いた）か "choice"（選んだ）。</summary>
public sealed record MessageRequest(string? Text, string? Kind);

/// <summary>
/// 1 往復の流れ。読み取り → 次の一手 → 返事 → 保存 を順に行い、画面へ SSE のイベントで少しずつ送る。
/// イベント: delta（本文のかけら）、choices（選択肢）、notice（相談窓口）、done（終わりの知らせ）、error（失敗・拒否）。
/// 利用者の答えと返事は、返事を最後まで受け取れたときだけ保存する。
/// ログには話した内容も AI の返事も書かない。書くのは、エラーの種類だけ。
/// </summary>
public sealed class TalkStream(IConversationAi ai, IDataStore store, TimeProvider time, ILogger<TalkStream> logger)
{
    /// <summary>1 つの答えの長さの上限（文字。絵文字などの合成された文字は 1 文字と数える）。</summary>
    public const int MaxAnswerLength = 2000;

    public const string DeltaEvent = "delta";
    public const string ChoicesEvent = "choices";
    public const string NoticeEvent = "notice";
    public const string DoneEvent = "done";
    public const string ErrorEvent = "error";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>答えの本文を確かめ、答え方を読む。受け取れない答えなら null。</summary>
    public static (string Text, AnswerKind Kind)? Validate(MessageRequest? request)
    {
        var text = request?.Text?.Trim();
        if (string.IsNullOrEmpty(text) || new StringInfo(text).LengthInTextElements > MaxAnswerLength)
        {
            return null;
        }

        AnswerKind? kind = request!.Kind switch
        {
            "free" => AnswerKind.Free,
            "choice" => AnswerKind.Choice,
            _ => null,
        };
        return kind is { } k ? (text, k) : null;
    }

    /// <summary>一手の名前（保存と done イベントに使う）。例: AskWhatYouDid → askWhatYouDid。</summary>
    public static string MoveName(MoveKind move) => JsonNamingPolicy.CamelCase.ConvertName(move.ToString());

    public async IAsyncEnumerable<SseItem<string>> RunAsync(
        EpisodeItem episode, string text, AnswerKind kind, [EnumeratorCancellation] CancellationToken ct)
    {
        var answer = new Turn { Role = TurnRoles.User, Text = text, AnswerKind = kind, At = time.GetUtcNow() };
        IReadOnlyList<Turn> turns = [.. episode.Turns, answer];
        var userTurnNumber = episode.UserTurnCount + 1;

        // 1. 読み取り。失敗したら、つらい状態のサインを見落としているかもしれないので、窓口を添える
        TurnReading? reading = null;
        string? readError = null;
        try
        {
            reading = await ai.ReadAsync(turns, ct);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            readError = KindOf(e);
        }

        if (reading is null)
        {
            yield return Event(NoticeEvent, SupportNotice.ReadFailure);
            yield return Error(readError!);
            yield break;
        }

        // 2. 次の一手
        var move = NextMovePolicy.Decide(reading, userTurnNumber);

        // つらい状態のサインには AI の返事を使わず、決まった言葉と窓口で応える
        if (move == MoveKind.Distress)
        {
            var distressTurn = new Turn { Role = TurnRoles.Assistant, Text = DiscoverText.DistressText, Move = MoveName(move), At = time.GetUtcNow() };
            var saved = await SaveAsync(episode, answer, distressTurn, finish: false, excluded: true, ct);
            if (saved is null)
            {
                yield return Error(ConversationAiException.Failure);
                yield break;
            }

            yield return Event(NoticeEvent, SupportNotice.Distress);
            yield return Done(saved, move);
            yield break;
        }

        // 3. 返事。本文だけを流し、選択肢は最後にまとめて送る
        var splitter = new ReplyStreamSplitter();
        var reply = ai.StreamReplyAsync(turns, move, ct).GetAsyncEnumerator(ct);
        string? replyError = null;
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
                    replyError = KindOf(e);
                    break;
                }

                foreach (var piece in splitter.Push(chunk))
                {
                    yield return Delta(piece);
                }
            }
        }

        if (replyError is not null)
        {
            yield return Error(replyError);
            yield break;
        }

        var close = move == MoveKind.Close;
        var parts = splitter.Complete(expectChoices: !close);
        if (parts.Tail.Length > 0)
        {
            yield return Delta(parts.Tail);
        }

        // 本文のない返事は保存しない（受け止めの言葉がないまま場面が進まないように。Claude の判断）
        if (parts.Body.Length == 0)
        {
            logger.LogWarning("Reply had no body for move {Move}.", move);
            yield return Error(ConversationAiException.Failure);
            yield break;
        }

        // 4. 保存。返事を最後まで受け取れたときだけ、答えと返事の 2 ターンを足す
        var replyTurn = new Turn
        {
            Role = TurnRoles.Assistant,
            Text = parts.Body,
            Choices = close ? null : parts.Choices,
            Move = MoveName(move),
            At = time.GetUtcNow(),
        };
        var result = await SaveAsync(episode, answer, replyTurn, finish: close, excluded: false, ct);
        if (result is null)
        {
            yield return Error(ConversationAiException.Failure);
            yield break;
        }

        if (!close)
        {
            yield return Event(ChoicesEvent, new { choices = parts.Choices });
        }

        yield return Done(result, move);
    }

    /// <summary>
    /// 2 ターンを足して保存する。返事を流しているあいだや保存する直前に、場面が飛ばされた・区切られた・ほかの答えが入ったときは、
    /// 消した中身を作り直したり、やりとりを上書きしたりしないよう、保存せずに null を返す（Claude の判断）。
    /// 確かめてから書くまでを、版（ETag）が合うときだけ置き換える操作で一続きにする。
    /// </summary>
    private async Task<EpisodeItem?> SaveAsync(EpisodeItem episode, Turn answer, Turn reply, bool finish, bool excluded, CancellationToken ct)
    {
        try
        {
            var updated = await store.TryUpdateAsync<EpisodeItem>(episode.UserKey, episode.Id, current =>
                current.Status != EpisodeStatus.Talking || current.Turns.Count != episode.Turns.Count
                    ? null
                    : current with
                    {
                        Turns = [.. current.Turns, answer, reply],
                        Status = finish ? EpisodeStatus.Finished : current.Status,
                        FinishedAt = finish ? time.GetUtcNow() : current.FinishedAt,
                        ExcludedFromValidation = current.ExcludedFromValidation || excluded,
                    }, ct);
            if (updated is null)
            {
                logger.LogWarning("Episode changed while replying. The answer was not saved.");
            }

            return updated;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // 全部消したあと（了解の記録がない）なども、ここに来る。中身は書かず、種類だけ
            logger.LogWarning("Saving the episode failed: {ErrorType}.", e.GetType().Name);
            return null;
        }
    }

    /// <summary>AI の呼び出しの失敗を、画面に知らせる種類にする。思いがけない例外は不調として扱う。</summary>
    private string KindOf(Exception e)
    {
        if (e is ConversationAiException ai)
        {
            return ai.Kind;
        }

        logger.LogWarning("Conversation AI threw {ErrorType}.", e.GetType().Name);
        return ConversationAiException.Failure;
    }

    private static SseItem<string> Delta(string text) => Event(DeltaEvent, new { text });

    private static SseItem<string> Error(string kind) => Event(ErrorEvent, new { kind });

    private static SseItem<string> Done(EpisodeItem episode, MoveKind move) =>
        Event(DoneEvent, new { userTurnCount = episode.UserTurnCount, status = episode.Status, move = MoveName(move) });

    private static SseItem<string> Event<T>(string name, T data) => new(JsonSerializer.Serialize(data, Json), name);
}
