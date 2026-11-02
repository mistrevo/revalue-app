using Revalue.Server.Ai;
using Revalue.Server.Data;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Foundation.Auth;
using Revalue.Server.Features.Foundation.Consent;
using Revalue.Server.Features.Foundation.Counting;
using Revalue.Server.Features.Foundation.Limits;
using Revalue.Server.Features.Validate;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddRevalueAuth(builder.Environment);
builder.Services.AddRevalueData(builder.Configuration, builder.Environment);
builder.Services.AddConversationAi(builder.Configuration, builder.Environment);
builder.Services.Configure<LimitOptions>(builder.Configuration.GetSection("Limits"));
builder.Services.AddSingleton<ICounter, Counter>();
builder.Services.AddScoped<TalkStream>();

var app = builder.Build();

app.UseMiddleware<RequestLogMiddleware>();
app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseDefaultFiles();
app.UseStaticFiles();
app.UseRevalueAuth();
app.UseMiddleware<DailyTouchMiddleware>();

app.MapDevAuth();

var api = app.MapGroup("/api").RequireAuthorization();
// commit は、イメージを作ったコミット（Dockerfile が Build__Commit に入れる）。デプロイのあとに、新しいイメージが動いているかを確かめるのに使う
api.MapGet("/health", (IConfiguration config) => TypedResults.Ok(new { status = "ok", commit = config["Build:Commit"] ?? "local" }))
    .AllowAnonymous();
ConsentEndpoints.Map(api);
DiscoverEndpoints.Map(api);
ValidateEndpoints.Map(api);
api.MapGet("/stats", async (ICounter counter, CancellationToken ct) => TypedResults.Ok(await counter.GetAsync(ct))).RequireConsent();

// テストの環境（Testing）だけ、送信回数の上限を確かめるための API を足す。本番の経路には足さない
if (app.Environment.IsEnvironment("Testing"))
{
    api.MapPost("/_test/send", () => TypedResults.NoContent()).RequireConsent().RequireDailyLimit();
}

// /api の知らないパスは画面を返さず、404 の ProblemDetails にする
api.MapFallback("{**rest}", () => TypedResults.Problem(statusCode: StatusCodes.Status404NotFound));

// /api 以外の知らないパスは画面（index.html）に任せる
app.MapFallbackToFile("index.html");

app.Run();

public partial class Program;
