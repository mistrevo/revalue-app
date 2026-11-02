namespace Revalue.Server.Features.Foundation;

/// <summary>日本時間（UTC+9 固定。夏時間なし）。1 日の区切りは日本時間の 0 時。</summary>
public static class Jst
{
    public static readonly TimeSpan Offset = TimeSpan.FromHours(9);

    public static DateOnly Today(TimeProvider time) =>
        DateOnly.FromDateTime(time.GetUtcNow().ToOffset(Offset).DateTime);

    /// <summary>日本時間の翌日 0 時（+09:00 付き）。</summary>
    public static DateTimeOffset NextMidnight(TimeProvider time) =>
        new(Today(time).AddDays(1).ToDateTime(TimeOnly.MinValue), Offset);
}
