using Revalue.Server.Ai;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Discover;

/// <summary>次の一手。コードが決め、AI には決まった一手だけを言葉にさせる。</summary>
public enum MoveKind
{
    /// <summary>その出来事の中で本人がしたことを、一つ聞く。</summary>
    AskWhatYouDid,

    /// <summary>一般論を受け止めて、その中の具体的な出来事を一つ聞く。</summary>
    AskConcreteEvent,

    /// <summary>「分からない」「何もない」を答えとして受け止め、答えやすい具体的な場面を一つ聞く。</summary>
    AskEasierScene,

    /// <summary>病気の詳しいことは聞かず、本人がしたことに話を戻す。</summary>
    ReturnFromIllness,

    /// <summary>つらい状態のサイン。AI の返事は使わず、コードが決めた言葉と相談窓口を出す。</summary>
    Distress,

    /// <summary>往復の上限。受け止めて映し返し、問いを出さずに場面を締める。</summary>
    Close,

    /// <summary>いまの出来事の中で、要確認の力の足りない行動を一つ聞く（03-validate.md）。聞き手には手がかりだけを渡す。</summary>
    AskMissingAction,

    /// <summary>
    /// 続きの問いに「その日のほかのことを話したい」を選んだ人に、同じ日のほかの時間や出来事を一つ聞く（03-validate.md の「続きを話す」）。
    /// 前の出来事の行動は聞き直さない。選んだ答えには映し返す行動がないので、映し返さない。
    /// </summary>
    AskOtherPartOfDay,
}

/// <summary>次の一手。<see cref="Target"/> は <see cref="MoveKind.AskMissingAction"/> のときだけ、聞く行動。</summary>
public sealed record NextMove(MoveKind Kind, ActionRef? Target = null);

/// <summary>
/// 足りない行動を聞くかを決めるための、場面の確かめの文脈。
/// </summary>
/// <param name="Evidence">この場面のここまでの根拠（いまの答えの読み取りで見つかったものも含む）。</param>
/// <param name="LatestAnswer">いまの答えが何番目の本人の答えか（1 から）。</param>
/// <param name="AskedCounts">
/// この場面で、行動ごとに聞いた回数。訂正で打ち消された行動と、続きの問いに「とくに思い当たりません」を選んだ行動は、
/// 上限（<see cref="NextMovePolicy.MaxAskPerAction"/>）として数える。
/// </param>
/// <param name="WantsOtherThings">いまの答えが、続きの問いに「その日のほかのことを話したい」を選んだものか。</param>
/// <param name="Focus">
/// この場面で聞き返す力（revisit-4（いまの話を聞き切る））。いちばん新しく行動を添えた聞き手のターン（足りない行動を聞く一手と、続きの問い）の力。
/// まだ行動を添えて聞いていない場面では null。
/// </param>
public sealed record ValidationContext(
    IReadOnlyList<Evidence> Evidence,
    int LatestAnswer,
    IReadOnlyDictionary<ActionRef, int> AskedCounts,
    bool WantsOtherThings = false,
    Ability? Focus = null)
{
    /// <summary>
    /// ターンから文脈を作る。聞いた回数は、行動を添えた聞き手のターン（足りない行動を聞く一手と、続きを話すときの問い）から数える。
    /// そのうちいちばん新しいターンの力を、この場面で聞き返す力（<see cref="Focus"/>）にする。
    /// 続きの問いも同じ行動を聞いているので数に入れる（問い詰めないため。Claude の判断）。
    /// 訂正で打ち消された行動（訂正のターンの <see cref="Turn.Withdrawn"/>）は、本人がもう答えたので、聞いた回数の上限に届いたものとして数える（Claude の判断）。
    /// 続きの問いへの答えに、決まった選択肢を選んだときは次のように扱う（03-validate.md の「続きを話す」。Claude の判断）。
    /// 選んだ答え（<see cref="AnswerKind.Choice"/>）で、直前の聞き手のターンが続きの問いのときだけ働き、同じ言葉を書いた答えでは働かない。
    /// 「とくに思い当たりません」なら、その問いで聞いた行動を上限に届いたものとして数える。
    /// 「その日のほかのことを話したい」がいまの答えなら、<see cref="WantsOtherThings"/> を立てる。
    /// </summary>
    public static ValidationContext From(IReadOnlyList<Turn> turns, IReadOnlyList<Evidence> evidence)
    {
        var asked = new Dictionary<ActionRef, int>();
        Ability? focus = null;
        foreach (var turn in turns)
        {
            if (turn.Role == TurnRoles.Assistant && ActionRef.Parse(turn.Target) is { } target)
            {
                asked[target] = asked.GetValueOrDefault(target) + 1;
                focus = target.Ability;
            }
        }

        foreach (var withdrawn in CorrectionRound.WithdrawnIn(turns))
        {
            asked[withdrawn] = Math.Max(asked.GetValueOrDefault(withdrawn), NextMovePolicy.MaxAskPerAction);
        }

        var wantsOtherThings = false;
        for (var i = 1; i < turns.Count; i++)
        {
            if (ResumeChoiceAnswer(turns[i - 1], turns[i]) is not { } choice)
            {
                continue;
            }

            if (choice == AbilityText.ResumeChoiceNone && ActionRef.Parse(turns[i - 1].Target) is { } declined)
            {
                asked[declined] = Math.Max(asked.GetValueOrDefault(declined), NextMovePolicy.MaxAskPerAction);
            }

            if (choice == AbilityText.ResumeChoiceOtherThings && i == turns.Count - 1)
            {
                wantsOtherThings = true;
            }
        }

        return new ValidationContext(evidence, turns.Count(t => t.Role == TurnRoles.User), asked, wantsOtherThings, focus);
    }

    /// <summary>
    /// 続きの問い（<paramref name="question"/>）に、続きの決まった選択肢を選んで答えた（<paramref name="answer"/>）ならその言葉。ほかは null。
    /// 言葉は <see cref="AbilityText.ResumeChoices"/> と一字一句同じかで見る。
    /// </summary>
    private static string? ResumeChoiceAnswer(Turn question, Turn answer) =>
        question is { Role: TurnRoles.Assistant, Move: EpisodeInsights.ResumeMove }
        && answer is { Role: TurnRoles.User, AnswerKind: AnswerKind.Choice }
        && AbilityText.ResumeChoices.Contains(answer.Text)
            ? answer.Text
            : null;
}

/// <summary>読み取りと往復の数と根拠から、次の一手を決める（02-discover.md と 03-validate.md の「次の一手」）。</summary>
public static class NextMovePolicy
{
    /// <summary>1 場面の往復の上限の既定。この数の答えへの返事で場面を締める。</summary>
    public const int MaxUserTurns = 8;

    /// <summary>続きを話すときに、往復の上限に足す数（Claude の判断）。</summary>
    public const int ResumeExtraTurns = 4;

    /// <summary>同じ場面で同じ行動を聞く回数の上限。問い詰めないため（Claude の判断）。</summary>
    public const int MaxAskPerAction = 2;

    /// <summary>
    /// 優先の順: つらい状態のサイン → 往復の上限の締め → 家族の病気の話 → 続きの問いに「その日のほかのことを話したい」を選んだ →
    /// 足りない行動を一つ聞く → 具体的な出来事がある →
    /// 分からない・何もない → 一般論だけ → それ以外。
    /// </summary>
    /// <param name="reading">いまの答えの読み取り。</param>
    /// <param name="userTurnNumber">いまの答えが何往復目か（1 から）。</param>
    /// <param name="validation">場面の確かめの文脈。null なら足りない行動は聞かない。</param>
    /// <param name="turnLimit">この場面の往復の上限。</param>
    public static NextMove Decide(TurnReading reading, int userTurnNumber, ValidationContext? validation = null, int turnLimit = MaxUserTurns)
    {
        var basic = Basic(reading, userTurnNumber, turnLimit);
        if (basic is MoveKind.Distress or MoveKind.Close or MoveKind.ReturnFromIllness)
        {
            return new NextMove(basic);
        }

        // 続きの問いに「その日のほかのことを話したい」を選んだ人には、足りない行動ではなく、同じ日のほかの時間や出来事を聞く（Claude の判断）
        if (validation is { WantsOtherThings: true })
        {
            return new NextMove(MoveKind.AskOtherPartOfDay);
        }

        return MissingActionToAsk(reading, validation) is { } target
            ? new NextMove(MoveKind.AskMissingAction, target)
            : new NextMove(basic);
    }

    /// <summary>02 discover（話す）の一手。足りない行動を聞かないときに使う。</summary>
    private static MoveKind Basic(TurnReading reading, int userTurnNumber, int turnLimit)
    {
        if (reading.Has(AnswerSignal.Distress))
        {
            return MoveKind.Distress;
        }

        if (userTurnNumber >= turnLimit)
        {
            return MoveKind.Close;
        }

        if (reading.Has(AnswerSignal.FamilyIllness))
        {
            return MoveKind.ReturnFromIllness;
        }

        // 具体的な出来事を話していれば、「特別なことは何も」のような言葉や一般論が添えてあっても、
        // 話してくれた行動を映し返し、その出来事の中で聞く。別の場面へ移ると、本人の話を受け取らなかったことになる（Claude の判断）
        if (reading.Has(AnswerSignal.ConcreteEvent))
        {
            return MoveKind.AskWhatYouDid;
        }

        if (reading.Has(AnswerSignal.DontKnow))
        {
            return MoveKind.AskEasierScene;
        }

        if (reading.Has(AnswerSignal.GeneralOnly))
        {
            return MoveKind.AskConcreteEvent;
        }

        return MoveKind.AskWhatYouDid;
    }

    /// <summary>
    /// 足りない行動を一つ選ぶ。いまの答えが具体的な出来事でなく、いまの答えから一般論でない根拠も見つからなければ選ばない
    /// （一般論だけには具体的な出来事を聞く（validate-10）。分からない・何もないには答えやすい場面を聞き、問い詰めない）。
    /// いまの出来事の中で行動がすべてはそろっていない力のうち、行動の多い力（同じ数なら <see cref="Ability"/> の順）の足りない行動を、
    /// <see cref="AbilityStates.AskOrder"/> の順に見て、聞いた回数が上限に届いていないもの。場面全体ですでに根拠ありの力と、
    /// そろっても見えた力に出せない力（<see cref="AbilityShowcase.CouldBeSeen"/>）は聞かない。
    /// 一度聞き返した力（<see cref="ValidationContext.Focus"/>）があれば、その場面ではその力だけを聞く。その力が根拠ありになるか、
    /// いまの出来事にその力の根拠がないか、聞ける行動がなくなったら、ほかの力の足りない行動は聞かない
    /// （revisit-4（いまの話を聞き切る）。一つの場面で力をまたいで問いを重ねず、本人の話を聞き切るため）。
    /// </summary>
    private static ActionRef? MissingActionToAsk(TurnReading reading, ValidationContext? validation)
    {
        if (validation is null)
        {
            return null;
        }

        var specific = validation.Evidence.Where(e => !e.General).ToList();
        var inLatest = specific.Where(e => e.Answer == validation.LatestAnswer).ToList();
        if (!reading.Has(AnswerSignal.ConcreteEvent) && inLatest.Count == 0)
        {
            return null;
        }

        // いまの出来事: いまの答えの根拠の出来事。なければ、いちばん新しい出来事（いちばん新しい読み取りの、番号の大きい出来事）。
        // 出来事の番号は読み取りごとに振り直されるので、読み取りと番号の組で見分ける
        var pool = inLatest.Count > 0 ? inLatest : specific;
        if (pool.Count == 0)
        {
            return null;
        }

        // 場面全体ですでに根拠ありの力は聞かない。新しい読み取りが同じ出来事の行動を落としても、本人はもう話している
        var results = AbilityStates.Evaluate(validation.Evidence);
        var confirmed = results
            .Where(r => r.State == AbilityState.Confirmed)
            .Select(r => r.Ability)
            .ToHashSet();
        if (validation.Focus is { } focused && confirmed.Contains(focused))
        {
            return null;
        }

        var currentEvent = pool.Select(e => (e.Reading, e.Event)).Max();
        var candidates = specific
            .Where(e => (e.Reading, e.Event) == currentEvent && !confirmed.Contains(e.Ability))
            .Where(e => validation.Focus is not { } only || e.Ability == only)
            .GroupBy(e => e.Ability)
            .Select(g => (Ability: g.Key, Actions: AbilityStates.Counted(g).Select(e => e.Action).ToHashSet()))
            .Where(c => c.Actions.Count < AbilityCatalog.ActionCount(c.Ability))
            // そろっても見えた力に出せない力（同じ分類で行動の多い力がそろっているなど）は聞かない。答えても本人には何も見えず、往復の上限も減るため
            .Where(c => AbilityShowcase.CouldBeSeen(c.Ability, results))
            .OrderByDescending(c => c.Actions.Count)
            .ThenBy(c => c.Ability);

        foreach (var (ability, actions) in candidates)
        {
            var missing = Enumerable.Range(1, AbilityCatalog.ActionCount(ability)).Where(n => !actions.Contains(n));
            var next = AbilityStates.AskOrder(ability, missing, validation.Evidence)
                .FirstOrDefault(a => validation.AskedCounts.GetValueOrDefault(a) < MaxAskPerAction);
            if (next is not null)
            {
                return next;
            }
        }

        return null;
    }
}
