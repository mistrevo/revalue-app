using System.Text.Json.Serialization;
using Revalue.Server.Data;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Options;

/// <summary>本人が考えて書いた仕事。<paramref name="Note"/> は書いていなければ null。</summary>
public sealed record OwnJob(string Id, string Title, string? Note, DateTimeOffset CreatedAt)
{
    /// <summary>書ける数（Claude の判断）。</summary>
    public const int MaxOwnJobs = 3;

    /// <summary>名前の長さの上限（見た目の文字）。</summary>
    public const int MaxTitleLength = 100;

    /// <summary>メモの長さの上限（見た目の文字）。</summary>
    public const int MaxNoteLength = 500;
}

/// <summary>選んだ案の種類。カード、本人が書いた仕事、保留。</summary>
[JsonConverter(typeof(NamedEnumConverter<ChoiceKind>))]
public enum ChoiceKind
{
    [JsonStringEnumMemberName("card")]
    Card,

    [JsonStringEnumMemberName("own")]
    Own,

    [JsonStringEnumMemberName("hold")]
    Hold,
}

/// <summary>
/// 選んだ案。カードを選んだときは、そのときのカードの中身を写して残す（作り直しても変わらない）。
/// 本人が書いた仕事を選んだときは、その id を持つ。
/// </summary>
public sealed record OptionChoice(
    ChoiceKind Kind,
    DateTimeOffset At,
    CardKind? Card,
    ChooseCard? Choose,
    CombineCard? Combine,
    CreateCard? Create,
    string? OwnJobId)
{
    /// <summary>
    /// 選んだカードの元になった場面を本人が飛ばして、理由と根拠の言葉を写しから消したか（<see cref="OptionsScrub"/>）。
    /// 飛ばした場面の中身は残さないので、戻ることはない（discover-5（つらい話は飛ばせる））。
    /// </summary>
    public bool SourceRemoved { get; init; }

    /// <summary>選んだカードの理由に使った力。カードを選んでいなければ null。</summary>
    public CardAbility? ChosenAbility() => Choose?.Ability ?? Combine?.Ability ?? Create?.Ability;

    /// <summary>
    /// 選んだカードの理由と、もとにした力と根拠の言葉を、いまの記録では使えないときの理由。使えるなら null（カードを選んでいなければ null）。
    /// 本人があとで力を外したら <see cref="MissingReason.Excluded"/>、力の状態か根拠の言葉がいまの記録と合わなくなったら
    /// <see cref="MissingReason.Changed"/>（<see cref="CardAbility.ProblemIn"/>）。どちらのときも、選んだ案の中身（職種や業務、時間、場所、
    /// 事業のアイデア）は残し、理由と、もとにした力と根拠の言葉は使わない。元の場面を飛ばしたとき（<see cref="SourceRemoved"/>）と、
    /// 「選ぶ」「組み合わせる」の業務がいまの業務マスターでカードの力を使わなくなったとき（<see cref="TasksDropAbility"/>）も
    /// <see cref="MissingReason.Changed"/>。06 deepen と 07 report も同じ
    /// （05-options.md の「本人が選ぶ」。戻ればまた使う）。
    /// </summary>
    public MissingReason? AbilityProblem(OptionsInputs inputs, JobCatalog catalog) =>
        ChosenAbility() is not { } ability ? null
        : SourceRemoved ? MissingReason.Changed
        : ability.ProblemIn(inputs) ?? (TasksDropAbility(ability, catalog) ? MissingReason.Changed : null);

    /// <summary>
    /// 選んだ「選ぶ」「組み合わせる」の業務がどれも業務マスターにあり、どの業務もカードの力を使わなくなったか。業務マスターを置き換える前に選んだ案で、
    /// 理由が業務とかけ離れたまま出ないため（Claude の判断）。業務が業務マスターにないときは、確かめられないので false。
    /// 話から確かめる力でないカードの力は、もともと理由を出さないので false。
    /// </summary>
    private bool TasksDropAbility(CardAbility ability, JobCatalog catalog)
    {
        if (!AbilityCatalog.IsActive(ability.Ability) || (Choose?.Tasks ?? Combine?.Tasks) is not { Count: > 0 } cardTasks)
        {
            return false;
        }

        var tasks = cardTasks.Select(t => catalog.FindTask(t.TaskId)).ToList();
        return tasks.All(t => t is not null) && !tasks.Any(t => t!.Uses(ability.Ability));
    }
}

/// <summary>利用者ごとに 1 件（id は固定）の、仕事のカード、本人が書いた仕事、選んだ案。</summary>
public sealed record OptionsItem : Item
{
    public const string ItemId = "options";
    public const string ItemType = "options";

    public OptionCards? Cards { get; init; }

    public IReadOnlyList<OwnJob> OwnJobs { get; init; } = [];

    public OptionChoice? Choice { get; init; }

    /// <summary>
    /// 最後に AI が失敗したか断ったときの、元の記録の指紋。同じ記録のあいだは、画面を開いたときに自動で作り直さない
    /// （05-options.md の「作り直す」。開くたびに送信回数を使わないため）。作れたら null に戻す。
    /// </summary>
    public string? FailedBasis { get; init; }

    public DateTimeOffset UpdatedAt { get; init; }
}

/// <summary>仕事の選択肢を、読んだときから変わっていないときだけ書いて置き換える。</summary>
public static class OptionsStore
{
    /// <summary>
    /// 読んで、<paramref name="apply"/> で変えて、作るか ETag つきで置き換える。ほかの要求が先に書いていたら、読み直してやり直す。
    /// <paramref name="apply"/> が例外を投げたら、何も書かずにそのまま投げる。
    /// </summary>
    public static async Task<OptionsItem> UpdateAsync(
        IDataStore store, string userKey, Func<OptionsItem, OptionsItem> apply, TimeProvider time, CancellationToken ct)
    {
        for (var attempt = 0; attempt < DataStoreExtensions.MaxUpdateAttempts; attempt++)
        {
            var read = await store.GetVersionedAsync<OptionsItem>(userKey, OptionsItem.ItemId, ct);
            var next = apply(read?.Item ?? new OptionsItem { Id = OptionsItem.ItemId, UserKey = userKey, Type = OptionsItem.ItemType })
                with { UpdatedAt = time.GetUtcNow() };
            var written = read is null
                ? await store.TryCreateAsync(next, ct)
                : await store.TryReplaceAsync(next, read.ETag, ct);
            if (written)
            {
                return next;
            }
        }

        throw new InvalidOperationException($"Could not update the options after {DataStoreExtensions.MaxUpdateAttempts} attempts.");
    }
}
