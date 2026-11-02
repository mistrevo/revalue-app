using System.Globalization;
using System.Net.ServerSentEvents;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using Revalue.Server.Ai;
using Revalue.Server.Data;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Discover;

/// <summary>
/// 相談窓口の知らせ。<c>kind</c> は "distress"（つらい状態のサインへの応え）か
/// "support"（読み取りに失敗したとき、返事を AI が断ったときに、念のため添える）。
/// </summary>
public sealed record SupportNotice(string Kind, string Text, string LinkUrl, string LinkLabel, IReadOnlyList<string>? Actions)
{
    public static SupportNotice Distress { get; } =
        new("distress", DiscoverText.DistressText, DiscoverText.SupportLinkUrl, DiscoverText.SupportLinkLabel, DiscoverText.DistressActions);

    public static SupportNotice Precaution { get; } =
        new("support", DiscoverText.PrecautionSupportNote, DiscoverText.SupportLinkUrl, DiscoverText.SupportLinkLabel, null);
}

/// <summary>答えを送る API の本文。<c>kind</c> は "free"（自由に書いた）か "choice"（選んだ）。</summary>
public sealed record MessageRequest(string? Text, string? Kind);

/// <summary>
/// 1 往復の流れ。読み取り → 根拠の照らし合わせ → 次の一手 → 返事（<see cref="TalkRound"/>）→ 保存 を順に行い、画面へ SSE のイベントで少しずつ送る。
/// イベント: delta（本文のかけら）、choices（選択肢）、notice（相談窓口）、done（終わりの知らせ）、error（失敗・拒否）。
/// 利用者の答えと返事と根拠は、返事を最後まで受け取れたときだけ保存する。
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

    /// <summary>error イベントの種類。返事を流しているあいだに、場面がほかの画面で飛ばされた・区切られた・消された。</summary>
    public const string ClosedError = "closed";

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
        var move = MoveKind.AskWhatYouDid;
        IReadOnlyList<Evidence> evidence = episode.Evidence;

        // 読み取り → 根拠の照らし合わせ → 次の一手 → 返事 は TalkRound（評価と同じ処理）。ここでは、起きたことを SSE に変え、保存する
        var context = new RoundContext(turns, episode.Evidence, episode.UserTurnCount + 1, episode.TurnLimit);
        await foreach (var step in TalkRound.RunAsync(ai, context, time, ct))
        {
            switch (step)
            {
                case RoundStep.Decided decided:
                    move = decided.Move.Kind;
                    evidence = decided.Evidence;
                    break;

                case RoundStep.Text piece:
                    yield return Delta(piece.Piece);
                    break;

                case RoundStep.Failed failed:
                {
                    if (failed.UnexpectedError is { } errorType)
                    {
                        logger.LogWarning("Conversation AI threw {ErrorType}.", errorType);
                    }

                    if (failed.EmptyBody)
                    {
                        logger.LogWarning("Reply had no body for move {Move}.", move);
                    }

                    if (failed.AddSupport)
                    {
                        yield return Event(NoticeEvent, SupportNotice.Precaution);
                    }

                    yield return Error(failed.Kind);
                    yield break;
                }

                case RoundStep.Replied replied:
                {
                    // 返事を最後まで受け取れたときだけ、答えと返事の 2 ターンと根拠を足す。
                    // つらい状態のサインが出た場面には、力の確かめに使わない印を付け、根拠は足さない
                    var distress = move == MoveKind.Distress;
                    var close = move == MoveKind.Close;
                    var saved = await SaveAsync(episode, answer, replied.Reply, distress ? null : evidence, finish: close, excluded: distress, ct);
                    if (saved is null)
                    {
                        // サインを読み取った往復は、保存できなくても窓口を添える（discover-10）
                        if (distress)
                        {
                            yield return Event(NoticeEvent, SupportNotice.Precaution);
                        }

                        yield return Error(await WhyNotSavedAsync(episode, ct));
                        yield break;
                    }

                    if (distress)
                    {
                        yield return Event(NoticeEvent, SupportNotice.Distress);
                    }
                    else if (!close)
                    {
                        yield return Event(ChoicesEvent, new { choices = replied.Reply.Choices });
                    }

                    yield return Done(saved, move);
                    yield break;
                }
            }
        }
    }

    /// <summary>
    /// 2 ターンを足して保存する。返事を流しているあいだや保存する直前に、場面が飛ばされた・区切られた・ほかの答えが入ったときは、
    /// 消した中身を作り直したり、やりとりを上書きしたりしないよう、保存せずに null を返す（Claude の判断）。
    /// 確かめてから書くまでを、版（ETag）が合うときだけ置き換える操作で一続きにする。
    /// </summary>
    /// <param name="evidence">保存する根拠（前の根拠に新しいものを足したもの）。null なら場面の根拠を変えない。</param>
    private async Task<EpisodeItem?> SaveAsync(
        EpisodeItem episode, Turn answer, Turn reply, IReadOnlyList<Evidence>? evidence, bool finish, bool excluded, CancellationToken ct)
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
                        Evidence = evidence ?? current.Evidence,
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

    /// <summary>
    /// 保存できなかった理由を、画面に知らせる種類にする。場面がもうない、または話している途中でなくなっていれば
    /// <see cref="ClosedError"/>（ほかの画面で閉じられた）、それ以外は <see cref="ConversationAiException.Failure"/>。
    /// </summary>
    private async Task<string> WhyNotSavedAsync(EpisodeItem episode, CancellationToken ct)
    {
        try
        {
            var current = await store.GetAsync<EpisodeItem>(episode.UserKey, episode.Id, ct);
            return current is null || current.Status != EpisodeStatus.Talking ? ClosedError : ConversationAiException.Failure;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogWarning("Reading the episode after a failed save failed: {ErrorType}.", e.GetType().Name);
            return ConversationAiException.Failure;
        }
    }

    private static SseItem<string> Delta(string text) => Event(DeltaEvent, new { text });

    private static SseItem<string> Error(string kind) => Event(ErrorEvent, new { kind });

    private static SseItem<string> Done(EpisodeItem episode, MoveKind move) =>
        Event(DoneEvent, new { userTurnCount = episode.UserTurnCount, status = episode.Status, move = MoveName(move) });

    private static SseItem<string> Event<T>(string name, T data) => new(JsonSerializer.Serialize(data, Json), name);
}
