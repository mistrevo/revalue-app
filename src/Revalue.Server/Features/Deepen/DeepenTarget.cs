using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Revalue.Server.Data;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;

namespace Revalue.Server.Features.Deepen;

/// <summary>深められるか。進めないときは、最初に足りないもの。</summary>
[JsonConverter(typeof(NamedEnumConverter<DeepenReadiness>))]
public enum DeepenReadiness
{
    [JsonStringEnumMemberName("ready")]
    Ready,

    [JsonStringEnumMemberName("noChoice")]
    NoChoice,

    [JsonStringEnumMemberName("hold")]
    Hold,

    [JsonStringEnumMemberName("needsConditions")]
    NeedsConditions,
}

/// <summary>深める案の種類。</summary>
[JsonConverter(typeof(NamedEnumConverter<TargetKind>))]
public enum TargetKind
{
    [JsonStringEnumMemberName("choose")]
    Choose,

    [JsonStringEnumMemberName("combine")]
    Combine,

    [JsonStringEnumMemberName("create")]
    Create,

    [JsonStringEnumMemberName("own")]
    Own,
}

/// <summary>
/// 深める対象（選んだ 1 案）。<paramref name="Registered"/> は「選ぶ」と「組み合わせる」の、いまの登録から引いた業務。
/// <paramref name="Basis"/> は案の中身の指紋で、変わったら作り直す（06-deepen.md の「作り直す」）。
/// </summary>
public sealed record DeepenTarget(
    TargetKind Kind, string Title, string Basis, IReadOnlyList<JobTask> Registered, CreateCard? Create, OwnJob? Own)
{
    /// <summary>業務を AI の見立てで持つか（「創る」と本人が書いた仕事）。</summary>
    public bool Drafts => Kind is TargetKind.Create or TargetKind.Own;
}

public static class DeepenTargetReader
{
    /// <summary>選んだ案から、深められるかと、深める対象を決める（deepen-1（選んだ 1 案だけ深める））。</summary>
    public static (DeepenReadiness Readiness, DeepenTarget? Target) From(OptionsItem? options, ProfileConditions? conditions, JobCatalog catalog)
    {
        if (options?.Choice is not { } choice)
        {
            return (DeepenReadiness.NoChoice, null);
        }

        if (choice.Kind == ChoiceKind.Hold)
        {
            return (DeepenReadiness.Hold, null);
        }

        if (conditions is null)
        {
            return (DeepenReadiness.NeedsConditions, null);
        }

        DeepenTarget? target = choice switch
        {
            { Kind: ChoiceKind.Card, Card: CardKind.Choose, Choose: { } c } => new DeepenTarget(
                TargetKind.Choose, c.OccupationName,
                Fingerprint(new { kind = "choose", occupationId = c.OccupationId, taskIds = c.Tasks.Select(t => t.TaskId) }),
                Registered(c.Tasks, catalog), null, null),
            { Kind: ChoiceKind.Card, Card: CardKind.Combine, Combine: { } c } => new DeepenTarget(
                TargetKind.Combine, c.RoleName,
                Fingerprint(new { kind = "combine", roleName = c.RoleName, taskIds = c.Tasks.Select(t => t.TaskId) }),
                Registered(c.Tasks, catalog), null, null),
            { Kind: ChoiceKind.Card, Card: CardKind.Create, Create: { } c } => new DeepenTarget(
                TargetKind.Create, c.Title,
                Fingerprint(new
                {
                    kind = "create",
                    title = c.Title,
                    who = c.Who,
                    trouble = c.Trouble,
                    summary = c.Summary,
                    hours = c.HoursPerWeek,
                    place = c.Place.ToString(),
                    timeSlots = c.TimeSlots.Select(s => s.ToString()),
                }),
                [], c, null),
            { Kind: ChoiceKind.Own, OwnJobId: { } id } when options.OwnJobs.FirstOrDefault(j => j.Id == id) is { } own => new DeepenTarget(
                TargetKind.Own, own.Title,
                Fingerprint(new { kind = "own", id = own.Id, title = own.Title, note = own.Note }),
                [], null, own),
            _ => null,
        };

        return target is null ? (DeepenReadiness.NoChoice, null) : (DeepenReadiness.Ready, target);
    }

    private static IReadOnlyList<JobTask> Registered(IReadOnlyList<CardTask> tasks, JobCatalog catalog) =>
        tasks.Select(t => catalog.FindTask(t.TaskId)).OfType<JobTask>().ToList();

    private static string Fingerprint(object basis) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(basis)))).ToLowerInvariant();
}
