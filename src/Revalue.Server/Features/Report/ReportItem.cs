using Revalue.Server.Data;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Report;

/// <summary>
/// 版に残す選んだ案。理由と、もとにした力と根拠の言葉、力が生きる場面は持たない（理由は根拠の言葉を引いているため。力が生きる場面は理由と同じ扱い）。
/// 理由と力を出せなかったわけ（外した、記録と合わない）も持たない。「合わない」は力の状態が変わったことを表すため。
/// </summary>
public sealed record ReportChoiceSnapshot(
    ChoiceKind? Kind,
    CardKind? Card,
    string? Title,
    string? Summary,
    IReadOnlyList<string> Tasks,
    bool OutsideConditions,
    bool DemandNotChecked,
    bool CardsStale);

/// <summary>
/// 版に残す、選んだ案の業務 1 つで要る知識や道具と、本人に確かめる条件。まだ確かめていない力は持たない（力の状態を表すので）。
/// 確かめる条件は業務の値で、本人の状態ではないので残す。確かめる条件を持たない前の保存の版は、空として読む。
/// </summary>
public sealed record ReportSnapshotTaskGap(string TaskName, IReadOnlyList<string> Knowledge)
{
    public IReadOnlyList<string> Checks { get; init; } = [];
}

/// <summary>
/// 版に残す、まだ確かめていないこと。業務に要る知識や道具と、本人に確かめる条件だけで、まだ聞けていない力と確かめ中の力は持たない。
/// 前の版と見比べて、見立てが下がったと読ませないため。出さないものは保存もしない（07-report.md の「版を残す」）。
/// </summary>
public sealed record ReportSnapshotNotYet(IReadOnlyList<ReportSnapshotTaskGap> TaskGaps, bool HasExcluded);

/// <summary>
/// 版に残す、その時点の中身。根拠の本人の言葉を写さない（07-report.md の「版を残す」）。本人が場面を飛ばしたときに、その言葉を前の版に残さないため。
/// 確かめた力は力だけで、状態も持たない（前の版と見比べて、見立てが下がったと読ませないため）。考え方の答えと一歩は本人の言葉なので残す。
/// </summary>
public sealed record ReportSnapshot(
    IReadOnlyList<Ability> Abilities,
    ReportSnapshotNotYet NotYet,
    ReportRecords Records,
    ReportChoiceSnapshot Choice,
    IReadOnlyList<ReportThought>? Thinking,
    IReadOnlyList<ReportStep>? Steps)
{
    public static ReportSnapshot From(ReportContent content)
    {
        var c = content.Choice;
        return new ReportSnapshot(
            content.Abilities.Select(a => a.Ability).ToList(),
            new ReportSnapshotNotYet(
                content.NotYet.TaskGaps
                    .Where(g => g.Knowledge.Count > 0 || g.Checks.Count > 0)
                    .Select(g => new ReportSnapshotTaskGap(g.TaskName, g.Knowledge) { Checks = g.Checks })
                    .ToList(),
                content.NotYet.HasExcluded),
            content.Records,
            new ReportChoiceSnapshot(c.Kind, c.Card, c.Title, c.Summary, c.Tasks, c.OutsideConditions, c.DemandNotChecked, c.CardsStale),
            content.Thinking,
            content.Steps);
    }

    /// <summary>いま本人が外している力を除く（前の版を見るときも、いま外している力は出さない）。力の名前を持つのは力の欄だけ。</summary>
    public ReportSnapshot Without(IReadOnlyCollection<Ability> excluded) =>
        excluded.Count == 0 ? this : this with { Abilities = Abilities.Where(a => !excluded.Contains(a)).ToList() };
}

/// <summary>
/// レポートの版 1 つ。<paramref name="At"/> は中身が変わったことをレポートを開いて見つけた日時。<paramref name="Hash"/> は全体の指紋、
/// <paramref name="Sections"/> は欄ごとの指紋。<paramref name="Changed"/> は前の版から指紋が変わった欄（第 1 版は空）。
/// </summary>
public sealed record ReportVersion(
    int Number,
    DateTimeOffset At,
    string Hash,
    IReadOnlyDictionary<ReportSection, string> Sections,
    IReadOnlyList<ReportSection> Changed,
    ReportSnapshot Snapshot);

/// <summary>利用者ごとに 1 件（id は固定）の、レポートの版。新しい版が先頭。</summary>
public sealed record ReportItem : Item
{
    public const string ItemId = "report";
    public const string ItemType = "report";

    /// <summary>残す版の数（Claude の判断）。</summary>
    public const int MaxVersions = 10;

    public IReadOnlyList<ReportVersion> Versions { get; init; } = [];

    public DateTimeOffset UpdatedAt { get; init; }

    /// <summary>
    /// いまの中身の指紋が、いちばん新しい版と違えば、版を先頭に足す（番号は前の番号 + 1、<see cref="MaxVersions"/> を超えた古い版は捨てる）。
    /// 同じなら、このアイテムをそのまま返す（書かない）。
    /// </summary>
    public ReportItem WithVersion(ReportContent content, DateTimeOffset at)
    {
        var sections = ReportBuilder.SectionHashes(content);
        var hash = ReportBuilder.Hash(sections);
        var latest = Versions.Count > 0 ? Versions[0] : null;

        // 同じ中身なら書かない。ほかの要求が、これより新しい時点の中身で先に版を書いていたら、古い中身を上に積まない
        if (latest is not null && (latest.Hash == hash || latest.At > at))
        {
            return this;
        }

        var changed = latest is null
            ? []
            : Enum.GetValues<ReportSection>().Where(s => latest.Sections.GetValueOrDefault(s) != sections[s]).ToList();
        var version = new ReportVersion((latest?.Number ?? 0) + 1, at, hash, sections, changed, ReportSnapshot.From(content));
        return this with { Versions = [version, .. Versions.Take(MaxVersions - 1)] };
    }

    /// <summary>
    /// <paramref name="since"/> より後に作った版を捨てる。本人が場面を飛ばしたときに、飛ばしたやりとりのあいだに作った版を残さないため
    /// （07-report.md の「版を残す」）。捨てる版がなければ、このアイテムをそのまま返す（書かない）。次の版の番号は、残った版の続きになる。
    /// </summary>
    public ReportItem WithoutVersionsAfter(DateTimeOffset since)
    {
        var kept = Versions.Where(v => v.At <= since).ToList();
        return kept.Count == Versions.Count ? this : this with { Versions = kept };
    }
}

/// <summary>レポートの版を、読んだときから変わっていないときだけ書いて置き換える。</summary>
public static class ReportStore
{
    /// <summary>
    /// 読んで、<paramref name="apply"/> で変えて、作るか ETag つきで置き換える。ほかの要求が先に書いていたら、読み直してやり直す。
    /// <paramref name="apply"/> が受け取ったアイテムをそのまま返したら、書かずにそれを返す（同じ中身の版を、ほかの画面が先に書いていたときなど）。
    /// </summary>
    public static async Task<ReportItem> UpdateAsync(
        IDataStore store, string userKey, Func<ReportItem, ReportItem> apply, TimeProvider time, CancellationToken ct)
    {
        for (var attempt = 0; attempt < DataStoreExtensions.MaxUpdateAttempts; attempt++)
        {
            var read = await store.GetVersionedAsync<ReportItem>(userKey, ReportItem.ItemId, ct);
            var current = read?.Item ?? new ReportItem { Id = ReportItem.ItemId, UserKey = userKey, Type = ReportItem.ItemType };
            var applied = apply(current);
            if (ReferenceEquals(applied, current))
            {
                return current;
            }

            var next = applied with { UpdatedAt = time.GetUtcNow() };
            var written = read is null
                ? await store.TryCreateAsync(next, ct)
                : await store.TryReplaceAsync(next, read.ETag, ct);
            if (written)
            {
                return next;
            }
        }

        throw new InvalidOperationException($"Could not update the report after {DataStoreExtensions.MaxUpdateAttempts} attempts.");
    }
}
