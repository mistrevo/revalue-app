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

    /// <summary>週あたりの時間の選択肢。使える時間が少ない人も、実際より多く選ばずに済むよう、週 1 時間から置く。</summary>
    public static readonly IReadOnlyList<int> HoursPerWeekOptions = [1, 3, 5, 10, 15, 20, 30, 40];

    /// <summary>月の収入の目安の選択肢（万円）。ほかに null（まだ決めていない）を選べる。</summary>
    public static readonly IReadOnlyList<int> MonthlyIncomeOptions = [1, 3, 5, 8, 10, 15, 20];

    public const int MaxEntries = 5;

    /// <summary>書いた答えの長さの上限（見た目の文字。絵文字などの合成された文字は 1 文字と数える）。</summary>
    public const int MaxEntryLength = 100;

    /// <summary>
    /// 書いた答えの、中身の長さ（UTF-16）の上限。結合文字を重ねると、見た目は 1 文字のまま長くできるので、こちらでも区切る。
    /// 絵文字をつないだ文字も入るよう、見た目の上限の 4 倍にする。
    /// </summary>
    public const int MaxEntryUtf16Length = MaxEntryLength * 4;

    /// <summary>主体性の長さの上限（見た目の文字）。</summary>
    public const int MaxAgencyLength = 500;

    /// <summary>主体性の、中身の長さ（UTF-16）の上限。考え方は <see cref="MaxEntryUtf16Length"/> と同じ。</summary>
    public const int MaxAgencyUtf16Length = MaxAgencyLength * 4;
}
