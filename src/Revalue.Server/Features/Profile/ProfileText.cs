namespace Revalue.Server.Features.Profile;

/// <summary>
/// 好みとやりたいことの問い、選択肢、条件の選択肢（04-profile.md）。裏側の言葉の 1 か所で、画面へは API で渡す。
/// 本人の力を値踏みする言い方にしない。
/// </summary>
public static class ProfileText
{
    public const string PreferenceQuestion = "どんな進め方や環境が、自分に合っていると思いますか？";

    public static readonly IReadOnlyList<string> PreferenceChoices =
    [
        "自分のペースで進められる",
        "人とやりとりしながら進められる",
        "決まった手順がある",
    ];

    public const string WantQuestion = "これからやってみたいことや、目指したいことに近いものはありますか？";

    public static readonly IReadOnlyList<string> WantChoices =
    [
        "これまでの経験を活かしたい",
        "人の役に立つことをしたい",
        "新しいことを覚えたい",
    ];

    /// <summary>週あたりの時間の選択肢。</summary>
    public static readonly IReadOnlyList<int> HoursPerWeekOptions = [3, 5, 10, 15, 20, 30, 40];

    /// <summary>月の収入の目安の選択肢（万円）。ほかに null（まだ決めていない）を選べる。</summary>
    public static readonly IReadOnlyList<int> MonthlyIncomeOptions = [1, 3, 5, 8, 10, 15, 20];

    public const int MaxEntries = 5;
    public const int MaxEntryLength = 100;
    public const int MaxAgencyLength = 500;
}
