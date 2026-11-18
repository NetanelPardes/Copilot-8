namespace BallardWeb.Api;

internal sealed record ConnectionInput(string? Port, int BaudRate, string? Parity, int StopBits);
internal sealed record EditorValue(string Value, bool Checked);
internal sealed record MessageInput(string? Profile, string? Label, int Data, int Sdi, int Ssm,
    double? Hertz, EditorValue[]? Editor, DataSource? Source = null);

internal sealed record RevisionInput(long Revision);
internal sealed record PlanChange(long Revision, MessageInput Input);
internal sealed record PauseChange(long Revision, bool Paused);

internal sealed record StandalonePause(bool Paused);

internal sealed record DataSource(string Mode, string Field, decimal Minimum, decimal Maximum,
    decimal Start, decimal Increment, int SamplesPerPeriod, decimal[]? Values);
