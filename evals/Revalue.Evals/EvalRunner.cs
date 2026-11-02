using System.Diagnostics;
using Revalue.Server.Ai;
using Revalue.Server.Features.Discover;

namespace Revalue.Evals;

/// <summary>1 往復の記録。</summary>
/// <param name="Answer">送った答え（[選択] の行では、選んだ選択肢の文）。</param>
/// <param name="Body">返事の本文。つらい状態のサインでは、決まった言葉。</param>
/// <param name="FirstTextMs">答えを送ってから、本文の最初のかけら（サインでは決まった言葉）が出るまでの時間。</param>
/// <param name="Verdict">判定役の答え。サインへの決まった言葉は判定しない。判定役が答えられなければ null。</param>
public sealed record ReplyRecord(
    string Answer,
    bool AnswerIsChoice,
    IReadOnlySet<AnswerSignal> Signals,
    MoveKind Move,
    string Body,
    IReadOnlyList<string> Choices,
    bool UsedFallback,
    long FirstTextMs,
    int Questions,
    IReadOnlyList<string> ForbiddenFound,
    JudgeVerdict? Verdict);

/// <summary>エピソード 1 件を流した記録。</summary>
/// <param name="SupportShown">相談窓口を出したか（サインへの決まった言葉か、読み取りの失敗に添える窓口）。</param>
/// <param name="Error">AI が失敗・拒否して途中で終えたとき、その説明。</param>
public sealed record EpisodeRun(EpisodeScript Script, IReadOnlyList<ReplyRecord> Replies, bool SupportShown, string? Error);

/// <summary>
/// 台本どおりに会話を流す。製品の 1 往復（TalkStream）と同じ順で、読み取り → 次の一手 → 返事 → 本文と選択肢に分ける、を行う。
/// 製品と同じ判断のコード（NextMovePolicy、ReplyStreamSplitter、DiscoverText）を使う。保存はしない。
/// </summary>
public sealed class EvalRunner(IConversationAi ai, IReplyJudge judge, ForbiddenWords forbidden)
{
    public async Task<EpisodeRun> RunAsync(EpisodeScript script, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var turns = new List<Turn>
        {
            new() { Role = TurnRoles.Assistant, Text = DiscoverText.Opening, Choices = DiscoverText.OpeningChoices, Move = "opening", At = now },
        };
        var replies = new List<ReplyRecord>();
        var supportShown = false;
        string? error = null;

        foreach (var answer in script.Answers)
        {
            var userTurnNumber = replies.Count + 1;
            if (userTurnNumber > NextMovePolicy.MaxUserTurns)
            {
                break;
            }

            string text;
            if (answer.IsChoice)
            {
                if (turns[^1].Choices is not { Count: > 0 } choices)
                {
                    error = "選択肢のない返事のあとに [選択] の行がある";
                    break;
                }

                text = choices[0];
            }
            else
            {
                text = answer.Text;
            }

            var userTurn = new Turn { Role = TurnRoles.User, Text = text, AnswerKind = answer.IsChoice ? AnswerKind.Choice : AnswerKind.Free, At = now };
            List<Turn> conversation = [.. turns, userTurn];
            var watch = Stopwatch.StartNew();

            TurnReading reading;
            try
            {
                reading = await ai.ReadAsync(conversation, ct);
            }
            catch (ConversationAiException e)
            {
                // 製品では、読み取りに失敗したら窓口を添える
                supportShown = true;
                error = $"読み取りで {e.Kind}";
                break;
            }

            var move = NextMovePolicy.Decide(reading, userTurnNumber);
            if (move == MoveKind.Distress)
            {
                supportShown = true;
                replies.Add(new ReplyRecord(
                    text, answer.IsChoice, reading.Signals, move, DiscoverText.DistressText, [], false, watch.ElapsedMilliseconds, 0,
                    forbidden.Find(DiscoverText.DistressText), null));
                break;
            }

            var splitter = new ReplyStreamSplitter();
            long? firstTextMs = null;
            try
            {
                await foreach (var chunk in ai.StreamReplyAsync(conversation, move, ct))
                {
                    if (splitter.Push(chunk).Any())
                    {
                        firstTextMs ??= watch.ElapsedMilliseconds;
                    }
                }
            }
            catch (ConversationAiException e)
            {
                error = $"返事で {e.Kind}";
                break;
            }

            var close = move == MoveKind.Close;
            var parts = splitter.Complete(expectChoices: !close);
            firstTextMs ??= watch.ElapsedMilliseconds;
            if (parts.Body.Length == 0)
            {
                error = "本文のない返事";
                break;
            }

            IReadOnlyList<string> choicesShown = close ? [] : parts.Choices;
            var verdict = await judge.JudgeAsync(conversation, move, parts.Body, ct);
            replies.Add(new ReplyRecord(
                text, answer.IsChoice, reading.Signals, move, parts.Body, choicesShown, !close && parts.UsedFallback, firstTextMs.Value,
                ReplyChecks.CountQuestions(parts.Body), forbidden.Find(string.Join("\n", [parts.Body, .. choicesShown])), verdict));

            turns.Add(userTurn);
            turns.Add(new Turn
            {
                Role = TurnRoles.Assistant, Text = parts.Body, Choices = close ? null : parts.Choices, Move = TalkStream.MoveName(move), At = now,
            });
            if (close)
            {
                break;
            }
        }

        return new EpisodeRun(script, replies, supportShown, error);
    }
}
