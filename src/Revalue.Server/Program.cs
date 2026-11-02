var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();
builder.Services.AddSingleton(TimeProvider.System);

var app = builder.Build();

app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/health", () => TypedResults.Ok(new { status = "ok" }));

var api = app.MapGroup("/api");
// /api の知らないパスは画面を返さず、404 の ProblemDetails にする
api.MapFallback("{**rest}", () => TypedResults.Problem(statusCode: StatusCodes.Status404NotFound));

// /api 以外の知らないパスは画面（index.html）に任せる
app.MapFallbackToFile("index.html");

app.Run();

public partial class Program;
