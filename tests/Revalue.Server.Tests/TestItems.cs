using Revalue.Server.Data;

namespace Revalue.Server.Tests;

/// <summary>テストで保存するだけのアイテム。</summary>
public sealed record NoteItem : Item
{
    public string Text { get; init; } = "";
}
