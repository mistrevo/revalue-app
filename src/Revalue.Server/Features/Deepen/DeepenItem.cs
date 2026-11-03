using Revalue.Server.Data;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Deepen;

/// <summary>見立ての業務。<paramref name="Knowledge"/> は 0〜60 文字の 1 つの文。空なら空文字。</summary>
public sealed record DeepenTask(string Id, string Name, string Detail, Ability Ability, string Knowledge);

/// <summary>仮の場面の問い。選択肢は 3 つ。</summary>
public sealed record DeepenQuestion(string Id, string Situation, Ability Ability, IReadOnlyList<string> Choices);

/// <summary>問いへの答え。選択肢から選んだか、書いたか。</summary>
public sealed record DeepenAnswer(string QuestionId, string Text, bool FromChoice);

/// <summary>最初の一歩の候補。</summary>
public sealed record StepCandidate(string Id, string Text, int Hours, TaskPlace Place, bool DemandCheck);

/// <summary>深めた中身。<paramref name="Tasks"/> は <see cref="DeepenTarget.Drafts"/> のときだけ中身がある。</summary>
public sealed record DeepenContent(
    DateTimeOffset GeneratedAt,
    string Basis,
    IReadOnlyList<DeepenTask> Tasks,
    bool TasksRejected,
    IReadOnlyList<DeepenQuestion> Questions,
    IReadOnlyList<StepCandidate> Steps,
    bool StepsFallback);

/// <summary>利用者ごとに 1 件（id は固定）の、深めた中身と、問いの答え、選んだ一歩、書いた一歩。</summary>
public sealed record DeepenItem : Item
{
    public const string ItemId = "deepen";
    public const string ItemType = "deepen";

    public DeepenContent? Content { get; init; }

    public IReadOnlyList<DeepenAnswer> Answers { get; init; } = [];

    public IReadOnlyList<string> ChosenStepIds { get; init; } = [];

    public IReadOnlyList<string> OwnSteps { get; init; } = [];

    /// <summary>最後に AI が失敗したか断ったときの、対象の指紋。同じ案のあいだは自動で作り直さない。作れたら null。</summary>
    public string? FailedBasis { get; init; }

    public DateTimeOffset UpdatedAt { get; init; }
}

/// <summary>深めた中身を、読んだときから変わっていないときだけ書いて置き換える。</summary>
public static class DeepenStore
{
    public static async Task<DeepenItem> UpdateAsync(
        IDataStore store, string userKey, Func<DeepenItem, DeepenItem> apply, TimeProvider time, CancellationToken ct)
    {
        for (var attempt = 0; attempt < DataStoreExtensions.MaxUpdateAttempts; attempt++)
        {
            var read = await store.GetVersionedAsync<DeepenItem>(userKey, DeepenItem.ItemId, ct);
            var next = apply(read?.Item ?? new DeepenItem { Id = DeepenItem.ItemId, UserKey = userKey, Type = DeepenItem.ItemType })
                with { UpdatedAt = time.GetUtcNow() };
            var written = read is null
                ? await store.TryCreateAsync(next, ct)
                : await store.TryReplaceAsync(next, read.ETag, ct);
            if (written)
            {
                return next;
            }
        }

        throw new InvalidOperationException($"Could not update the deepen item after {DataStoreExtensions.MaxUpdateAttempts} attempts.");
    }
}
