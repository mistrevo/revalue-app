using System.Globalization;
using System.Text;
using Revalue.Server.Data;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Foundation.Auth;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Foundation.Consent;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Profile;

/// <summary>
/// 好みかやりたいことの項目 1 つの要求。<paramref name="Source"/> がないとき、選択肢の言葉を「選んだ答え」として扱わずに断るため、
/// どちらも null を受け取れる形にしてある（保存の形は <see cref="ProfileEntry"/>）。
/// </summary>
public sealed record EntryRequest(string? Text, EntrySource? Source);

/// <summary>好みかやりたいことを置き換える要求。</summary>
public sealed record EntriesRequest(IReadOnlyList<EntryRequest?>? Entries);

/// <summary>主体性を置き換える要求。</summary>
public sealed record AgencyRequest(string? Text);

/// <summary>条件を置き換える要求。足りない項目は断るため、どれも null を受け取れる形にしてある。</summary>
public sealed record ConditionsRequest(IReadOnlyList<TimeSlot>? TimeSlots, int? HoursPerWeek, Place? Place, int? MonthlyIncome);

public sealed record QuestionDto(string Question, IReadOnlyList<string> Choices);

public sealed record QuestionsDto(QuestionDto Preferences, QuestionDto Wants);

public sealed record ConditionOptionsDto(IReadOnlyList<int> HoursPerWeek, IReadOnlyList<int> MonthlyIncome);

/// <summary>できることの 1 つ（根拠ありか要確認）。根拠の本人の言葉と、その話の id を添える。</summary>
public sealed record CanDoAbilityDto(string Key, string Name, IReadOnlyList<QuoteDto> Quotes, string? EpisodeId);

/// <summary>できること。<paramref name="HasExcluded"/> は、本人が外した力があるか（外した力そのものは出さない）。</summary>
public sealed record CanDoDto(IReadOnlyList<CanDoAbilityDto> Seen, IReadOnlyList<CanDoAbilityDto> Checking, bool HasExcluded);

/// <summary>5 つの記録の API が返すもの。</summary>
public sealed record ProfileDto(
    CanDoDto CanDo,
    IReadOnlyList<ProfileEntry> Preferences,
    IReadOnlyList<ProfileEntry> Wants,
    ProfileConditions? Conditions,
    string? Agency,
    ProfileAsked Asked,
    QuestionsDto Questions,
    ConditionOptionsDto ConditionOptions);

/// <summary>好み、やりたいこと、条件、主体性を、読んだときから変わっていないときだけ書いて置き換える。</summary>
public static class ProfileStore
{
    public static async Task<ProfileItem> UpdateAsync(
        IDataStore store, string userKey, Func<ProfileItem, ProfileItem> change, TimeProvider time, CancellationToken ct)
    {
        for (var attempt = 0; attempt < DataStoreExtensions.MaxUpdateAttempts; attempt++)
        {
            var read = await store.GetVersionedAsync<ProfileItem>(userKey, ProfileItem.ItemId, ct);
            var next = change(read?.Item ?? new ProfileItem { Id = ProfileItem.ItemId, UserKey = userKey, Type = ProfileItem.ItemType })
                with { UpdatedAt = time.GetUtcNow() };
            var written = read is null
                ? await store.TryCreateAsync(next, ct)
                : await store.TryReplaceAsync(next, read.ETag, ct);
            if (written)
            {
                return next;
            }
        }

        throw new InvalidOperationException($"Could not update the profile after {DataStoreExtensions.MaxUpdateAttempts} attempts.");
    }
}

/// <summary>/api/profile の API。AI を呼ばない（04-profile.md）。</summary>
public static class ProfileEndpoints
{
    public static void Map(RouteGroupBuilder api)
    {
        var profile = api.MapGroup("/profile").RequireConsent();

        profile.MapGet("/", async (HttpContext http, IDataStore store, CancellationToken ct) =>
        {
            var userKey = http.User.GetUserKey()!;
            var item = await store.GetAsync<ProfileItem>(userKey, ProfileItem.ItemId, ct);
            return TypedResults.Ok(await DtoAsync(store, userKey, item, ct));
        });

        profile.MapPut("/preferences", (EntriesRequest? request, HttpContext http, IDataStore store, TimeProvider time, CancellationToken ct) =>
            ReplaceEntriesAsync(request, ProfileText.PreferenceChoices, (p, e) => p with { Preferences = e, Asked = p.Asked with { Preferences = true } }, http, store, time, ct));

        profile.MapPut("/wants", (EntriesRequest? request, HttpContext http, IDataStore store, TimeProvider time, CancellationToken ct) =>
            ReplaceEntriesAsync(request, ProfileText.WantChoices, (p, e) => p with { Wants = e, Asked = p.Asked with { Wants = true } }, http, store, time, ct));

        profile.MapPut("/conditions", async (ConditionsRequest? request, HttpContext http, IDataStore store, TimeProvider time, CancellationToken ct) =>
        {
            if (CheckConditions(request) is not { } conditions)
            {
                return Invalid("The conditions are not among the choices.");
            }

            var userKey = http.User.GetUserKey()!;
            var saved = await ProfileStore.UpdateAsync(store, userKey, p => p with { Conditions = conditions }, time, ct);
            return TypedResults.Ok(await DtoAsync(store, userKey, saved, ct));
        });

        profile.MapPut("/agency", async (AgencyRequest? request, HttpContext http, IDataStore store, TimeProvider time, CancellationToken ct) =>
        {
            if (CheckAgency(request) is not { } agency)
            {
                return Invalid("The text is too long.");
            }

            var userKey = http.User.GetUserKey()!;
            var text = agency.Length == 0 ? null : agency;
            var saved = await ProfileStore.UpdateAsync(store, userKey, p => p with { Agency = text, Asked = p.Asked with { Agency = true } }, time, ct);
            return TypedResults.Ok(await DtoAsync(store, userKey, saved, ct));
        });
    }

    private static async Task<IResult> ReplaceEntriesAsync(
        EntriesRequest? request, IReadOnlyList<string> choices, Func<ProfileItem, IReadOnlyList<ProfileEntry>, ProfileItem> apply,
        HttpContext http, IDataStore store, TimeProvider time, CancellationToken ct)
    {
        if (CheckEntries(request, choices) is not { } entries)
        {
            return Invalid("The entries are empty, too many, too long, or not among the choices.");
        }

        var userKey = http.User.GetUserKey()!;
        var saved = await ProfileStore.UpdateAsync(store, userKey, p => apply(p, entries), time, ct);
        return TypedResults.Ok(await DtoAsync(store, userKey, saved, ct));
    }

    private static IResult Invalid(string title) =>
        Problems.Create(StatusCodes.Status400BadRequest, Problems.InvalidProfile, title);

    /// <summary>
    /// 項目を確かめて、前後の空白を落とし、同じ言葉を最初の 1 つにまとめる。合わなければ null。
    /// 選んだか書いたかのない項目は断る。選んだ言葉はその問いの選択肢と完全に同じ。
    /// 書いた言葉は、見える文字を含む 1〜<see cref="ProfileText.MaxEntryLength"/> 文字で、中身の長さは
    /// <see cref="ProfileText.MaxEntryUtf16Length"/> まで。
    /// </summary>
    public static IReadOnlyList<ProfileEntry>? CheckEntries(EntriesRequest? request, IReadOnlyList<string> choices)
    {
        if (request?.Entries is not { Count: <= ProfileText.MaxEntries } entries)
        {
            return null;
        }

        var kept = new List<ProfileEntry>();
        foreach (var entry in entries)
        {
            if (entry is not { Text: { } text, Source: { } source } || !Enum.IsDefined(source))
            {
                return null;
            }

            if (source == EntrySource.Chosen)
            {
                if (!choices.Contains(text))
                {
                    return null;
                }
            }
            else
            {
                text = text.Trim();
                if (!FitsIn(text, ProfileText.MaxEntryLength, ProfileText.MaxEntryUtf16Length) || !HasVisibleText(text))
                {
                    return null;
                }
            }

            if (!kept.Any(k => k.Text == text))
            {
                kept.Add(new ProfileEntry(text, source));
            }
        }

        return kept;
    }

    /// <summary>
    /// 条件を確かめる。時間帯は 1 つ以上で重ならず、時間帯の順に並べる。合わなければ null。
    /// 時間帯と場所は JSON では名前しか受け取らないが（<see cref="NamedEnumConverter{TEnum}"/>）、ここでも定義にある値かを確かめる。
    /// </summary>
    public static ProfileConditions? CheckConditions(ConditionsRequest? request)
    {
        if (request is not { TimeSlots: { Count: > 0 } slots, HoursPerWeek: { } hours, Place: { } place })
        {
            return null;
        }

        if (!slots.All(Enum.IsDefined)
            || !Enum.IsDefined(place)
            || slots.Distinct().Count() != slots.Count
            || !ProfileText.HoursPerWeekOptions.Contains(hours)
            || (request.MonthlyIncome is { } income && !ProfileText.MonthlyIncomeOptions.Contains(income)))
        {
            return null;
        }

        return new ProfileConditions([.. slots.Order()], hours, place, request.MonthlyIncome);
    }

    /// <summary>
    /// 主体性を確かめて、前後の空白を落とした言葉を返す。見える文字がなければ、書いていないことにして "" を返す。
    /// 長すぎれば（<see cref="ProfileText.MaxAgencyLength"/> 文字か、中身の長さ <see cref="ProfileText.MaxAgencyUtf16Length"/> を超える）null。
    /// </summary>
    public static string? CheckAgency(AgencyRequest? request)
    {
        if (request?.Text?.Trim() is not { } text || !FitsIn(text, ProfileText.MaxAgencyLength, ProfileText.MaxAgencyUtf16Length))
        {
            return null;
        }

        return HasVisibleText(text) ? text : "";
    }

    /// <summary>
    /// 見た目の文字数（絵文字などの合成された文字は 1 文字）と、中身の長さ（UTF-16）の両方が上限に収まるか。
    /// 結合文字を重ねた 1 文字は、見た目の文字数では数えきれないので、中身の長さでも区切る。
    /// </summary>
    internal static bool FitsIn(string text, int maxLength, int maxUtf16Length) =>
        text.Length <= maxUtf16Length && new StringInfo(text).LengthInTextElements <= maxLength;

    /// <summary>
    /// 文字、数字、句読点、記号の文字だが、画面には何も出ないもの（ハングルの埋め字、点字の空白）。
    /// 画面の側（src/web/src/lib/text.ts）と同じにする。
    /// </summary>
    private static readonly int[] BlankLooking = [0x115F, 0x1160, 0x3164, 0xFFA0, 0x2800];

    /// <summary>
    /// 見える文字（文字、数字、句読点、記号）を 1 つ以上含むか。空白、幅のない空白（U+200B）などの書式文字、制御文字、
    /// 結合文字だけの言葉は、画面で空の項目に見えるので、含まないものとして扱う。
    /// </summary>
    internal static bool HasVisibleText(string text)
    {
        foreach (var rune in text.EnumerateRunes())
        {
            if (BlankLooking.Contains(rune.Value))
            {
                continue;
            }

            switch (Rune.GetUnicodeCategory(rune))
            {
                case UnicodeCategory.UppercaseLetter or UnicodeCategory.LowercaseLetter or UnicodeCategory.TitlecaseLetter
                    or UnicodeCategory.ModifierLetter or UnicodeCategory.OtherLetter
                    or UnicodeCategory.DecimalDigitNumber or UnicodeCategory.LetterNumber or UnicodeCategory.OtherNumber
                    or UnicodeCategory.ConnectorPunctuation or UnicodeCategory.DashPunctuation or UnicodeCategory.OpenPunctuation
                    or UnicodeCategory.ClosePunctuation or UnicodeCategory.InitialQuotePunctuation or UnicodeCategory.FinalQuotePunctuation
                    or UnicodeCategory.OtherPunctuation
                    or UnicodeCategory.MathSymbol or UnicodeCategory.CurrencySymbol or UnicodeCategory.ModifierSymbol or UnicodeCategory.OtherSymbol:
                    return true;
            }
        }

        return false;
    }

    private static async Task<ProfileDto> DtoAsync(IDataStore store, string userKey, ProfileItem? item, CancellationToken ct) =>
        new(
            await CanDoAsync(store, userKey, ct),
            item?.Preferences ?? [],
            item?.Wants ?? [],
            item?.Conditions,
            item?.Agency,
            item?.Asked ?? new ProfileAsked(false, false, false),
            new QuestionsDto(
                new QuestionDto(ProfileText.PreferenceQuestion, ProfileText.PreferenceChoices),
                new QuestionDto(ProfileText.WantQuestion, ProfileText.WantChoices)),
            new ConditionOptionsDto(ProfileText.HoursPerWeekOptions, ProfileText.MonthlyIncomeOptions));

    /// <summary>
    /// できることを、保存してある場面と力の状態から作る。外していない根拠ありを seen、外していない要確認を checking に入れ、
    /// 未確認は入れない。外した力は出さず、あることだけ返す。力の順は <see cref="Ability"/> の順。
    /// </summary>
    private static async Task<CanDoDto> CanDoAsync(IDataStore store, string userKey, CancellationToken ct)
    {
        var episodes = await store.ListByTypeAsync<EpisodeItem>(userKey, EpisodeItem.ItemType, ct);
        var book = await store.GetAsync<AbilityBookItem>(userKey, AbilityBookItem.ItemId, ct);
        var views = AbilityBook.View(episodes, book);

        List<CanDoAbilityDto> Pick(AbilityState state) => views
            .Where(v => v.State == state && !v.Excluded)
            .Select(v => new CanDoAbilityDto(ActionRef.Key(v.Ability), AbilityText.Name(v.Ability), QuoteDto.From(v.Shown), v.EpisodeId))
            .ToList();

        return new CanDoDto(Pick(AbilityState.Confirmed), Pick(AbilityState.NeedsCheck), views.Any(v => v.Excluded && v.State != AbilityState.NotYet));
    }
}
