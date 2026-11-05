using Revalue.Server.Features.Deepen;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Ai;

/// <summary>
/// 決まった答えを返す偽物の深める AI。開発（Development）で画面を通すためと、テストのためのもの。Claude を呼ばない。
/// どの種類の案でも、どの条件でも照らし合わせを通る答えを返す（文は Claude の判断）。言い方の品質は問わない。
/// </summary>
public sealed class ScriptedDeepenAi : IDeepenAi
{
    public const string Situation = "もし、同じ日に二つの依頼が届き、どちらの相手も急いでいると言っていたら、どうしますか？";

    public static readonly IReadOnlyList<string> Choices =
        ["それぞれの相手に、いつまでに要るかを聞く", "先に届いた依頼から進める", "どちらを先にするか、まとめて相談する"];

    // 手元で動かすための偽物なので、能力辞書の置き換え先の力の id を使う
    private static readonly Ability BalancingInterests = new("balancing-interests");
    private static readonly Ability SettingPriorities = new("setting-priorities");

    public Task<DeepenDraft> DraftAsync(DeepenTarget target, OptionsInputs inputs, CancellationToken ct)
    {
        IReadOnlyList<TaskDraft> tasks = target.Drafts
            ?
            [
                new TaskDraft("予定や連絡の取りまとめ", "関わる人の予定を聞き、連絡をまとめて伝える", ActionRef.Key(BalancingInterests), "メールとカレンダーの道具"),
                new TaskDraft("頼まれたことの順番決め", "届いた頼みごとを、期限を見て並べる", ActionRef.Key(SettingPriorities), ""),
            ]
            : [];

        var ability = target.Drafts ? BalancingInterests : target.Registered.SelectMany(t => t.ActiveAbilities).DefaultIfEmpty(BalancingInterests).First();
        QuestionDraft[] questions = [new QuestionDraft(Situation, ActionRef.Key(ability), Choices)];

        var first = target.Kind == TargetKind.Create
            ? new StepDraft("身近な知り合い 2 人に、この困りごとがあるかを聞いてみる", 1, "home", true)
            : new StepDraft("この仕事について、知りたいことを 3 つ書き出してみる", 1, "home", false);
        StepDraft[] steps =
        [
            first,
            new StepDraft("この仕事をしている人の体験談を 1 つ読んでみる", 1, "home", false),
            new StepDraft("この仕事の一日の流れを、想像して書き出してみる", 1, "home", false),
        ];

        return Task.FromResult(new DeepenDraft(tasks, questions, steps));
    }
}
