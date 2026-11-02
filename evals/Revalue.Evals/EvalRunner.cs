using System.Diagnostics;
using Revalue.Server.Ai;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Validate;

namespace Revalue.Evals;

/// <summary>1 往復の記録。</summary>
/// <param name="Answer">送った答え（[選択] の行では、選んだ選択肢の文）。</param>
/// <param name="Target">足りない行動を聞く一手のとき、聞いた行動。</param>
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
    JudgeVerdict? Verdict,
    ActionRef? Target = null);

/// <summary>訂正 1 回の記録。</summary>
/// <param name="Distress">訂正につらい状態のサインがあり、決まった言葉と相談窓口を出した（根拠は変えない）。</param>
public sealed record CorrectionRecord(string Text, IReadOnlySet<AnswerSignal> Signals, bool Distress);

/// <summary>エピソード 1 件を流した記録。</summary>
/// <param name="SupportShown">相談窓口を出したか（サインへの決まった言葉か、読み取りの失敗に添える窓口）。</param>
/// <param name="Error">AI が失敗・拒否して途中で終えたとき、その説明。</param>
public sealed record EpisodeRun(EpisodeScript Script, IReadOnlyList<ReplyRecord> Replies, bool SupportShown, string? Error)
{
    /// <summary>場面の最後のやりとり（最初の問い、答え、返事、訂正）。</summary>
    public IReadOnlyList<Turn> Turns { get; init; } = [];

    /// <summary>場面を最後まで流したあとの、力ごとの状態（<see cref="AbilityStates.Evaluate"/> の結果）。</summary>
    public IReadOnlyList<AbilityResult> Final { get; init; } = AbilityStates.Evaluate([]);

    /// <summary>最初の訂正の直前の状態。訂正のない例では null。</summary>
    public IReadOnlyList<AbilityResult>? BeforeCorrection { get; init; }

    public IReadOnlyList<CorrectionRecord> Corrections { get; init; } = [];

    /// <summary>読み取り（1 往復と訂正の読み直し）が返した根拠の候補の数。</summary>
    public int Candidates { get; init; }

    /// <summary>
    /// そのうち、引用か結びつく言葉が短すぎた候補の数（<see cref="EvidenceChecker.IsTooShort"/>。照らし合わせで捨てる）。
    /// 読み取りの指示を直す手がかりにする。
    /// </summary>
    public int ShortCandidates { get; init; }

    /// <summary>同じやりとりを汎用の AI に渡した結果。比べないときは null。</summary>
    public GenericResult? Generic { get; init; }
}

/// <summary>
/// 台本どおりに会話を流す。1 往復の中身（読み取り → 次の一手 → 返事 → 本文と選択肢に分ける、失敗の扱い）は、
/// 製品と同じ <see cref="TalkRound"/> を呼ぶ。訂正は、製品と同じ <see cref="CorrectionRound"/> を呼ぶ。
/// ここで持つのは、台本の読み方、記録、判定役の呼び出しだけ。保存はしない。
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
        IReadOnlyList<Evidence> evidence = [];
        var supportShown = false;
        string? error = null;
        var candidates = 0;
        var shortCandidates = 0;

        var stopped = false;
        foreach (var answer in script.Answers.Where(a => !a.IsCorrection))
        {
            var userTurnNumber = replies.Count + 1;
            if (userTurnNumber > NextMovePolicy.MaxUserTurns)
            {
                break;
            }

            string text;
            if (answer.IsChoice)
            {
                if (answer.Text.Length > 0)
                {
                    text = answer.Text;
                }
                else if (turns[^1].Choices is { Count: > 0 } choices)
                {
                    text = choices[0];
                }
                else
                {
                    error = "選択肢のない返事のあとに [選択] の行がある";
                    stopped = true;
                    break;
                }
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
            var context = new RoundContext(conversation, evidence, userTurnNumber, NextMovePolicy.MaxUserTurns);
            await foreach (var step in TalkRound.RunAsync(ai, context, TimeProvider.System, ct))
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

            if (decided?.Reading.Candidates is { } found)
            {
                candidates += found.Count;
                shortCandidates += found.Count(EvidenceChecker.IsTooShort);
            }

            if (failed is not null || decided is null || replied is null)
            {
                // 製品で窓口を添える失敗（読み取りの失敗、返事を AI が断った）なら、窓口を出したと数える
                supportShown |= failed?.AddSupport ?? false;
                error = Describe(failed);
                stopped = true;
                break;
            }

            var move = decided.Move.Kind;
            var reply = replied.Reply;
            firstTextMs ??= watch.ElapsedMilliseconds;
            if (move == MoveKind.Distress)
            {
                supportShown = true;
                replies.Add(new ReplyRecord(
                    text, answer.IsChoice, decided.Reading.Signals, move, reply.Text, [], false, firstTextMs.Value, 0,
                    forbidden.Find(reply.Text), null));
                stopped = true;
                break;
            }

            IReadOnlyList<string> choicesShown = reply.Choices ?? [];
            var target = decided.Move.Target;
            var hint = move == MoveKind.AskMissingAction && target is not null ? AbilityText.Hint(target) : null;
            var verdict = await judge.JudgeAsync(conversation, move, hint, reply.Text, choicesShown, ct);
            replies.Add(new ReplyRecord(
                text, answer.IsChoice, decided.Reading.Signals, move, reply.Text, choicesShown, replied.UsedFallbackChoices, firstTextMs.Value,
                ReplyChecks.CountQuestions(reply.Text), forbidden.Find(string.Join("\n", [reply.Text, .. choicesShown])), verdict, target));

            turns.Add(userTurn);
            turns.Add(reply);
            evidence = decided.Evidence;
            if (move == MoveKind.Close)
            {
                break;
            }
        }

        // 訂正: 話し終えた場面に送り、場面全体を読み直した根拠で置き換える（製品の /api/episodes/{id}/corrections と同じ）
        IReadOnlyList<AbilityResult>? beforeCorrection = null;
        var corrections = new List<CorrectionRecord>();
        foreach (var answer in script.Answers.Where(a => a.IsCorrection && !stopped))
        {
            beforeCorrection ??= AbilityStates.Evaluate(evidence);
            var correction = new Turn { Role = TurnRoles.User, Text = answer.Text, AnswerKind = AnswerKind.Correction, At = now };
            var outcome = await CorrectionRound.RunAsync(ai, [.. turns, correction], ct);
            if (outcome.ErrorKind is not null || outcome.Reading is null)
            {
                error = $"訂正の読み取りで {outcome.ErrorKind ?? ConversationAiException.Failure}";
                break;
            }

            turns.Add(correction);
            if (outcome.Reading.Candidates is { } reread)
            {
                candidates += reread.Count;
                shortCandidates += reread.Count(EvidenceChecker.IsTooShort);
            }

            if (outcome.Reading.Has(AnswerSignal.Distress))
            {
                // サインなら、決まった言葉と相談窓口を出し、根拠は変えない
                supportShown = true;
                corrections.Add(new CorrectionRecord(answer.Text, outcome.Reading.Signals, Distress: true));
                turns.Add(new Turn { Role = TurnRoles.Assistant, Text = DiscoverText.DistressText, Move = TalkStream.MoveName(MoveKind.Distress), At = now });
                break;
            }

            corrections.Add(new CorrectionRecord(answer.Text, outcome.Reading.Signals, Distress: false));
            evidence = outcome.Evidence;
        }

        return new EpisodeRun(script, replies, supportShown, error)
        {
            Turns = turns,
            Final = AbilityStates.Evaluate(evidence),
            BeforeCorrection = beforeCorrection,
            Corrections = corrections,
            Candidates = candidates,
            ShortCandidates = shortCandidates,
        };
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
