using Revalue.Server.Data;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Foundation.Auth;
using Revalue.Server.Features.Foundation.Consent;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddRevalueAuth(builder.Environment);
builder.Services.AddRevalueData(builder.Configuration, builder.Environment);

var app = builder.Build();

app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseDefaultFiles();
app.UseStaticFiles();
app.UseRevalueAuth();
app.UseMiddleware<DailyTouchMiddleware>();

app.MapDevAuth();

var api = app.MapGroup("/api").RequireAuthorization();
api.MapGet("/health", () => TypedResults.Ok(new { status = "ok" })).AllowAnonymous();
ConsentEndpoints.Map(api);
api.MapGet("/stats", () => TypedResults.Ok(new { })).RequireConsent();
// /api の知らないパスは画面を返さず、404 の ProblemDetails にする
api.MapFallback("{**rest}", () => TypedResults.Problem(statusCode: StatusCodes.Status404NotFound));

// /api 以外の知らないパスは画面（index.html）に任せる
app.MapFallbackToFile("index.html");

app.Run();

public partial class Program;
