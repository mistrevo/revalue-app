using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Ai;

/// <summary>
/// 決まった答えを返す偽物の仕事の選択肢の AI。開発（Development）で画面を通すためと、テストのためのもの。Claude を呼ばない。
/// 候補と使える力から、照らし合わせを通る下書きを機械的に作る。言い方の品質は問わない。
/// </summary>
public sealed class ScriptedOptionsAi : IOptionsAi
{
    /// <summary>組み合わせるの役割の名前（Claude の判断）。</summary>
    public const string RoleName = "二つの業務をつなぐ役";

    /// <summary>出せない道の下書きに入れる力。照らし合わせで使わないので、能力辞書の置き換え先の力の id を置く。</summary>
    private static readonly Ability Unavailable = new("balancing-interests");

    public Task<OptionsDraft> DraftAsync(OptionsInputs inputs, OptionCandidates candidates, CancellationToken ct) =>
        Task.FromResult(new OptionsDraft(Choose(inputs, candidates), Combine(inputs, candidates), Create(inputs)));

    private static ChooseDraft Choose(OptionsInputs inputs, OptionCandidates candidates)
    {
        if (candidates.CanChoose)
        {
            foreach (var occupation in candidates.Occupations)
            {
                var task = occupation.Tasks.FirstOrDefault(t => UsableOf(inputs, t.Ability) is not null);
                if (task is not null)
                {
                    return new ChooseDraft(true, occupation.Id, [task.Id], ActionRef.Key(task.Ability), Reason(UsableOf(inputs, task.Ability)!, task.Name));
                }
            }
        }

        return new ChooseDraft(false, "", [], ActionRef.Key(Unavailable), "");
    }

    private static CombineDraft Combine(OptionsInputs inputs, OptionCandidates candidates)
    {
        if (candidates.CanCombine && inputs.Conditions is { } conditions)
        {
            var tasks = candidates.Tasks;
            for (var i = 0; i < tasks.Count; i++)
            {
                for (var j = i + 1; j < tasks.Count; j++)
                {
                    var (a, b) = (tasks[i], tasks[j]);
                    if (Occupation(candidates, a) == Occupation(candidates, b) || !ConditionFit.CombineFits([a, b], conditions))
                    {
                        continue;
                    }

                    var used = UsableOf(inputs, a.Ability) is not null ? a : UsableOf(inputs, b.Ability) is not null ? b : null;
                    if (used is not null)
                    {
                        return new CombineDraft(true, [a.Id, b.Id], RoleName, ActionRef.Key(used.Ability), Reason(UsableOf(inputs, used.Ability)!, used.Name));
                    }
                }
            }
        }

        return new CombineDraft(false, [], "", ActionRef.Key(Unavailable), "");
    }

    private static CreateDraft Create(OptionsInputs inputs)
    {
        if (inputs.Conditions is not { } conditions || inputs.Abilities.FirstOrDefault(a => a.Quotes.Count > 0) is not { } ability)
        {
            return new CreateDraft(false, "", "", "", "", ActionRef.Key(Unavailable), [], 0, "home", [], "");
        }

        var slot = Enum.GetValues<TimeSlot>().First(conditions.TimeSlots.Contains);
        return new CreateDraft(
            true,
            "暮らしの段取りの手伝い",
            "近所の子育て中の家庭の",
            "用事や予定の段取りが重なって手が回らないこと",
            "話してくれた経験をもとに、用事や予定の段取りを一緒に整える事業のアイデアです。",
            ActionRef.Key(ability.Ability),
            [ability.Quotes[0].Quote.Trim()],
            conditions.HoursPerWeek,
            "home",
            [Key(slot)],
            Reason(ability, "この事業のアイデア"));
    }

    private static UsableAbility? UsableOf(OptionsInputs inputs, Ability ability) =>
        inputs.Abilities.FirstOrDefault(a => a.Ability == ability && a.Quotes.Count > 0);

    /// <summary>
    /// 理由。カードに添える最初の根拠の言葉だけを引く（Prompts/options.md の「理由」）。選んだ答えの言葉は、本人が話した言葉として引かず、
    /// 結びついた本人の言葉を引く。結びついた言葉がなければ、選んでくれた言葉として引く。力によらない言い方にする。
    /// </summary>
    private static string Reason(UsableAbility ability, string target)
    {
        var quote = ability.Quotes[0];
        if (!quote.FromChoice)
        {
            return $"話してくれた「{quote.Quote.Trim()}」ときの動き方を、{target}に生かせるかもしれません。";
        }

        return string.IsNullOrEmpty(quote.LinkedQuote)
            ? $"選んでくれた「{quote.Quote.Trim()}」ときの動き方を、{target}に生かせるかもしれません。"
            : $"話してくれた「{quote.LinkedQuote.Trim()}」ときの動き方を、{target}に生かせるかもしれません。";
    }

    private static string Occupation(OptionCandidates candidates, JobTask task) =>
        candidates.Occupations.First(o => o.Tasks.Any(t => t.Id == task.Id)).Id;

    private static string Key(TimeSlot slot) => slot switch
    {
        TimeSlot.Morning => "morning",
        TimeSlot.Daytime => "daytime",
        TimeSlot.Evening => "evening",
        _ => "night",
    };
}
