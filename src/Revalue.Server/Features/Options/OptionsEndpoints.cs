using System.Diagnostics;
using System.Text.Json;
using Revalue.Server.Ai;
using Revalue.Server.Data;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Foundation.Auth;
using Revalue.Server.Features.Foundation.Consent;
using Revalue.Server.Features.Foundation.Counting;
using Revalue.Server.Features.Foundation.Limits;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Options;

/// <summary>カードの業務。<paramref name="Ability"/> は使う力の key。</summary>
public sealed record CardTaskDto(
    string Id, string OccupationName, string Name, string Detail, string Ability, IReadOnlyList<TimeSlot> TimeSlots, TaskPlace Place);

/// <summary>カードの理由に使った力。<paramref name="State"/> は "confirmed" か "needsCheck"。</summary>
public sealed record CardAbilityDto(string Key, string Name, AbilityState State, IReadOnlyList<QuoteDto> Quotes);

// カードの Reason と Ability は、選んだ案の力を本人があとで外したか、力の状態か根拠の言葉がいまの記録と合わなくなったときだけ null にする
// （ChosenCardDto.AbilityExcluded と AbilityChanged）

public sealed record ChooseCardDto(string OccupationName, string Summary, IReadOnlyList<CardTaskDto> Tasks, WorkRange Range, string? Reason, CardAbilityDto? Ability);

public sealed record CombineCardDto(string RoleName, IReadOnlyList<CardTaskDto> Tasks, WorkRange Range, string? Reason, CardAbilityDto? Ability);

public sealed record CreateCardDto(
    string Title,
    string Who,
    string Trouble,
    string Summary,
    int HoursPerWeek,
    TaskPlace Place,
    IReadOnlyList<TimeSlot> TimeSlots,
    string? Reason,
    CardAbilityDto? Ability);

/// <summary>いまの記録で見せられるカード。<paramref name="Stale"/> は、作ったあとに元の記録が変わったか。</summary>
public sealed record OptionCardsDto(
    DateTimeOffset GeneratedAt, bool Stale, ChooseCardDto? Choose, CombineCardDto? Combine, CreateCardDto? Create, IReadOnlyList<MissingCard> Missing);

public sealed record OwnJobDto(string Id, string Title, string? Note);

/// <summary>
/// 選んだカード。選んだときの中身の写し。<paramref name="AbilityExcluded"/> は、カードの力を本人があとで外したか。
/// <paramref name="AbilityChanged"/> は、外してはいないが、力の状態か根拠の言葉がいまの記録と合わなくなったか。
/// どちらかなら、理由と、もとにした力と根拠の言葉は返さない。
/// </summary>
public sealed record ChosenCardDto(
    CardKind Kind, ChooseCardDto? Choose, CombineCardDto? Combine, CreateCardDto? Create, bool AbilityExcluded, bool AbilityChanged);

public sealed record OptionChoiceDto(ChoiceKind Kind, DateTimeOffset At, ChosenCardDto? Card, OwnJobDto? OwnJob);

public sealed record SourceDto(string Text, string Url);

/// <summary>仕事の選択肢の API が返すもの。<paramref name="MonthlyIncome"/> は本人の目安（万円）。</summary>
public sealed record OptionsDto(
    Readiness Readiness, OptionCardsDto? Cards, IReadOnlyList<OwnJobDto> OwnJobs, OptionChoiceDto? Choice, int? MonthlyIncome, SourceDto Source);

/// <summary>選んだ案を置き換える要求。形を確かめて断るため、どれも文字列か null で受け取る。</summary>
public sealed record ChoiceRequest(string? Kind, string? Card, DateTimeOffset? GeneratedAt, string? OwnJobId);

/// <summary>本人が書いた仕事を足すか直す要求。</summary>
public sealed record OwnJobRequest(string? Title, string? Note);

/// <summary>/api/options の API（05-options.md）。AI を呼ぶのは POST /api/options だけ。</summary>
public static class OptionsEndpoints
{
    public static void Map(RouteGroupBuilder api)
    {
        var options = api.MapGroup("/options").RequireConsent();

        options.MapGet("/", async (HttpContext http, IDataStore store, JobCatalog catalog, CancellationToken ct) =>
        {
            var userKey = http.User.GetUserKey()!;
            var inputs = await OptionsInputsReader.ReadAsync(store, userKey, ct);
            var item = await store.GetAsync<OptionsItem>(userKey, OptionsItem.ItemId, ct);
            return TypedResults.Ok(Dto(item, inputs, catalog));
        });

        options.MapPost("/", async (
            HttpContext http,
            IDataStore store,
            IOptionsAi ai,
            JobCatalog catalog,
            ForbiddenWordList forbidden,
            TimeProvider time,
            ILoggerFactory loggers,
            CancellationToken ct) =>
        {
            var userKey = http.User.GetUserKey()!;
            var inputs = await OptionsInputsReader.ReadAsync(store, userKey, ct);
            var readiness = OptionsInputsReader.Check(inputs);
            if (readiness != Readiness.Ready)
            {
                return Problems.Create(
                    StatusCodes.Status409Conflict,
                    Problems.OptionsNotReady,
                    "The options are not ready.",
                    new Dictionary<string, object?> { ["readiness"] = readiness });
            }

            var logger = loggers.CreateLogger(typeof(OptionsEndpoints));
            var watch = Stopwatch.StartNew();
            var candidates = OptionCandidates.From(catalog, inputs);
            OptionsDraft draft;
            try
            {
                draft = await ai.DraftAsync(inputs, candidates, ct);
            }
            catch (ConversationAiException e)
            {
                logger.LogWarning("Drafting the options ended with {Kind} after {ElapsedMs} ms.", e.Kind, watch.ElapsedMilliseconds);
                return Problems.Create(
                    StatusCodes.Status503ServiceUnavailable,
                    Problems.AiUnavailable,
                    "The AI could not draft the options.",
                    new Dictionary<string, object?> { ["kind"] = e.Kind });
            }

            var (cards, rejections) = OptionsValidator.Build(draft, candidates, inputs, catalog, forbidden, time.GetUtcNow());
            // 落とした数は、カードの種類と規則の名前ごとに書く。カードの中身は書かない
            var rejected = string.Join(", ", rejections
                .GroupBy(r => $"{JsonNamingPolicy.CamelCase.ConvertName(r.Kind.ToString())}:{r.Rule}")
                .Select(g => $"{g.Key}={g.Count()}"));
            logger.LogInformation(
                "Options generated in {ElapsedMs} ms. Cards {CardCount}. Rejected {Rejected}.",
                watch.ElapsedMilliseconds,
                new object?[] { cards.Choose, cards.Combine, cards.Create }.Count(c => c is not null),
                rejected.Length == 0 ? "none" : rejected);

            // 作っているあいだに、ほかの要求（別のタブ）が同じ元の記録でカードを作って保存していたら、そちらを残す。
            // 同じ記録のまま案を入れ替えない（05-options.md の「やらないこと」）
            var saved = await OptionsStore.UpdateAsync(
                store, userKey, item => item.Cards?.Basis == cards.Basis ? item : item with { Cards = cards }, time, ct);
            return TypedResults.Ok(Dto(saved, inputs, catalog));
        })
            // 送信回数を数える前に見る。作ったカードがあり、元の記録が変わっていなければ、AI を呼ばず、送信回数にも数えずに、いまのカードを返す
            .AddEndpointFilter(async (context, next) =>
            {
                var http = context.HttpContext;
                var store = http.RequestServices.GetRequiredService<IDataStore>();
                var userKey = http.User.GetUserKey()!;
                var inputs = await OptionsInputsReader.ReadAsync(store, userKey, http.RequestAborted);
                if (OptionsInputsReader.Check(inputs) == Readiness.Ready
                    && await store.GetAsync<OptionsItem>(userKey, OptionsItem.ItemId, http.RequestAborted) is { Cards: { } cards } item
                    && cards.Basis == OptionsInputsReader.Basis(inputs))
                {
                    return TypedResults.Ok(Dto(item, inputs, http.RequestServices.GetRequiredService<JobCatalog>()));
                }

                return await next(context);
            })
            .RequireDailyLimit();

        options.MapPut("/choice", async (HttpContext http, IDataStore store, JobCatalog catalog, ICounter counter, TimeProvider time, CancellationToken ct) =>
        {
            if (await ReadBodyAsync<ChoiceRequest>(http, ct) is not { } request || ParseChoice(request) is not { } parsed)
            {
                return Invalid();
            }

            var userKey = http.User.GetUserKey()!;
            var inputs = await OptionsInputsReader.ReadAsync(store, userKey, ct);
            OptionsItem saved;
            try
            {
                saved = await OptionsStore.UpdateAsync(store, userKey, item => item with { Choice = Choose(item, parsed, inputs, catalog, time) }, time, ct);
            }
            catch (OptionsRequestException e)
            {
                return e.Result;
            }

            if (parsed.Kind is ChoiceKind.Card or ChoiceKind.Own)
            {
                await counter.CountOnceAsync(userKey, CountMetric.ChoseOption, ct);
            }

            return TypedResults.Ok(Dto(saved, inputs, catalog));
        });

        options.MapDelete("/choice", async (HttpContext http, IDataStore store, JobCatalog catalog, TimeProvider time, CancellationToken ct) =>
        {
            var userKey = http.User.GetUserKey()!;
            var inputs = await OptionsInputsReader.ReadAsync(store, userKey, ct);
            var saved = await OptionsStore.UpdateAsync(store, userKey, item => item with { Choice = null }, time, ct);
            return TypedResults.Ok(Dto(saved, inputs, catalog));
        });

        options.MapPost("/own", async (HttpContext http, IDataStore store, JobCatalog catalog, TimeProvider time, CancellationToken ct) =>
        {
            if (await ReadBodyAsync<OwnJobRequest>(http, ct) is not { } request || CheckOwnJob(request) is not { } job)
            {
                return Invalid();
            }

            return await ChangeOwnJobsAsync(http, store, catalog, time, item =>
            {
                if (item.OwnJobs.Count >= OwnJob.MaxOwnJobs)
                {
                    throw new OptionsRequestException(Invalid());
                }

                var added = new OwnJob(Guid.NewGuid().ToString("N"), job.Title, job.Note, time.GetUtcNow());
                return item with { OwnJobs = [.. item.OwnJobs, added] };
            }, ct);
        });

        options.MapPut("/own/{id}", async (string id, HttpContext http, IDataStore store, JobCatalog catalog, TimeProvider time, CancellationToken ct) =>
        {
            if (await ReadBodyAsync<OwnJobRequest>(http, ct) is not { } request || CheckOwnJob(request) is not { } job)
            {
                return Invalid();
            }

            return await ChangeOwnJobsAsync(http, store, catalog, time, item =>
            {
                if (item.OwnJobs.All(j => j.Id != id))
                {
                    throw new OptionsRequestException(NotFound());
                }

                return item with { OwnJobs = item.OwnJobs.Select(j => j.Id == id ? j with { Title = job.Title, Note = job.Note } : j).ToList() };
            }, ct);
        });

        options.MapDelete("/own/{id}", (string id, HttpContext http, IDataStore store, JobCatalog catalog, TimeProvider time, CancellationToken ct) =>
            ChangeOwnJobsAsync(http, store, catalog, time, item =>
            {
                if (item.OwnJobs.All(j => j.Id != id))
                {
                    throw new OptionsRequestException(NotFound());
                }

                // 選んだ案にしていた仕事を消したら、選んだ案も外す
                var choice = item.Choice is { Kind: ChoiceKind.Own } c && c.OwnJobId == id ? null : item.Choice;
                return item with { OwnJobs = item.OwnJobs.Where(j => j.Id != id).ToList(), Choice = choice };
            }, ct));
    }

    /// <summary>書き換えの途中で、要求を断ると決めた。書き換えずに <see cref="Result"/> を返す。</summary>
    private sealed class OptionsRequestException(IResult result) : Exception("The options request was refused.")
    {
        public IResult Result { get; } = result;
    }

    private sealed record ParsedChoice(ChoiceKind Kind, CardKind? Card, DateTimeOffset? GeneratedAt, string? OwnJobId);

    private static IResult Invalid() =>
        Problems.Create(StatusCodes.Status400BadRequest, Problems.InvalidOption, "The option request is not valid.");

    private static IResult NotFound() =>
        Problems.Create(StatusCodes.Status404NotFound, Problems.NotFound, "Not found.");

    private static IResult Changed() =>
        Problems.Create(StatusCodes.Status409Conflict, Problems.OptionsChanged, "The options have changed.");

    /// <summary>本文を JSON として読む。読めなければ null（400 にする）。</summary>
    private static async Task<T?> ReadBodyAsync<T>(HttpContext http, CancellationToken ct) where T : class
    {
        try
        {
            return await http.Request.ReadFromJsonAsync<T>(ct);
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or BadHttpRequestException)
        {
            return null;
        }
    }

    private static ParsedChoice? ParseChoice(ChoiceRequest request) => request.Kind switch
    {
        "card" when request.GeneratedAt is { } at && CardOf(request.Card) is { } card => new ParsedChoice(ChoiceKind.Card, card, at, null),
        "own" when !string.IsNullOrEmpty(request.OwnJobId) => new ParsedChoice(ChoiceKind.Own, null, null, request.OwnJobId),
        "hold" => new ParsedChoice(ChoiceKind.Hold, null, null, null),
        _ => null,
    };

    private static CardKind? CardOf(string? name) => name switch
    {
        "choose" => CardKind.Choose,
        "combine" => CardKind.Combine,
        "create" => CardKind.Create,
        _ => null,
    };

    /// <summary>
    /// 選んだ案を作る。カードは、見ていたカード（作った日時）がいまのカードで、いまの記録で見せられるときだけ選べ、その中身を写す。
    /// </summary>
    private static OptionChoice Choose(OptionsItem item, ParsedChoice parsed, OptionsInputs inputs, JobCatalog catalog, TimeProvider time)
    {
        var now = time.GetUtcNow();
        switch (parsed.Kind)
        {
            case ChoiceKind.Card:
                if (item.Cards is not { } stored || stored.GeneratedAt != parsed.GeneratedAt)
                {
                    throw new OptionsRequestException(Changed());
                }

                var shown = OptionsValidator.ForDisplay(stored, inputs, catalog);
                var choice = parsed.Card switch
                {
                    CardKind.Choose when shown.Choose is { } c => new OptionChoice(ChoiceKind.Card, now, CardKind.Choose, c, null, null, null),
                    CardKind.Combine when shown.Combine is { } c => new OptionChoice(ChoiceKind.Card, now, CardKind.Combine, null, c, null, null),
                    CardKind.Create when shown.Create is { } c => new OptionChoice(ChoiceKind.Card, now, CardKind.Create, null, null, c, null),
                    _ => null,
                };
                return choice ?? throw new OptionsRequestException(Changed());

            case ChoiceKind.Own:
                if (item.OwnJobs.All(j => j.Id != parsed.OwnJobId))
                {
                    throw new OptionsRequestException(NotFound());
                }

                return new OptionChoice(ChoiceKind.Own, now, null, null, null, null, parsed.OwnJobId);

            default:
                return new OptionChoice(ChoiceKind.Hold, now, null, null, null, null, null);
        }
    }

    private static async Task<IResult> ChangeOwnJobsAsync(
        HttpContext http, IDataStore store, JobCatalog catalog, TimeProvider time, Func<OptionsItem, OptionsItem> apply, CancellationToken ct)
    {
        var userKey = http.User.GetUserKey()!;
        OptionsItem saved;
        try
        {
            saved = await OptionsStore.UpdateAsync(store, userKey, apply, time, ct);
        }
        catch (OptionsRequestException e)
        {
            return e.Result;
        }

        var inputs = await OptionsInputsReader.ReadAsync(store, userKey, ct);
        return TypedResults.Ok(Dto(saved, inputs, catalog));
    }

    /// <summary>
    /// 本人が書いた仕事を確かめる。前後の空白を落とし、名前は見える文字を含む 1〜<see cref="OwnJob.MaxTitleLength"/> 文字。
    /// メモは見える文字がなければ書いていないこと（null）にし、<see cref="OwnJob.MaxNoteLength"/> 文字まで。中身の長さは見た目の上限の 4 倍まで。
    /// </summary>
    private static (string Title, string? Note)? CheckOwnJob(OwnJobRequest request)
    {
        if (request.Title?.Trim() is not { } title
            || !ProfileEndpoints.HasVisibleText(title)
            || !ProfileEndpoints.FitsIn(title, OwnJob.MaxTitleLength, OwnJob.MaxTitleLength * 4))
        {
            return null;
        }

        var note = request.Note?.Trim();
        if (note is not null && !ProfileEndpoints.FitsIn(note, OwnJob.MaxNoteLength, OwnJob.MaxNoteLength * 4))
        {
            return null;
        }

        return (title, note is not null && ProfileEndpoints.HasVisibleText(note) ? note : null);
    }

    private static OptionsDto Dto(OptionsItem? item, OptionsInputs inputs, JobCatalog catalog)
    {
        OptionCardsDto? cards = null;
        if (item?.Cards is { } stored)
        {
            var shown = OptionsValidator.ForDisplay(stored, inputs, catalog);
            cards = new OptionCardsDto(
                shown.GeneratedAt,
                shown.Basis != OptionsInputsReader.Basis(inputs),
                shown.Choose is { } choose ? ChooseDto(choose) : null,
                shown.Combine is { } combine ? CombineDto(combine) : null,
                shown.Create is { } create ? CreateDto(create) : null,
                shown.Missing);
        }

        var ownJobs = item?.OwnJobs ?? [];
        OptionChoiceDto? choice = item?.Choice is { } c
            ? new OptionChoiceDto(
                c.Kind,
                c.At,
                c is { Kind: ChoiceKind.Card, Card: { } kind } ? ChosenDto(c, kind, c.AbilityProblem(inputs)) : null,
                ownJobs.FirstOrDefault(j => c.Kind == ChoiceKind.Own && j.Id == c.OwnJobId) is { } own ? OwnDto(own) : null)
            : null;

        return new OptionsDto(
            OptionsInputsReader.Check(inputs),
            cards,
            ownJobs.Select(OwnDto).ToList(),
            choice,
            inputs.Conditions?.MonthlyIncome,
            new SourceDto(catalog.Source.Text, catalog.Source.Url));
    }

    private static OwnJobDto OwnDto(OwnJob job) => new(job.Id, job.Title, job.Note);

    /// <summary>
    /// 選んだカードの写し。カードの力を本人があとで外していたか（validate-12（本人が見立てを外せる））、力の状態か根拠の言葉が
    /// いまの記録と合わなくなっていたら（<paramref name="problem"/>）、理由と力と根拠の言葉を外す。
    /// </summary>
    private static ChosenCardDto ChosenDto(OptionChoice choice, CardKind kind, MissingReason? problem)
    {
        var withReason = problem is null;
        return new ChosenCardDto(
            kind,
            choice.Choose is { } ch ? ChooseDto(ch, withReason) : null,
            choice.Combine is { } co ? CombineDto(co, withReason) : null,
            choice.Create is { } cr ? CreateDto(cr, withReason) : null,
            problem == MissingReason.Excluded,
            problem == MissingReason.Changed);
    }

    private static CardAbilityDto AbilityDto(CardAbility ability) =>
        new(ActionRef.Key(ability.Ability), AbilityText.Name(ability.Ability), ability.State, QuoteDto.From(ability.Quotes));

    private static CardTaskDto TaskDto(CardTask task) =>
        new(task.TaskId, task.OccupationName, task.Name, task.Detail, ActionRef.Key(task.Ability), task.TimeSlots, task.Place);

    private static ChooseCardDto ChooseDto(ChooseCard card, bool withReason = true) =>
        new(card.OccupationName, card.Summary, card.Tasks.Select(TaskDto).ToList(), card.Range,
            withReason ? card.Reason : null, withReason ? AbilityDto(card.Ability) : null);

    private static CombineCardDto CombineDto(CombineCard card, bool withReason = true) =>
        new(card.RoleName, card.Tasks.Select(TaskDto).ToList(), card.Range, withReason ? card.Reason : null, withReason ? AbilityDto(card.Ability) : null);

    private static CreateCardDto CreateDto(CreateCard card, bool withReason = true) =>
        new(card.Title, card.Who, card.Trouble, card.Summary, card.HoursPerWeek, card.Place, card.TimeSlots,
            withReason ? card.Reason : null, withReason ? AbilityDto(card.Ability) : null);
}
