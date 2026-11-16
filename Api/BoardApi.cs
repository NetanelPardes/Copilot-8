using BallardWeb.Serial;

namespace BallardWeb.Api;

internal static class BoardApi
{
    public static void MapBoardApi(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapGet("/ports", (UartBoard board) => Run(() => Results.Ok(board.Ports())));
        api.MapGet("/board", (long? after, UartBoard board) =>
            Results.Ok(board.Snapshot(Math.Max(0, after ?? 0))));

        api.MapPost("/connect", (ConnectionInput input, UartBoard board) => Run(() =>
        {
            board.Connect(input);
            return Results.NoContent();
        }));

        api.MapPost("/disconnect", (UartBoard board) => Run(() =>
        {
            board.Disconnect();
            return Results.NoContent();
        }));

        api.MapPost("/messages", (MessageInput input, UartBoard board) => Run(() =>
        {
            var id = board.Send(input);
            return Results.Ok(new { id });
        }));

        api.MapPut("/messages/{id:guid}", (Guid id, MessageInput input, UartBoard board) => Run(() =>
        {
            board.Edit(id, input);
            return Results.NoContent();
        }));

        api.MapDelete("/messages/{id:guid}", (Guid id, UartBoard board) => Run(() =>
        {
            board.Stop(id);
            return Results.NoContent();
        }));


    }

    private static IResult Run(Func<IResult> action)
    {
        try { return action(); }
        catch (ArgumentException error)
        {
            return Results.BadRequest(new { error = error.Message });
        }
        catch (KeyNotFoundException error)
        {
            return Results.NotFound(new { error = error.Message });
        }
        catch (InvalidOperationException error)
        {
            return Results.Conflict(new { error = error.Message });
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException
            or TimeoutException or NotSupportedException)
        {
            return Results.Problem(detail: error.Message, statusCode: 503);
        }
    }
}

internal sealed record ConnectionInput(string? Port, int BaudRate, string? Parity, int StopBits);
internal sealed record EditorValue(string Value, bool Checked);
internal sealed record MessageInput(string? Profile, string? Label, int Data, int Sdi, int Ssm,
    double? Hertz, EditorValue[]? Editor);
