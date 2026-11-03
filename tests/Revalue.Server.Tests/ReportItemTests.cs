using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Report;

namespace Revalue.Server.Tests;

public sealed class ReportItemTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 3, 1, 0, 0, TimeSpan.Zero);

    private static ReportContent Content(string agency) =>
        new(
            [],
            new ReportNotYet([], [], [], false),
            new ReportRecords([], [], null, agency),
            new ReportChoice(null, null, null, null, [], null, null, null, false, false, false),
            null,
            null);

    private static ReportItem Empty() => new() { Id = ReportItem.ItemId, UserKey = "u", Type = ReportItem.ItemType };

    [Fact(DisplayName = "report-3（版を残す）: ほかの要求が新しい時点の中身で先に版を書いていたら、古い時点の中身を上に積まない")]
    public void OlderContentIsNotStackedOnNewerVersion()
    {
        var item = Empty().WithVersion(Content("架空の新しい中身"), T0.AddMinutes(2));

        var stale = item.WithVersion(Content("架空の古い中身"), T0.AddMinutes(1));

        Assert.Same(item, stale);
        var newer = item.WithVersion(Content("架空のもっと新しい中身"), T0.AddMinutes(3));
        Assert.Equal([2, 1], newer.Versions.Select(v => v.Number));
    }

    [Fact(DisplayName = "report-3（版を残す）: 飛ばしたやりとりが始まった時点より後の版だけを捨て、次の番号は残った版の続きになる")]
    public void DropsVersionsAfterSkippedTalk()
    {
        var item = Empty()
            .WithVersion(Content("架空の中身 1"), T0)
            .WithVersion(Content("架空の中身 2"), T0.AddMinutes(2))
            .WithVersion(Content("架空の中身 3"), T0.AddMinutes(3));

        var scrubbed = item.WithoutVersionsAfter(T0.AddMinutes(1));

        Assert.Equal([1], scrubbed.Versions.Select(v => v.Number));
        Assert.Same(scrubbed, scrubbed.WithoutVersionsAfter(T0.AddMinutes(1)));
        Assert.Equal([2, 1], scrubbed.WithVersion(Content("架空の中身 4"), T0.AddMinutes(4)).Versions.Select(v => v.Number));
    }
}
