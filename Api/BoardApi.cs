using BallardWeb.Serial;

namespace BallardWeb.Api;

internal static class BoardApi
{
    public static void MapBoardApi(this WebApplication app)
    {
        var api = app.MapGroup("/api");

        api.MapGet("/value-fields", (UartBoard board) => Results.Ok(board.ValueFields()));
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
            board.Send(input);
            return Results.NoContent();
        }));
        api.MapPut("/messages/{id:guid}", (Guid id, MessageInput input, UartBoard board) => Run(() =>
        {
            board.EditStandalone(id, input);
            return Results.NoContent();
        }));
        api.MapPut("/messages/{id:guid}/pause", (Guid id, StandalonePause input, UartBoard board) => Run(() =>
        {
            board.PauseStandalone(id, input.Paused);
            return Results.NoContent();
        }));
        api.MapDelete("/messages/{id:guid}", (Guid id, UartBoard board) => Run(() =>
        {
            board.RemoveStandalone(id);
            return Results.NoContent();
        }));
        api.MapPost("/plans", (UartBoard board) => Run(() => Results.Ok(board.CreatePlan())));
        api.MapDelete("/plans/{id:guid}", (Guid id, long revision, UartBoard board) => Run(() =>
        {
            board.DeletePlan(id, revision);
            return Results.NoContent();
        }));
        api.MapPost("/plans/{id:guid}/activate", (Guid id, RevisionInput input, UartBoard board) => Run(() =>
        {
            board.ActivatePlan(id, input.Revision);
            return Results.NoContent();
        }));
        api.MapPost("/plans/{id:guid}/items", (Guid id, PlanChange input, UartBoard board) => Run(() =>
        {
            board.SaveItem(id, null, input);
            return Results.NoContent();
        }));
        api.MapPut("/plans/{id:guid}/items/{item:guid}",
            (Guid id, Guid item, PlanChange input, UartBoard board) => Run(() =>
        {
            board.SaveItem(id, item, input);
            return Results.NoContent();
        }));
        api.MapDelete("/plans/{id:guid}/items/{item:guid}",
            (Guid id, Guid item, long revision, UartBoard board) => Run(() =>
        {
            board.RemoveItem(id, item, revision);
            return Results.NoContent();
        }));
        api.MapPut("/plans/{id:guid}/items/{item:guid}/pause",
            (Guid id, Guid item, PauseChange input, UartBoard board) => Run(() =>
        {
            board.SetPaused(id, item, input);
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
