using System.Diagnostics;
using System.Text.Json;
using Revalue.Server.Ai;
using Revalue.Server.Data;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Foundation.Auth;
using Revalue.Server.Features.Foundation.Consent;
using Revalue.Server.Features.Foundation.Limits;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Deepen;

/// <summary>選んだ案。<paramref name="OutsideConditions"/> は、選んだカードがいまの条件に収まらなくなったか（本人が書いた仕事はいつも false）。</summary>
public sealed record DeepenTargetDto(TargetKind Kind, string Title, bool OutsideConditions);

/// <summary>使える力。<paramref name="State"/> は "confirmed" か "needsCheck"。</summary>
public sealed record UsableDto(AbilityState State, IReadOnlyList<QuoteDto> Quotes);

/// <summary>業務 1 つの照らし合わせ。<paramref name="Ability"/> は使う力の key。<paramref name="Usable"/> がなければ、まだ確かめていない力。</summary>
public sealed record TaskLightDto(
    string? Id, string Name, string Detail, string Ability, string AbilityName, UsableDto? Usable, IReadOnlyList<string> Knowledge, bool Drafted);

public sealed record AnswerDto(string Text, bool FromChoice);

public sealed record QuestionDto(string Id, string Situation, string AbilityName, IReadOnlyList<string> Choices, AnswerDto? Answer);

/// <summary>画面に出す一歩の候補。<paramref name="Fits"/> が false のものは、選んだあとで条件が変わって収まらなくなった候補。</summary>
public sealed record StepDto(string Id, string Text, int Hours, TaskPlace Place, bool DemandCheck, bool Fits, bool Chosen);

/// <summary>
/// 深めた中身。<paramref name="Stale"/> は、選んだ案が変わって中身が古くなったか。古いときは、前の案の中身（業務、問い、一歩、書いた一歩）を返さない。
/// <paramref name="RetryPaused"/> は、いまの選んだ案で AI が失敗したか断ったか（画面は開いたときに自動で作り直さず、「もう一度作る」を出す）。
/// </summary>
public sealed record DeepenContentDto(
    DateTimeOffset GeneratedAt,
    bool Stale,
    bool RetryPaused,
    IReadOnlyList<TaskLightDto> Tasks,
    bool TasksRejected,
    IReadOnlyList<QuestionDto> Questions,
    IReadOnlyList<StepDto> Steps,
    bool StepsFallback,
    IReadOnlyList<string> OwnSteps);

/// <summary>深める API が返すもの。進めないときは <paramref name="Target"/> と <paramref name="Content"/> が null。まだ深めていなければ <paramref name="Content"/> が null。</summary>
public sealed record DeepenDto(DeepenReadiness Readiness, DeepenTargetDto? Target, DeepenContentDto? Content);

public sealed record TaskRequest(string? Name, string? Detail, string? Ability, string? Knowledge);

public sealed record TasksRequest(IReadOnlyList<TaskRequest>? Tasks);

public sealed record AnswerRequest(string? Text, bool? FromChoice);

public sealed record StepsRequest(IReadOnlyList<string>? Chosen, IReadOnlyList<string>? Own);

/// <summary>/api/deepen の API（06-deepen.md）。AI を呼ぶのは POST /api/deepen だけ。</summary>
public static class DeepenEndpoints
{
    /// <summary>問いの答えの長さの上限（見た目の文字）。</summary>
    public const int MaxAnswer = 200;

    /// <summary>自分で書く一歩の数の上限。</summary>
    public const int MaxOwnSteps = 3;

    public static void Map(RouteGroupBuilder api)
    {
        var deepen = api.MapGroup("/deepen").RequireConsent();

        deepen.MapGet("/", async (HttpContext http, IDataStore store, JobCatalog catalog, CancellationToken ct) =>
            TypedResults.Ok(Dto(await ReadStateAsync(store, http.User.GetUserKey()!, catalog, ct), catalog)));

        deepen.MapPost("/", async (
            HttpContext http,
            IDataStore store,
            IDeepenAi ai,
            JobCatalog catalog,
            ForbiddenWordList forbidden,
            TimeProvider time,
            ILoggerFactory loggers,
            CancellationToken ct) =>
        {
            var userKey = http.User.GetUserKey()!;
            var state = await ReadStateAsync(store, userKey, catalog, ct);
            if (state.Target is not { } target)
            {
                return NotReady(state.Readiness);
            }

            var logger = loggers.CreateLogger(typeof(DeepenEndpoints));
            var watch = Stopwatch.StartNew();
            DeepenDraft draft;
            try
            {
                draft = await ai.DraftAsync(target, state.Inputs, ct);
            }
            catch (ConversationAiException e)
            {
                logger.LogWarning("Deepening ended with {Kind} after {ElapsedMs} ms.", e.Kind, watch.ElapsedMilliseconds);
                // 同じ案のあいだは、開いたときに自動で作り直さないよう、失敗した案の指紋だけを残す。中身は変えない
                await DeepenStore.UpdateAsync(store, userKey, item => item with { FailedBasis = target.Basis }, time, ct);
                return Problems.Create(
                    StatusCodes.Status503ServiceUnavailable,
                    Problems.AiUnavailable,
                    "The AI could not deepen the chosen option.",
                    new Dictionary<string, object?> { ["kind"] = e.Kind });
            }

            var (content, rejections) = DeepenValidator.Build(draft, target, state.Inputs.Conditions!, forbidden, time.GetUtcNow());
            // 落とした数は、部分と規則の名前ごとに書く。中身は書かない
            var rejected = string.Join(", ", rejections.GroupBy(r => $"{r.Part}:{r.Rule}").Select(g => $"{g.Key}={g.Count()}"));
            logger.LogInformation(
                "Deepen generated in {ElapsedMs} ms. Rejected {Rejected}. Steps fallback {StepsFallback}.",
                watch.ElapsedMilliseconds,
                rejected.Length == 0 ? "none" : rejected,
                content.StepsFallback);

            // AI を待つあいだに、ほかの画面で選び直したかもしれない。変わっていたら保存せず、いまの状態を返す
            var current = await ReadStateAsync(store, userKey, catalog, ct);
            if (current.Target?.Basis != target.Basis)
            {
                return TypedResults.Ok(Dto(current, catalog));
            }

            // 作っているあいだに、ほかのタブが同じ案で作って保存していたら、そちらを残す。別の案の答えと一歩は残さない
            var saved = await DeepenStore.UpdateAsync(
                store,
                userKey,
                item => item.Content is { } stored && stored.Basis == target.Basis
                    ? item with { FailedBasis = null }
                    : item with { Content = content, Answers = [], ChosenStepIds = [], OwnSteps = [], FailedBasis = null },
                time,
                ct);
            return TypedResults.Ok(Dto(current with { Item = saved }, catalog));
        })
            // 送信回数を数える前に見る。進めないときは 409 を返し、深めた中身があり選んだ案が同じなら、AI を呼ばず、送信回数にも数えずに返す
            .AddEndpointFilter(async (context, next) =>
            {
                var http = context.HttpContext;
                var catalog = http.RequestServices.GetRequiredService<JobCatalog>();
                var state = await ReadStateAsync(
                    http.RequestServices.GetRequiredService<IDataStore>(), http.User.GetUserKey()!, catalog, http.RequestAborted);
                if (state.Target is null)
                {
                    return NotReady(state.Readiness);
                }

                if (state.Item?.Content is { } content && content.Basis == state.Target.Basis)
                {
                    return TypedResults.Ok(Dto(state, catalog));
                }

                return await next(context);
            })
            .RequireDailyLimit();

        deepen.MapPut("/tasks", async (HttpContext http, IDataStore store, JobCatalog catalog, TimeProvider time, CancellationToken ct) =>
        {
            if (await ReadBodyAsync<TasksRequest>(http, ct) is not { Tasks: { } requested } || CheckTasks(requested) is not { } tasks)
            {
                return Invalid();
            }

            return await ChangeAsync(http, store, catalog, time, (item, state, content) =>
            {
                if (!state.Target!.Drafts)
                {
                    throw new DeepenRequestException(Changed());
                }

                return item with { Content = content with { Tasks = tasks, TasksRejected = false } };
            }, ct);
        });

        deepen.MapPut("/answers/{questionId}", async (string questionId, HttpContext http, IDataStore store, JobCatalog catalog, TimeProvider time, CancellationToken ct) =>
        {
            if (await ReadBodyAsync<AnswerRequest>(http, ct) is not { } request
                || request.Text?.Trim() is not { } text
                || !ProfileEndpoints.HasVisibleText(text)
                || !ProfileEndpoints.FitsIn(text, MaxAnswer, MaxAnswer * 4))
            {
                return Invalid();
            }

            var fromChoice = request.FromChoice ?? false;
            return await ChangeAsync(http, store, catalog, time, (item, _, content) =>
            {
                var question = content.Questions.FirstOrDefault(q => q.Id == questionId) ?? throw new DeepenRequestException(NotFound());
                if (fromChoice && !question.Choices.Contains(text))
                {
                    throw new DeepenRequestException(Invalid());
                }

                return item with
                {
                    Answers = [.. item.Answers.Where(a => a.QuestionId != questionId), new DeepenAnswer(questionId, text, fromChoice)],
                };
            }, ct);
        });

        deepen.MapPut("/steps", async (HttpContext http, IDataStore store, JobCatalog catalog, TimeProvider time, CancellationToken ct) =>
        {
            if (await ReadBodyAsync<StepsRequest>(http, ct) is not { } request || CheckSteps(request) is not { } parsed)
            {
                return Invalid();
            }

            var (chosen, own) = parsed;
            return await ChangeAsync(http, store, catalog, time, (item, state, content) =>
            {
                var kind = state.Target!.Kind;
                var visible = DeepenSteps.Visible(content, item.ChosenStepIds, kind, state.Inputs.Conditions!);
                var fallback = DeepenText.FallbackSteps(kind);
                foreach (var id in chosen)
                {
                    if (visible.FirstOrDefault(v => v.Step.Id == id) is { } shown)
                    {
                        // 出している候補で収まらないのは、前に選んでいたものだけ。新しくは選べない
                        if (!shown.Fits && !item.ChosenStepIds.Contains(id))
                        {
                            throw new DeepenRequestException(Changed());
                        }

                        continue;
                    }

                    // 中身かコードの候補にはあるが、いまの条件で出していない
                    throw new DeepenRequestException(content.Steps.Any(s => s.Id == id) || fallback.Any(s => s.Id == id) ? Changed() : Invalid());
                }

                // 選んだコードの候補は中身の候補に足して残す（あとで条件が戻っても、選んだまま見えるように）。選ばなくなったものは外す
                var steps = content.StepsFallback
                    ? content.Steps
                    : content.Steps.Where(s => !IsFallbackId(s.Id, fallback) || chosen.Contains(s.Id))
                        .Concat(fallback.Where(f => chosen.Contains(f.Id) && content.Steps.All(s => s.Id != f.Id)))
                        .ToList();
                return item with { Content = content with { Steps = steps }, ChosenStepIds = chosen, OwnSteps = own };
            }, ct);
        });
    }

    /// <summary>深めるのに要るいまの記録。<see cref="Item"/> は保存してある深めた中身（なければ null）。</summary>
    private sealed record DeepenState(
        DeepenReadiness Readiness, DeepenTarget? Target, OptionsItem? Options, OptionsInputs Inputs, DeepenItem? Item);

    /// <summary>書き換えの途中で、要求を断ると決めた。書き換えずに <see cref="Result"/> を返す。</summary>
    private sealed class DeepenRequestException(IResult result) : Exception("The deepen request was refused.")
    {
        public IResult Result { get; } = result;
    }

    private static async Task<DeepenState> ReadStateAsync(IDataStore store, string userKey, JobCatalog catalog, CancellationToken ct)
    {
        var inputs = await OptionsInputsReader.ReadAsync(store, userKey, ct);
        var options = await store.GetAsync<OptionsItem>(userKey, OptionsItem.ItemId, ct);
        var (readiness, target) = DeepenTargetReader.From(options, inputs.Conditions, catalog);
        var item = await store.GetAsync<DeepenItem>(userKey, DeepenItem.ItemId, ct);
        return new DeepenState(readiness, target, options, inputs, item);
    }

    /// <summary>
    /// 深めた中身を書き換える。いまの対象があり、保存してある中身がいまの選んだ案のものなときだけ、<paramref name="apply"/> を呼ぶ。
    /// 書き換えは読んだときから変わっていないときだけ書く（<see cref="DeepenStore.UpdateAsync"/>）。
    /// </summary>
    private static async Task<IResult> ChangeAsync(
        HttpContext http,
        IDataStore store,
        JobCatalog catalog,
        TimeProvider time,
        Func<DeepenItem, DeepenState, DeepenContent, DeepenItem> apply,
        CancellationToken ct)
    {
        var userKey = http.User.GetUserKey()!;
        var state = await ReadStateAsync(store, userKey, catalog, ct);
        DeepenItem saved;
        try
        {
            saved = await DeepenStore.UpdateAsync(store, userKey, item =>
            {
                if (state.Target is not { } target || item.Content is not { } content || content.Basis != target.Basis)
                {
                    throw new DeepenRequestException(Changed());
                }

                return apply(item, state, content);
            }, time, ct);
        }
        catch (DeepenRequestException e)
        {
            return e.Result;
        }

        return TypedResults.Ok(Dto(state with { Item = saved }, catalog));
    }

    private static IResult NotReady(DeepenReadiness readiness) =>
        Problems.Create(
            StatusCodes.Status409Conflict,
            Problems.DeepenNotReady,
            "The chosen option cannot be deepened.",
            new Dictionary<string, object?> { ["readiness"] = readiness });

    private static IResult Invalid() =>
        Problems.Create(StatusCodes.Status400BadRequest, Problems.InvalidDeepen, "The deepen request is not valid.");

    private static IResult NotFound() =>
        Problems.Create(StatusCodes.Status404NotFound, Problems.NotFound, "Not found.");

    private static IResult Changed() =>
        Problems.Create(StatusCodes.Status409Conflict, Problems.DeepenChanged, "The deepened content has changed.");

    private static bool IsFallbackId(string id, IReadOnlyList<StepCandidate> fallback) => fallback.Any(f => f.Id == id);

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

    /// <summary>
    /// 本人が直した業務を確かめる。5 つまで、名前 1〜30、中身 0〜80、知識や道具 0〜60（前後の空白を落として数える。中身の長さは見た目の上限の 4 倍まで）、
    /// 力は 3 つの key のどれか。本人の言葉なので、使わない言葉の照らし合わせはしない。id は u1、u2…
    /// </summary>
    private static List<DeepenTask>? CheckTasks(IReadOnlyList<TaskRequest?> requested)
    {
        if (requested.Count > DeepenValidator.MaxTasks)
        {
            return null;
        }

        var tasks = new List<DeepenTask>();
        foreach (var r in requested)
        {
            if (r is null
                || Text(r.Name, DeepenValidator.MaxTaskName, allowEmpty: false) is not { } name
                || Text(r.Detail, DeepenValidator.MaxTaskDetail, allowEmpty: true) is not { } detail
                || Text(r.Knowledge, DeepenValidator.MaxKnowledge, allowEmpty: true) is not { } knowledge
                || !ActionRef.TryParseAbility(r.Ability, out var ability))
            {
                return null;
            }

            tasks.Add(new DeepenTask($"u{tasks.Count + 1}", name, detail, ability, knowledge));
        }

        return tasks;
    }

    /// <summary>選んだ候補の id（重ならない）と、自分で書いた一歩（3 つまで、どれも 1〜100 文字）。null は空として扱う。</summary>
    private static (IReadOnlyList<string> Chosen, IReadOnlyList<string> Own)? CheckSteps(StepsRequest request)
    {
        var chosen = request.Chosen ?? [];
        if (chosen.Any(string.IsNullOrEmpty) || chosen.Distinct().Count() != chosen.Count)
        {
            return null;
        }

        var requested = request.Own ?? [];
        if (requested.Count > MaxOwnSteps)
        {
            return null;
        }

        var own = new List<string>();
        foreach (var text in requested)
        {
            if (Text(text, DeepenValidator.MaxStepText, allowEmpty: false) is not { } step)
            {
                return null;
            }

            own.Add(step);
        }

        return (chosen.ToList(), own);
    }

    /// <summary>前後の空白を落とした文。見える文字がない（<paramref name="allowEmpty"/> なら空でない）か、長すぎれば null。null の入力は空として扱う。</summary>
    private static string? Text(string? text, int max, bool allowEmpty)
    {
        var trimmed = text?.Trim() ?? "";
        if (!ProfileEndpoints.HasVisibleText(trimmed))
        {
            return allowEmpty && trimmed.Length == 0 ? "" : null;
        }

        return ProfileEndpoints.FitsIn(trimmed, max, max * 4) ? trimmed : null;
    }

    private static DeepenDto Dto(DeepenState state, JobCatalog catalog)
    {
        if (state.Target is not { } target)
        {
            return new DeepenDto(state.Readiness, null, null);
        }

        var conditions = state.Inputs.Conditions!;
        var outside = target.Kind != TargetKind.Own
            && state.Options?.Choice is { } choice
            && !OptionsValidator.ChosenFits(choice, conditions, catalog);
        var targetDto = new DeepenTargetDto(target.Kind, target.Title, outside);

        if (state.Item is not { Content: { } content } item)
        {
            return new DeepenDto(state.Readiness, targetDto, null);
        }

        var stale = content.Basis != target.Basis;
        if (stale)
        {
            // 前の案の中身は出さない（作り直すあいだも見せない）
            return new DeepenDto(
                state.Readiness,
                targetDto,
                new DeepenContentDto(content.GeneratedAt, true, item.FailedBasis == target.Basis, [], false, [], [], false, []));
        }

        var tasks = DeepenLighting.Light(target, content, state.Inputs)
            .Select(t => new TaskLightDto(
                t.Id,
                t.Name,
                t.Detail,
                ActionRef.Key(t.Ability),
                AbilityText.Name(t.Ability),
                t.Usable is { } u ? new UsableDto(u.State, QuoteDto.From(u.Quotes)) : null,
                t.Knowledge,
                t.Drafted))
            .ToList();
        var questions = content.Questions
            .Select(q => new QuestionDto(
                q.Id,
                q.Situation,
                AbilityText.Name(q.Ability),
                q.Choices,
                item.Answers.FirstOrDefault(a => a.QuestionId == q.Id) is { } a ? new AnswerDto(a.Text, a.FromChoice) : null))
            .ToList();
        var steps = DeepenSteps.Visible(content, item.ChosenStepIds, target.Kind, conditions)
            .Select(v => new StepDto(v.Step.Id, v.Step.Text, v.Step.Hours, v.Step.Place, v.Step.DemandCheck, v.Fits, v.Chosen))
            .ToList();

        return new DeepenDto(
            state.Readiness,
            targetDto,
            new DeepenContentDto(content.GeneratedAt, false, false, tasks, content.TasksRejected, questions, steps, content.StepsFallback, item.OwnSteps));
    }
}
