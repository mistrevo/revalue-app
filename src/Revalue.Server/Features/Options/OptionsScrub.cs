using Revalue.Server.Data;
using Revalue.Server.Features.Discover;

namespace Revalue.Server.Features.Options;

/// <summary>
/// 本人が場面を飛ばしたあと（場面ごと消したか、続きを巻き戻した）、仕事の選択肢の保存に、消えた本人の言葉を残さない
/// （discover-5（つらい話は飛ばせる）と 05-options.md の「作り直す」）。カードは根拠の言葉ごと保存し、選んだ案はその写しを持つため。
/// 根拠の言葉が、残っている場面の本人の答えのどこにもなければ、消えた言葉と見なす。
/// </summary>
public static class OptionsScrub
{
    /// <summary>
    /// 消えた言葉を持つカードを捨て、選んだ案からは理由と根拠の言葉を消す。失敗しても、飛ばすのは成功のまま（力の状態の書き直しと同じ）。
    /// </summary>
    public static async Task TryAfterRemovingAsync(IDataStore store, string userKey, TimeProvider time, ILogger logger, CancellationToken ct)
    {
        try
        {
            if (await store.GetAsync<OptionsItem>(userKey, OptionsItem.ItemId, ct) is not { } item)
            {
                return;
            }

            var episodes = await store.ListByTypeAsync<EpisodeItem>(userKey, EpisodeItem.ItemType, ct);
            var answers = episodes.SelectMany(e => e.Turns).Where(t => t.Role == TurnRoles.User).Select(t => t.Text).ToList();
            if (ReferenceEquals(Scrub(item, answers), item))
            {
                return;
            }

            await OptionsStore.UpdateAsync(store, userKey, current => Scrub(current, answers), time, ct);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogWarning("Removing the skipped words from the options failed with {ErrorType}.", e.GetType().Name);
        }
    }

    /// <summary>
    /// <paramref name="answers"/>（残っている場面の本人の答え）にない根拠の言葉を持つカードは、記録が変わったとして捨てる。
    /// 選んだカードの写しは、中身（職種や業務、時間、場所、事業のアイデア）を残し、理由と根拠の言葉を消して <see cref="OptionChoice.SourceRemoved"/> にする。
    /// 変えるものがなければ、<paramref name="item"/> をそのまま返す。
    /// </summary>
    public static OptionsItem Scrub(OptionsItem item, IReadOnlyList<string> answers)
    {
        bool Present(string? word) => string.IsNullOrWhiteSpace(word) || answers.Any(a => a.Contains(word.Trim(), StringComparison.Ordinal));
        bool Gone(CardAbility ability) => ability.Quotes.Any(q => !Present(q.Quote) || !Present(q.LinkedQuote));

        var next = item;
        if (item.Cards is { } cards)
        {
            var missing = cards.Missing.ToList();
            var dropped = false;
            T? Keep<T>(T? card, CardKind kind, Func<T, CardAbility> ability) where T : class
            {
                if (card is null || !Gone(ability(card)))
                {
                    return card;
                }

                missing.RemoveAll(m => m.Kind == kind);
                missing.Add(new MissingCard(kind, MissingReason.Changed));
                dropped = true;
                return null;
            }

            var choose = Keep(cards.Choose, CardKind.Choose, c => c.Ability);
            var combine = Keep(cards.Combine, CardKind.Combine, c => c.Ability);
            var create = Keep(cards.Create, CardKind.Create, c => c.Ability);
            if (dropped)
            {
                next = next with
                {
                    Cards = cards with { Choose = choose, Combine = combine, Create = create, Missing = missing.OrderBy(m => m.Kind).ToList() },
                };
            }
        }

        if (item.Choice is { Kind: ChoiceKind.Card, SourceRemoved: false } choice && choice.ChosenAbility() is { } chosen && Gone(chosen))
        {
            var stripped = chosen with { Quotes = [] };
            next = next with
            {
                Choice = choice with
                {
                    Choose = choice.Choose is { } c ? c with { Reason = "", Ability = stripped } : null,
                    Combine = choice.Combine is { } co ? co with { Reason = "", Ability = stripped } : null,
                    Create = choice.Create is { } cr ? cr with { Reason = "", Ability = stripped } : null,
                    SourceRemoved = true,
                },
            };
        }

        return next;
    }
}
