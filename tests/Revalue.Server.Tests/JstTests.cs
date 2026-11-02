using Microsoft.Extensions.Time.Testing;
using Revalue.Server.Features.Foundation;

namespace Revalue.Server.Tests;

public sealed class JstTests
{
    [Fact(DisplayName = "foundation-6（使いすぎを穏やかに止める）: 日本時間の 0 時で日付が変わる（UTC の日付で切り替えない）")]
    public void TodaySwitchesAtJstMidnight()
    {
        var clock = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-02T14:59:59Z"));
        Assert.Equal(new DateOnly(2026, 11, 2), Jst.Today(clock));

        clock.SetUtcNow(DateTimeOffset.Parse("2026-11-02T15:00:00Z"));
        Assert.Equal(new DateOnly(2026, 11, 3), Jst.Today(clock));
    }

    [Fact(DisplayName = "foundation-6（使いすぎを穏やかに止める）: 次の 0 時は日本時間の翌日 0 時（+09:00）")]
    public void NextMidnightIsJst()
    {
        var clock = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-02T14:59:00Z"));

        var next = Jst.NextMidnight(clock);

        Assert.Equal(TimeSpan.FromHours(9), next.Offset);
        Assert.Equal(DateTimeOffset.Parse("2026-11-03T00:00:00+09:00"), next);
        Assert.Equal("2026-11-03T00:00:00+09:00", next.ToString("yyyy-MM-ddTHH:mm:sszzz"));
    }
}
