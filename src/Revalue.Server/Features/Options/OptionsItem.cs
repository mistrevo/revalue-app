using System.Text.Json.Serialization;
using Revalue.Server.Data;

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
    string? OwnJobId);

/// <summary>利用者ごとに 1 件（id は固定）の、仕事のカード、本人が書いた仕事、選んだ案。</summary>
public sealed record OptionsItem : Item
{
    public const string ItemId = "options";
    public const string ItemType = "options";

    public OptionCards? Cards { get; init; }

    public IReadOnlyList<OwnJob> OwnJobs { get; init; } = [];

    public OptionChoice? Choice { get; init; }

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
