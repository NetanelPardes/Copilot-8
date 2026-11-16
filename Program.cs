using BallardWeb.Api;
using BallardWeb.Serial;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<UartBoard>();
builder.Services.AddHostedService<UartBoard>(services => services.GetRequiredService<UartBoard>());

var app = builder.Build();
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapBoardApi();
app.Run("http://localhost:5080");
