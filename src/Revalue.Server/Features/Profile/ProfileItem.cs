using System.Text.Json.Serialization;
using Revalue.Server.Data;

namespace Revalue.Server.Features.Profile;

/// <summary>好みとやりたいことの項目が、選択肢から選んだ言葉か、本人が書いた言葉か。</summary>
[JsonConverter(typeof(NamedEnumConverter<EntrySource>))]
public enum EntrySource
{
    [JsonStringEnumMemberName("chosen")]
    Chosen,

    [JsonStringEnumMemberName("written")]
    Written,
}

/// <summary>好みかやりたいことの項目 1 つ。</summary>
public sealed record ProfileEntry(string Text, EntrySource Source);

/// <summary>使える時間帯（04-profile.md の「条件」）。</summary>
[JsonConverter(typeof(NamedEnumConverter<TimeSlot>))]
public enum TimeSlot
{
    [JsonStringEnumMemberName("morning")]
    Morning,

    [JsonStringEnumMemberName("daytime")]
    Daytime,

    [JsonStringEnumMemberName("evening")]
    Evening,

    [JsonStringEnumMemberName("night")]
    Night,
}

/// <summary>家でできることだけか、外にも出られるか。</summary>
[JsonConverter(typeof(NamedEnumConverter<Place>))]
public enum Place
{
    [JsonStringEnumMemberName("homeOnly")]
    HomeOnly,

    [JsonStringEnumMemberName("canGoOut")]
    CanGoOut,
}

/// <summary>生活の条件。<paramref name="MonthlyIncome"/> は万円。null は「まだ決めていない」。</summary>
public sealed record ProfileConditions(IReadOnlyList<TimeSlot> TimeSlots, int HoursPerWeek, Place Place, int? MonthlyIncome);

/// <summary>どの問いに答えたか（「いまは決めない」「いまは書かない」を選んだ場合も答えたことにする）。</summary>
public sealed record ProfileAsked(bool Preferences, bool Wants, bool Agency);

/// <summary>
/// 利用者ごとに 1 件（id は固定）の、好み、やりたいこと、条件、主体性。できることは保存せず、力の状態から作る。
/// 記録ごとに別の欄に持ち、ある記録を置き換えても、ほかの記録は変えない。
/// </summary>
public sealed record ProfileItem : Item
{
    public const string ItemId = "profile";
    public const string ItemType = "profile";

    public IReadOnlyList<ProfileEntry> Preferences { get; init; } = [];

    public IReadOnlyList<ProfileEntry> Wants { get; init; } = [];

    public ProfileConditions? Conditions { get; init; }

    public string? Agency { get; init; }

    public ProfileAsked Asked { get; init; } = new(false, false, false);

    public DateTimeOffset UpdatedAt { get; init; }
}
