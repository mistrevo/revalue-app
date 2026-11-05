using System.Text.Json;
using Revalue.Server.Data;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Evals;

/// <summary>
/// 架空の選んだ案の 1 件（evals/deepen/*.json）。選んだ案を深める評価で、<see cref="Profile"/> の記録（evals/profiles/）と組にして流す。
/// <see cref="Options"/> は、製品と同じ形（<see cref="OptionsItem.Choice"/>）にした選んだ案。
/// </summary>
public sealed record DeepenCase(string Id, string Title, string Profile, OptionsItem Options)
{
    private static readonly DateTimeOffset ChosenAt = DateTimeOffset.UnixEpoch;

    private sealed record RawCreate(
        string Title, string Who, string Trouble, string Summary, int HoursPerWeek, TaskPlace Place, List<TimeSlot> TimeSlots);

    private sealed record RawOwn(string Title, string? Note);

    private sealed record RawChoice(string Kind, string? OccupationId, List<string>? TaskIds, string? RoleName, RawCreate? Create, RawOwn? Own);

    private sealed record Raw(string Id, string Title, string Profile, RawChoice Choice);

    /// <summary>JSON の 1 件を読む。足りない項目、登録にない職種や業務、知らない種類があれば <see cref="FormatException"/>。</summary>
    public static DeepenCase Parse(string json, JobCatalog catalog)
    {
        Raw? raw;
        try
        {
            raw = JsonSerializer.Deserialize<Raw>(json, DataConstants.Json);
        }
        catch (JsonException e)
        {
            throw new FormatException("架空の選んだ案を読めません。", e);
        }

        if (raw is not { Id.Length: > 0, Title: not null, Profile.Length: > 0, Choice.Kind: not null })
        {
            throw new FormatException("架空の選んだ案に id、title、profile、choice が要ります。");
        }

        var c = raw.Choice;
        // 理由と力は深める評価では使わない。カードの形をそろえるために、空の理由と根拠のない力を置く
        var ability = new CardAbility(new Ability("balancing-interests"), AbilityState.NeedsCheck, []);
        var range = new WorkRange(0, 0, 0, 0);
        List<OwnJob> own = [];
        OptionChoice choice;
        switch (c.Kind)
        {
            case "choose":
                var occupation = catalog.FindOccupation(c.OccupationId ?? "") ?? throw new FormatException($"{raw.Id}: 登録にない職種です。");
                choice = new OptionChoice(ChoiceKind.Card, ChosenAt, CardKind.Choose,
                    new ChooseCard(occupation.Id, occupation.Name, occupation.Summary, Tasks(raw.Id, c.TaskIds, catalog), range, "", ability), null, null, null);
                break;
            case "combine" when c.RoleName is { Length: > 0 } role:
                choice = new OptionChoice(ChoiceKind.Card, ChosenAt, CardKind.Combine, null,
                    new CombineCard(role, Tasks(raw.Id, c.TaskIds, catalog), range, "", ability), null, null);
                break;
            case "create" when c.Create is { Title: not null, Who: not null, Trouble: not null, Summary: not null, TimeSlots: not null } k:
                choice = new OptionChoice(ChoiceKind.Card, ChosenAt, CardKind.Create, null, null,
                    new CreateCard(k.Title, k.Who, k.Trouble, k.Summary, k.HoursPerWeek, k.Place, k.TimeSlots, "", ability), null);
                break;
            case "own" when c.Own is { Title.Length: > 0 } o:
                own.Add(new OwnJob("own1", o.Title, o.Note, ChosenAt));
                choice = new OptionChoice(ChoiceKind.Own, ChosenAt, null, null, null, null, "own1");
                break;
            default:
                throw new FormatException($"{raw.Id}: choice の kind は choose、combine、create、own のどれかで、それぞれの中身が要ります。");
        }

        var options = new OptionsItem { Id = OptionsItem.ItemId, UserKey = "eval", Type = OptionsItem.ItemType, Choice = choice, OwnJobs = own };
        return new DeepenCase(raw.Id, raw.Title, raw.Profile, options);
    }

    /// <summary>フォルダの中の d*.json を、ファイル名の順に読む。</summary>
    public static IReadOnlyList<DeepenCase> LoadAll(string directory, JobCatalog catalog) =>
        Directory.GetFiles(directory, "d*.json")
            .Order(StringComparer.Ordinal)
            .Select(path => Parse(File.ReadAllText(path), catalog))
            .ToList();

    private static List<CardTask> Tasks(string id, List<string>? taskIds, JobCatalog catalog)
    {
        if (taskIds is not { Count: > 0 })
        {
            throw new FormatException($"{id}: 業務の id が要ります。");
        }

        return taskIds.Select(taskId =>
        {
            var task = catalog.FindTask(taskId) ?? throw new FormatException($"{id}: 登録にない業務 {taskId} です。");
            var occupation = catalog.OccupationOf(task);
            return new CardTask(task.Id, occupation.Id, occupation.Name, task.Name, task.Detail, task.Ability, task.TimeSlots, task.Place, task.Knowledge);
        }).ToList();
    }
}
