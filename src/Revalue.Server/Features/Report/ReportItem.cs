using Revalue.Server.Data;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Report;

/// <summary>版に残す選んだ案。理由と、もとにした力と根拠の言葉は持たない（理由は根拠の言葉を引いているため）。</summary>
public sealed record ReportChoiceSnapshot(
    ChoiceKind? Kind,
    CardKind? Card,
    string? Title,
    string? Summary,
    IReadOnlyList<string> Tasks,
    MissingReason? Problem,
    bool OutsideConditions,
    bool DemandNotChecked,
    bool CardsStale);

/// <summary>
/// 版に残す、その時点の中身。根拠の本人の言葉を写さない（07-report.md の「版を残す」）。本人が場面を飛ばしたときに、その言葉を前の版に残さないため。
/// 確かめた力は力だけで、状態も持たない（前の版と見比べて、見立てが下がったと読ませないため）。考え方の答えと一歩は本人の言葉なので残す。
/// </summary>
public sealed record ReportSnapshot(
    IReadOnlyList<Ability> Abilities,
    ReportNotYet NotYet,
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
            content.NotYet,
            content.Records,
            new ReportChoiceSnapshot(c.Kind, c.Card, c.Title, c.Summary, c.Tasks, c.Problem, c.OutsideConditions, c.DemandNotChecked, c.CardsStale),
            content.Thinking,
            content.Steps);
    }

    /// <summary>いま本人が外している力を、どの欄からも除く（前の版を見るときも、いま外している力は出さない）。</summary>
    public ReportSnapshot Without(IReadOnlyCollection<Ability> excluded)
    {
        if (excluded.Count == 0)
        {
            return this;
        }

        var hasExcluded = NotYet.HasExcluded;
        var gaps = new List<ReportTaskGap>();
        foreach (var gap in NotYet.TaskGaps)
        {
            if (gap.Ability is { } ability && excluded.Contains(ability))
            {
                hasExcluded = true;
                if (gap.Knowledge.Count > 0)
                {
                    gaps.Add(gap with { Ability = null });
                }

                continue;
            }

            gaps.Add(gap);
        }

        return this with
        {
            Abilities = Abilities.Where(a => !excluded.Contains(a)).ToList(),
            NotYet = new ReportNotYet(
                NotYet.NotHeard.Where(a => !excluded.Contains(a)).ToList(),
                NotYet.Checking.Where(a => !excluded.Contains(a)).ToList(),
                gaps,
                hasExcluded),
        };
    }
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
        if (latest?.Hash == hash)
        {
            return this;
        }

        var changed = latest is null
            ? []
            : Enum.GetValues<ReportSection>().Where(s => latest.Sections.GetValueOrDefault(s) != sections[s]).ToList();
        var version = new ReportVersion((latest?.Number ?? 0) + 1, at, hash, sections, changed, ReportSnapshot.From(content));
        return this with { Versions = [version, .. Versions.Take(MaxVersions - 1)] };
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
