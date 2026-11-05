using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Revalue.Server.Data;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Options;

/// <summary>職種と業務のデータの出典。job tag の利用規約の記載例どおりに、データと一緒に持つ。</summary>
public sealed record JobSource(string Text, string Url, string Note);

/// <summary>業務をする場所。保存と API では <c>home</c> / <c>out</c>。</summary>
[JsonConverter(typeof(NamedEnumConverter<TaskPlace>))]
public enum TaskPlace
{
    [JsonStringEnumMemberName("home")]
    Home,

    [JsonStringEnumMemberName("out")]
    Out,
}

public sealed record HoursRange(int Min, int Max);

public sealed record YenRange(int Min, int Max);

/// <summary>職種の元になった job tag の職業。<paramref name="Number"/> は job tag の番号。</summary>
public sealed record JobTagRef(int Number, string Name);

/// <summary>業務の状態。カードに使うのは <see cref="Active"/> だけ。<see cref="Preparing"/> は業務マスターに置くが、カードに使わない。</summary>
[JsonConverter(typeof(NamedEnumConverter<JobTaskStatus>))]
public enum JobTaskStatus
{
    [JsonStringEnumMemberName("active")]
    Active,

    [JsonStringEnumMemberName("preparing")]
    Preparing,
}

/// <summary>業務の領域（経理・財務など）。</summary>
public sealed record JobDomain(string Id, string Name);

/// <summary>
/// 業務の使う力。<paramref name="Main"/> と <paramref name="Sub"/> は能力辞書にある力（準備中の力でもよい）。
/// <see cref="All"/> は主な力、補助の力の順。
/// </summary>
public sealed record TaskAbilities(Ability Main, IReadOnlyList<Ability> Sub)
{
    /// <summary>補助の力の数の上限。</summary>
    public const int MaxSub = 3;

    public IReadOnlyList<Ability> All => [Main, .. Sub];
}

/// <summary>
/// 業務。<paramref name="JobTagTasks"/> は job tag の職業のタスクの番号。<paramref name="Scene"/> は主な力が業務のどこで生きるか（力が生きる場面）、
/// <paramref name="Trial"/> は小さな試し方、<paramref name="Checks"/> は本人に確かめる条件（05-options.md の「登録した職種と業務」）。
/// </summary>
public sealed record JobTask(
    string Id,
    string Name,
    string Detail,
    JobTaskStatus Status,
    bool NeedsReview,
    IReadOnlyList<int> JobTagTasks,
    TaskAbilities Abilities,
    string Scene,
    HoursRange HoursPerWeek,
    IReadOnlyList<TimeSlot> TimeSlots,
    TaskPlace Place,
    YenRange HourlyYen,
    IReadOnlyList<string> Knowledge,
    string Trial,
    IReadOnlyList<string> Checks)
{
    /// <summary>カードに使う業務か。</summary>
    public bool IsActive => Status == JobTaskStatus.Active;

    /// <summary>業務の力のうち、話から確かめる力（主な力、補助の力の順）。</summary>
    public IReadOnlyList<Ability> ActiveAbilities => [.. Abilities.All.Where(AbilityCatalog.IsActive)];

    /// <summary>業務がその力に「つながる」か。主な力か補助の力のうち、話から確かめる力にその力がある。</summary>
    public bool Uses(Ability ability) => AbilityCatalog.IsActive(ability) && Abilities.All.Contains(ability);
}

/// <summary>職種。<paramref name="JobTag"/> は元になった job tag の職業で、職種の決まっていない業務のまとまりでは null。</summary>
public sealed record Occupation(string Id, string Name, string DomainId, string Summary, JobTagRef? JobTag, IReadOnlyList<JobTask> Tasks);

/// <summary>
/// 登録した職種と業務（業務マスター。05-options.md の「登録した職種と業務」）。埋め込みの jobs.json を起動時に読む。
/// データが壊れていたら <see cref="InvalidOperationException"/> を投げて起動を止める。
/// </summary>
public sealed partial record JobCatalog(JobSource Source, IReadOnlyList<JobDomain> Domains, IReadOnlyList<Occupation> Occupations)
{
    private const string ResourceName = "jobs.json";

    /// <summary>
    /// 業務マスターの版。読んだ jobs.json の中身の SHA-256 の 16 進。カードの元の記録の指紋に入れ、業務マスターが変わったらカードを作り直すために使う
    /// （05-options.md の「作り直す」）。<see cref="Parse"/> を通らずに作ったときは空。
    /// </summary>
    public string Version { get; init; } = "";

    public static JobCatalog Load()
    {
        using var stream = typeof(JobCatalog).Assembly.GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException("The embedded resource jobs.json is missing.");
        using var reader = new StreamReader(stream);
        return Parse(reader.ReadToEnd());
    }

    public static JobCatalog Parse(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var source = root.GetProperty("source");
            var catalog = new JobCatalog(
                new JobSource(Str(source, "text"), Str(source, "url"), Str(source, "note")),
                root.GetProperty("domains").EnumerateArray().Select(d => new JobDomain(Str(d, "id"), Str(d, "name"))).ToList(),
                root.GetProperty("occupations").EnumerateArray().Select(ParseOccupation).ToList());
            catalog.Check();
            return catalog with { Version = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(json))).ToLowerInvariant() };
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException or FormatException or InvalidCastException)
        {
            throw new InvalidOperationException("jobs.json is broken.", e);
        }
    }

    /// <summary>準備中の業務も含むすべての業務。</summary>
    public IEnumerable<JobTask> AllTasks => Occupations.SelectMany(o => o.Tasks);

    /// <summary>カードに使う業務。</summary>
    public IEnumerable<JobTask> ActiveTasks => AllTasks.Where(t => t.IsActive);

    public Occupation? FindOccupation(string id) => Occupations.FirstOrDefault(o => o.Id == id);

    /// <summary>業務を id で引く。準備中の業務も引く（保存したカードと選んだ案を、深めるとレポートで読むため）。</summary>
    public JobTask? FindTask(string id) => AllTasks.FirstOrDefault(t => t.Id == id);

    /// <summary>カードに使う業務を id で引く。準備中の業務と、登録にない業務は null。</summary>
    public JobTask? FindActiveTask(string id) => FindTask(id) is { IsActive: true } task ? task : null;

    /// <summary>業務の職種。登録にない業務なら <see cref="InvalidOperationException"/>。</summary>
    public Occupation OccupationOf(JobTask task) =>
        Occupations.FirstOrDefault(o => o.Tasks.Any(t => t.Id == task.Id))
        ?? throw new InvalidOperationException("The task is not in the catalog.");

    private static Occupation ParseOccupation(JsonElement e)
    {
        var tag = e.GetProperty("jobtag");
        return new Occupation(
            Str(e, "id"),
            Str(e, "name"),
            Str(e, "domain"),
            Str(e, "summary"),
            tag.ValueKind == JsonValueKind.Null ? null : new JobTagRef(tag.GetProperty("number").GetInt32(), Str(tag, "name")),
            e.GetProperty("tasks").EnumerateArray().Select(ParseTask).ToList());
    }

    private static JobTask ParseTask(JsonElement e)
    {
        var abilities = e.GetProperty("abilities");
        var hours = e.GetProperty("hoursPerWeek");
        var yen = e.GetProperty("hourlyYen");
        return new JobTask(
            Str(e, "id"),
            Str(e, "name"),
            Str(e, "detail"),
            ParseStatus(Str(e, "status")),
            e.GetProperty("needsReview").GetBoolean(),
            e.GetProperty("jobtagTasks").EnumerateArray().Select(x => x.GetInt32()).ToList(),
            new TaskAbilities(
                ParseAbility(Str(abilities, "main")),
                abilities.GetProperty("sub").EnumerateArray().Select(x => ParseAbility(x.GetString())).ToList()),
            Str(e, "scene"),
            new HoursRange(hours.GetProperty("min").GetInt32(), hours.GetProperty("max").GetInt32()),
            e.GetProperty("timeSlots").EnumerateArray().Select(x => ParseSlot(x.GetString())).ToList(),
            ParsePlace(Str(e, "place")),
            new YenRange(yen.GetProperty("min").GetInt32(), yen.GetProperty("max").GetInt32()),
            StrList(e, "knowledge"),
            Str(e, "trial"),
            StrList(e, "checks"));
    }

    /// <summary>辞書にある力なら、準備中の力でも読む。業務がつながる力に数えるのは、話から確かめる力だけ（<see cref="JobTask.Uses"/>）。</summary>
    private static Ability ParseAbility(string? id) =>
        AbilityCatalog.Find(id) is { } entry ? entry.Ability : throw new InvalidOperationException("jobs.json: unknown ability.");

    private static string Str(JsonElement e, string name) =>
        e.GetProperty(name).GetString() ?? throw new InvalidOperationException($"jobs.json: {name} is null.");

    private static List<string> StrList(JsonElement e, string name) =>
        e.GetProperty(name).EnumerateArray().Select(x => x.GetString() ?? throw new InvalidOperationException($"jobs.json: {name} has null.")).ToList();

    private static JobTaskStatus ParseStatus(string name) => name switch
    {
        "active" => JobTaskStatus.Active,
        "preparing" => JobTaskStatus.Preparing,
        _ => throw new InvalidOperationException("jobs.json: unknown status."),
    };

    private static TimeSlot ParseSlot(string? name) => name switch
    {
        "morning" => TimeSlot.Morning,
        "daytime" => TimeSlot.Daytime,
        "evening" => TimeSlot.Evening,
        "night" => TimeSlot.Night,
        _ => throw new InvalidOperationException("jobs.json: unknown time slot."),
    };

    private static TaskPlace ParsePlace(string name) => name switch
    {
        "home" => TaskPlace.Home,
        "out" => TaskPlace.Out,
        _ => throw new InvalidOperationException("jobs.json: unknown place."),
    };

    /// <summary>領域、職種、業務の id の形。英語の小文字と数字を、ハイフン 1 つでつなぐ。</summary>
    [GeneratedRegex("^[a-z0-9]+(-[a-z0-9]+)*$")]
    private static partial Regex IdPattern();

    private void Check()
    {
        var domains = new HashSet<string>(StringComparer.Ordinal);
        foreach (var domain in Domains)
        {
            Require(IdPattern().IsMatch(domain.Id), "bad id.");
            Require(domains.Add(domain.Id), "duplicate domain id.");
            Require(HasText(domain.Name), "empty text.");
        }

        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var occupation in Occupations)
        {
            Require(IdPattern().IsMatch(occupation.Id), "bad id.");
            Require(ids.Add(occupation.Id), "duplicate id.");
            Require(domains.Contains(occupation.DomainId), "unknown domain.");
            Require(HasText(occupation.Name) && HasText(occupation.Summary), "empty text.");
            foreach (var task in occupation.Tasks)
            {
                Require(IdPattern().IsMatch(task.Id), "bad id.");
                Require(ids.Add(task.Id), "duplicate id.");
                Require(HasText(task.Name) && HasText(task.Detail) && HasText(task.Scene) && HasText(task.Trial), "empty text.");
                Require(!task.Abilities.Sub.Contains(task.Abilities.Main), "the main ability is also a sub ability.");
                Require(task.Abilities.Sub.Distinct().Count() == task.Abilities.Sub.Count, "duplicate sub ability.");
                Require(task.Abilities.Sub.Count <= TaskAbilities.MaxSub, "too many sub abilities.");
                Require(task.HoursPerWeek.Min >= 1 && task.HoursPerWeek.Min <= task.HoursPerWeek.Max, "bad hours.");
                Require(task.HourlyYen.Min >= 0 && task.HourlyYen.Min <= task.HourlyYen.Max, "bad hourly yen.");
                Require(task.TimeSlots.Count >= 1, "no time slot.");
                if (task.IsActive)
                {
                    Require(task.JobTagTasks.Count >= 1, "no job tag task.");
                    Require(occupation.JobTag is not null, "an active task without a job tag occupation.");
                }
            }
        }
    }

    private static bool HasText(string text) => !string.IsNullOrWhiteSpace(text);

    private static void Require(bool ok, string message)
    {
        if (!ok)
        {
            throw new InvalidOperationException("jobs.json: " + message);
        }
    }
}
