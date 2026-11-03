using System.Text.Json;
using System.Text.Json.Serialization;
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

/// <summary>業務。<paramref name="JobTagTasks"/> は元のタスクの番号。</summary>
public sealed record JobTask(
    string Id,
    string Name,
    string Detail,
    IReadOnlyList<int> JobTagTasks,
    Ability Ability,
    HoursRange HoursPerWeek,
    IReadOnlyList<TimeSlot> TimeSlots,
    TaskPlace Place,
    YenRange HourlyYen,
    IReadOnlyList<string> Knowledge);

public sealed record Occupation(string Id, string Name, string Summary, JobTagRef JobTag, IReadOnlyList<JobTask> Tasks);

/// <summary>
/// 登録した職種と業務（05-options.md の「登録した職種と業務」）。埋め込みの jobs.json を起動時に読む。
/// データが壊れていたら <see cref="InvalidOperationException"/> を投げて起動を止める。
/// </summary>
public sealed record JobCatalog(JobSource Source, IReadOnlyList<Occupation> Occupations)
{
    private const string ResourceName = "jobs.json";

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
                root.GetProperty("occupations").EnumerateArray().Select(ParseOccupation).ToList());
            catalog.Check();
            return catalog;
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException or FormatException or InvalidCastException)
        {
            throw new InvalidOperationException("jobs.json is broken.", e);
        }
    }

    public IEnumerable<JobTask> AllTasks => Occupations.SelectMany(o => o.Tasks);

    public Occupation? FindOccupation(string id) => Occupations.FirstOrDefault(o => o.Id == id);

    public JobTask? FindTask(string id) => AllTasks.FirstOrDefault(t => t.Id == id);

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
            Str(e, "summary"),
            new JobTagRef(tag.GetProperty("number").GetInt32(), Str(tag, "name")),
            e.GetProperty("tasks").EnumerateArray().Select(ParseTask).ToList());
    }

    private static JobTask ParseTask(JsonElement e)
    {
        var abilityKey = Str(e, "ability");
        if (!ActionRef.TryParseAbility(abilityKey, out var ability))
        {
            throw new InvalidOperationException("jobs.json: unknown ability.");
        }

        var hours = e.GetProperty("hoursPerWeek");
        var yen = e.GetProperty("hourlyYen");
        return new JobTask(
            Str(e, "id"),
            Str(e, "name"),
            Str(e, "detail"),
            e.GetProperty("jobtagTasks").EnumerateArray().Select(x => x.GetInt32()).ToList(),
            ability,
            new HoursRange(hours.GetProperty("min").GetInt32(), hours.GetProperty("max").GetInt32()),
            e.GetProperty("timeSlots").EnumerateArray().Select(x => ParseSlot(x.GetString())).ToList(),
            ParsePlace(Str(e, "place")),
            new YenRange(yen.GetProperty("min").GetInt32(), yen.GetProperty("max").GetInt32()),
            e.GetProperty("knowledge").EnumerateArray().Select(x => x.GetString() ?? "").ToList());
    }

    private static string Str(JsonElement e, string name) =>
        e.GetProperty(name).GetString() ?? throw new InvalidOperationException($"jobs.json: {name} is null.");

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

    private void Check()
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var occupation in Occupations)
        {
            Require(ids.Add(occupation.Id), "duplicate id.");
            foreach (var task in occupation.Tasks)
            {
                Require(ids.Add(task.Id), "duplicate id.");
                Require(task.HoursPerWeek.Min >= 1 && task.HoursPerWeek.Min <= task.HoursPerWeek.Max, "bad hours.");
                Require(task.HourlyYen.Min >= 0 && task.HourlyYen.Min <= task.HourlyYen.Max, "bad hourly yen.");
                Require(task.TimeSlots.Count >= 1, "no time slot.");
                Require(task.JobTagTasks.Count >= 1, "no job tag task.");
            }
        }
    }

    private static void Require(bool ok, string message)
    {
        if (!ok)
        {
            throw new InvalidOperationException("jobs.json: " + message);
        }
    }
}
