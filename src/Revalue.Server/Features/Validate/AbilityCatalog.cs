using System.Text.Json;
using System.Text.RegularExpressions;

namespace Revalue.Server.Features.Validate;

/// <summary>力をまとめる分類。</summary>
public sealed record AbilityCategory(string Id, string Name);

/// <summary>
/// 核となる行動の一つ。<see cref="Number"/> は 1 から順。<see cref="Hint"/> は、足りない行動を聞くときに聞き手へ渡す言葉。
/// <see cref="ResumeQuestion"/> は、続きを話すときにその行動を聞く問い。話から確かめる力の行動にだけあり、準備中の力では null。
/// <see cref="Situation"/> は、本人の行動ではなく、その日の状況を表す行動（用事が重なる、など）の印。見えた力では行動の文を出さない
/// （03-validate.md の「話し終えたとき」。Claude の判断）。
/// </summary>
public sealed record AbilityActionEntry(int Number, string Text, string Hint, string? ResumeQuestion, bool Situation = false);

/// <summary>辞書の力一つ。<see cref="Status"/> は <c>active</c>（判定に使う）か <c>preparing</c>（準備中）。</summary>
public sealed record AbilityEntry(
    string Id, string Name, string Category, string Reason, string Status, bool NeedsReview, IReadOnlyList<AbilityActionEntry> Actions)
{
    public const string ActiveStatus = "active";
    public const string PreparingStatus = "preparing";

    public Ability Ability => new(Id);

    public bool IsActive => Status == ActiveStatus;
}

/// <summary>
/// 能力辞書（<c>src/shared/abilities.json</c>）。力の名前、分類、核となる行動の文と手がかり、続きの問いを、データから返す。
/// 埋め込みのリソースから一度だけ読み、形が崩れていれば起動時に止める（<see cref="Load"/>）。
/// 並びはデータの順で、表示と、同じ数のときの選び方に使う。
/// </summary>
public sealed partial class AbilityCatalog
{
    /// <summary>核となる行動の数の下限と上限。</summary>
    public const int MinActions = 2;
    public const int MaxActions = 3;

    private static readonly Lazy<AbilityCatalog> Default = new(LoadEmbedded);

    private readonly Dictionary<string, (AbilityEntry Entry, int Order)> _byId;

    private AbilityCatalog(IReadOnlyList<AbilityCategory> categories, IReadOnlyList<AbilityEntry> entries)
    {
        Categories = categories;
        Entries = entries;
        _byId = entries.Select((e, i) => (e, i)).ToDictionary(p => p.e.Id, p => (p.e, p.i), StringComparer.Ordinal);
        ActiveAbilities = [.. entries.Where(e => e.IsActive).Select(e => e.Ability)];
    }

    /// <summary>アプリが使う辞書。</summary>
    public static AbilityCatalog Current => Default.Value;

    public IReadOnlyList<AbilityCategory> Categories { get; }

    /// <summary>辞書のすべての力（準備中を含む）。データの順。</summary>
    public IReadOnlyList<AbilityEntry> Entries { get; }

    /// <summary>判定に使う力。データの順。</summary>
    public IReadOnlyList<Ability> ActiveAbilities { get; }

    public AbilityEntry? FindEntry(string? id) => id is not null && _byId.TryGetValue(id, out var found) ? found.Entry : null;

    /// <summary>核となる行動の数。辞書にない力は 0。</summary>
    public int ActionCountOf(Ability ability) => FindEntry(ability.Id)?.Actions.Count ?? 0;

    /// <summary>並びの位置。辞書にない力は辞書の力のあと。</summary>
    internal int OrderOf(Ability ability) => ability.Id is not null && _byId.TryGetValue(ability.Id, out var found) ? found.Order : int.MaxValue;

    /// <summary>判定に使う力。<see cref="AbilityCatalog"/> の順。</summary>
    public static IReadOnlyList<Ability> Active => Current.ActiveAbilities;

    /// <summary>
    /// 話から確かめる力か。辞書にない力（保存データの古い id など）と準備中の力は false。
    /// 保存データから来る力の名前を引く前に、これで除く（00-common.md の「力」）。
    /// </summary>
    public static bool IsActive(Ability ability) => Find(ability.Id) is { IsActive: true };

    /// <summary>id の力。辞書になければ null。大文字と小文字は区別する。</summary>
    public static AbilityEntry? Find(string? id) => Current.FindEntry(id);

    /// <summary>核となる行動の数。辞書にない力は 0（その力の根拠は、どの番号も捨てる）。</summary>
    public static int ActionCount(Ability ability) => Current.ActionCountOf(ability);

    /// <summary>力の名前。辞書にない力は <see cref="ArgumentOutOfRangeException"/>。</summary>
    public static string Name(Ability ability) => EntryOf(ability).Name;

    /// <summary>力の分類の id。辞書にない力は <see cref="ArgumentOutOfRangeException"/>。</summary>
    public static string Category(Ability ability) => EntryOf(ability).Category;

    /// <summary>核となる行動の文。辞書にない力か、行動の数を超える番号なら <see cref="ArgumentOutOfRangeException"/>。</summary>
    public static string ActionText(ActionRef action) => ActionOf(action).Text;

    /// <summary>本人の行動ではない、状況の行動か（<see cref="AbilityActionEntry.Situation"/>）。辞書にない力や番号なら false。</summary>
    public static bool IsSituation(ActionRef action)
    {
        var actions = Find(action.Ability.Id)?.Actions;
        return actions is not null && action.Number >= 1 && action.Number <= actions.Count && actions[action.Number - 1].Situation;
    }

    /// <summary>行動の手がかり。辞書にない力か、行動の数を超える番号なら <see cref="ArgumentOutOfRangeException"/>。</summary>
    public static string Hint(ActionRef action) => ActionOf(action).Hint;

    /// <summary>
    /// 続きを話すときに、その行動を聞く問い。辞書にない力、行動の数を超える番号、問いのない行動（準備中の力）なら <see cref="ArgumentOutOfRangeException"/>。
    /// </summary>
    public static string ResumeQuestion(ActionRef action) =>
        ActionOf(action).ResumeQuestion ?? throw new ArgumentOutOfRangeException(nameof(action));

    private static AbilityEntry EntryOf(Ability ability) =>
        Find(ability.Id) ?? throw new ArgumentOutOfRangeException(nameof(ability));

    private static AbilityActionEntry ActionOf(ActionRef action)
    {
        var actions = EntryOf(action.Ability).Actions;
        return action.Number >= 1 && action.Number <= actions.Count
            ? actions[action.Number - 1]
            : throw new ArgumentOutOfRangeException(nameof(action));
    }

    private static AbilityCatalog LoadEmbedded()
    {
        using var stream = typeof(AbilityCatalog).Assembly.GetManifestResourceStream("abilities.json")
            ?? throw new InvalidOperationException("The embedded resource abilities.json is missing.");
        using var reader = new StreamReader(stream);
        return Load(reader.ReadToEnd());
    }

    /// <summary>
    /// 辞書の JSON を読む。核となる行動が 2〜3 つでない力、番号が 1 から順でない行動、空の名前・文・手がかり、
    /// id の重なり、ない分類、知らない状態、英語の小文字とハイフンでない id、話から確かめる力が 1 つもない辞書、
    /// 話から確かめる力の行動に続きの問いがない辞書、行動がすべて状況の行動の力は <see cref="InvalidOperationException"/> で止める。
    /// </summary>
    public static AbilityCatalog Load(string json)
    {
        var data = JsonSerializer.Deserialize<CatalogData>(json, JsonOptions)
            ?? throw new InvalidOperationException("abilities.json is empty.");
        var categories = data.Categories ?? throw new InvalidOperationException("abilities.json has no categories.");
        var abilities = data.Abilities ?? throw new InvalidOperationException("abilities.json has no abilities.");

        var categoryIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var c in categories)
        {
            if (!IsId(c.Id) || string.IsNullOrWhiteSpace(c.Name) || !categoryIds.Add(c.Id!))
            {
                throw new InvalidOperationException($"abilities.json has a broken or duplicated category: {c.Id}");
            }
        }

        var ids = new HashSet<string>(StringComparer.Ordinal);
        var entries = new List<AbilityEntry>();
        foreach (var a in abilities)
        {
            if (!IsId(a.Id) || !ids.Add(a.Id!))
            {
                throw new InvalidOperationException($"abilities.json has a broken or duplicated ability id: {a.Id}");
            }

            if (string.IsNullOrWhiteSpace(a.Name) || string.IsNullOrWhiteSpace(a.Reason))
            {
                throw new InvalidOperationException($"abilities.json: {a.Id} needs a name and a reason.");
            }

            if (a.Category is null || !categoryIds.Contains(a.Category))
            {
                throw new InvalidOperationException($"abilities.json: {a.Id} has an unknown category.");
            }

            if (a.Status is not (AbilityEntry.ActiveStatus or AbilityEntry.PreparingStatus))
            {
                throw new InvalidOperationException($"abilities.json: {a.Id} has an unknown status.");
            }

            var actions = a.Actions ?? [];
            if (actions.Count is < MinActions or > MaxActions)
            {
                throw new InvalidOperationException($"abilities.json: {a.Id} needs {MinActions} to {MaxActions} actions.");
            }

            for (var i = 0; i < actions.Count; i++)
            {
                if (actions[i].Number != i + 1 || string.IsNullOrWhiteSpace(actions[i].Text) || string.IsNullOrWhiteSpace(actions[i].Hint))
                {
                    throw new InvalidOperationException($"abilities.json: {a.Id} has a broken action {i + 1}.");
                }

                if (a.Status == AbilityEntry.ActiveStatus && string.IsNullOrWhiteSpace(actions[i].ResumeQuestion))
                {
                    throw new InvalidOperationException($"abilities.json: {a.Id} needs a resume question for action {i + 1}.");
                }
            }

            if (actions.All(x => x.Situation))
            {
                throw new InvalidOperationException($"abilities.json: {a.Id} needs at least one action that is not a situation.");
            }

            entries.Add(new AbilityEntry(
                a.Id!, a.Name!, a.Category, a.Reason!, a.Status!, a.NeedsReview,
                [.. actions.Select(x => new AbilityActionEntry(
                    x.Number, x.Text!, x.Hint!, string.IsNullOrWhiteSpace(x.ResumeQuestion) ? null : x.ResumeQuestion, x.Situation))]));
        }

        if (!entries.Any(e => e.IsActive))
        {
            throw new InvalidOperationException("abilities.json has no active ability.");
        }

        return new AbilityCatalog([.. categories.Select(c => new AbilityCategory(c.Id!, c.Name!))], entries);
    }

    private static bool IsId(string? id) => id is not null && IdPattern().IsMatch(id);

    [GeneratedRegex(@"^[a-z0-9]+(-[a-z0-9]+)*\z")]
    private static partial Regex IdPattern();

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private sealed record CatalogData(List<CategoryData>? Categories, List<AbilityData>? Abilities);

    private sealed record CategoryData(string? Id, string? Name);

    private sealed record AbilityData(
        string? Id, string? Name, string? Category, string? Reason, string? Status, bool NeedsReview, List<ActionData>? Actions);

    private sealed record ActionData(int Number, string? Text, string? Hint, string? ResumeQuestion, bool Situation);
}
