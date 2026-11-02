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
/// 台本どおりに会話を流す。1 往復の中身（読み取り → 次の一手 → 返事 → 本文と選択肢に分ける、失敗の扱い）は、
/// 製品と同じ <see cref="TalkRound"/> を呼ぶ。ここで持つのは、台本の読み方、記録、判定役の呼び出しだけ。保存はしない。
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

            RoundStep.Decided? decided = null;
            RoundStep.Replied? replied = null;
            RoundStep.Failed? failed = null;
            long? firstTextMs = null;
            await foreach (var step in TalkRound.RunAsync(ai, conversation, userTurnNumber, TimeProvider.System, ct))
            {
                switch (step)
                {
                    case RoundStep.Decided d:
                        decided = d;
                        break;
                    case RoundStep.Text:
                        firstTextMs ??= watch.ElapsedMilliseconds;
                        break;
                    case RoundStep.Failed f:
                        failed = f;
                        break;
                    case RoundStep.Replied r:
                        replied = r;
                        break;
                }
            }

            if (failed is not null || decided is null || replied is null)
            {
                // 製品で窓口を添える失敗（読み取りの失敗、返事を AI が断った）なら、窓口を出したと数える
                supportShown |= failed?.AddSupport ?? false;
                error = Describe(failed);
                break;
            }

            var move = decided.Move;
            var reply = replied.Reply;
            firstTextMs ??= watch.ElapsedMilliseconds;
            if (move == MoveKind.Distress)
            {
                supportShown = true;
                replies.Add(new ReplyRecord(
                    text, answer.IsChoice, decided.Reading.Signals, move, reply.Text, [], false, firstTextMs.Value, 0,
                    forbidden.Find(reply.Text), null));
                break;
            }

            IReadOnlyList<string> choicesShown = reply.Choices ?? [];
            var verdict = await judge.JudgeAsync(conversation, move, reply.Text, ct);
            replies.Add(new ReplyRecord(
                text, answer.IsChoice, decided.Reading.Signals, move, reply.Text, choicesShown, replied.UsedFallbackChoices, firstTextMs.Value,
                ReplyChecks.CountQuestions(reply.Text), forbidden.Find(string.Join("\n", [reply.Text, .. choicesShown])), verdict));

            turns.Add(userTurn);
            turns.Add(reply);
            if (move == MoveKind.Close)
            {
                break;
            }
        }

        return new EpisodeRun(script, replies, supportShown, error);
    }

    private static string Describe(RoundStep.Failed? failed)
    {
        if (failed is null)
        {
            return "1 往復が最後まで進まなかった";
        }

        if (failed.EmptyBody)
        {
            return "本文のない返事";
        }

        var where = failed.InReading ? "読み取り" : "返事";
        return failed.UnexpectedError is { } type ? $"{where}で {failed.Kind}（{type}）" : $"{where}で {failed.Kind}";
    }
}
