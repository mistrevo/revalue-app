using System.Text.Json;
using Revalue.Server.Data;
using Revalue.Server.Features.Profile;

namespace Revalue.Server.Tests;

public sealed class NamedEnumConverterTests
{
    private sealed record Holder(TimeSlot Slot, Place? Place, IReadOnlyList<EntrySource>? Sources);

    private static T Read<T>(string json) => JsonSerializer.Deserialize<T>(json, DataConstants.Json)!;

    [Fact(DisplayName = "profile-3（条件を先に聞く）: 時間帯、場所、出どころは、名前で書き、同じ名前から読み戻せる")]
    public void RoundTripsEveryName()
    {
        foreach (var slot in Enum.GetValues<TimeSlot>())
        {
            var json = JsonSerializer.Serialize(slot, DataConstants.Json);
            Assert.Equal(slot, Read<TimeSlot>(json));
        }

        Assert.Equal("""["morning","daytime","evening","night"]""", JsonSerializer.Serialize(Enum.GetValues<TimeSlot>(), DataConstants.Json));
        Assert.Equal("""["homeOnly","canGoOut"]""", JsonSerializer.Serialize(Enum.GetValues<Place>(), DataConstants.Json));
        Assert.Equal("""["chosen","written"]""", JsonSerializer.Serialize(Enum.GetValues<EntrySource>(), DataConstants.Json));

        var holder = Read<Holder>("""{"slot":"night","place":null,"sources":["written","chosen"]}""");
        Assert.Equal(TimeSlot.Night, holder.Slot);
        Assert.Null(holder.Place);
        Assert.Equal([EntrySource.Written, EntrySource.Chosen], holder.Sources);
        Assert.Equal(Place.CanGoOut, Read<Holder>("""{"slot":"morning","place":"canGoOut"}""").Place);
    }

    [Theory(DisplayName = "profile-3（条件を先に聞く）: 名前と完全に一致しない値は読まずに断る（カンマでつないだ名前、前後の空白、大文字小文字の違い、数の値、null）")]
    [InlineData("\"daytime, evening\"")]
    [InlineData("\"daytime,evening\"")]
    [InlineData("\"morning,\"")]
    [InlineData("\",morning\"")]
    [InlineData("\" morning\"")]
    [InlineData("\"morning \"")]
    [InlineData("\"Morning\"")]
    [InlineData("\"MORNING\"")]
    [InlineData("\"Night\"")]
    [InlineData("\"midnight\"")]
    [InlineData("\"\"")]
    [InlineData("\"3\"")]
    [InlineData("3")]
    [InlineData("null")]
    [InlineData("true")]
    [InlineData("[\"morning\"]")]
    public void RejectsAnythingButAnExactName(string json)
    {
        Assert.Throws<JsonException>(() => Read<TimeSlot>(json));
    }

    [Theory(DisplayName = "profile-3（条件を先に聞く）: 場所と出どころも、カンマでつないだ名前を、どちらか一方の値として読まない")]
    [InlineData("\"homeOnly, canGoOut\"")]
    [InlineData("\"homeOnly,canGoOut\"")]
    [InlineData("\"HomeOnly\"")]
    [InlineData("\"1\"")]
    public void RejectsCombinedPlaces(string json)
    {
        Assert.Throws<JsonException>(() => Read<Place>(json));
        Assert.Throws<JsonException>(() => Read<Place?>(json));
    }

    [Theory(DisplayName = "profile-5（好みとやりたいことを一つずつ聞く）: 出どころは chosen か written の名前だけを読む")]
    [InlineData("\"chosen, written\"")]
    [InlineData("\"written,chosen\"")]
    [InlineData("\"Chosen\"")]
    [InlineData("\" written\"")]
    [InlineData("1")]
    public void RejectsCombinedSources(string json)
    {
        Assert.Throws<JsonException>(() => Read<EntrySource>(json));
    }

    [Fact(DisplayName = "profile-3（条件を先に聞く）: 定義にない値は名前に直さず、書き出しで止める")]
    public void RefusesToWriteUndefinedValues()
    {
        Assert.Throws<JsonException>(() => JsonSerializer.Serialize((TimeSlot)9, DataConstants.Json));
        Assert.Throws<JsonException>(() => JsonSerializer.Serialize((Place)7, DataConstants.Json));
    }
}
