using System.Diagnostics;
using System.IO.Ports;
using BallardWeb.Api;
using BallardWeb.Arinc;

namespace BallardWeb.Serial;

internal sealed class UartBoard : BackgroundService
{
    private const int HistoryLimit = 5000;
    private readonly object gate = new();
    private readonly Dictionary<Guid, Cycle> cycles = [];
    private readonly Queue<Traffic> history = new(HistoryLimit);
    private readonly Guid streamId = Guid.NewGuid();
    private SerialPort? port;
    private long sequence;

    public string[] Ports() => SerialPort.GetPortNames().Order().ToArray();

    public object Snapshot(long after)
    {
        lock (gate)
        {
            long first = history.TryPeek(out var oldest) ? oldest.Sequence : sequence + 1;
            return new
            {
                streamId, port = port?.PortName,
                active = cycles.Values.Select(cycle => new { cycle.Id, cycle.Input }).ToArray(),
                events = history.Where(item => item.Sequence > after).Take(500).ToArray(),
                lost = after > 0 && after < first ? first - after - 1 : 0
            };
        }
    }

    public void Connect(ConnectionInput input)
    {
        if (input.Port is null || !Ports().Contains(input.Port, StringComparer.Ordinal))
            throw new ArgumentException("בחר פורט מהרשימה.");

        if (input.BaudRate <= 0 || input.Parity is not ("None" or "Even" or "Odd")
            || input.StopBits is not (1 or 2))
            throw new ArgumentException("בדוק את הגדרות UART.");

        lock (gate)
        {
            if (port is not null) throw new InvalidOperationException("יש כבר פורט מחובר.");

            var candidate = new SerialPort(input.Port, input.BaudRate, Enum.Parse<Parity>(input.Parity), 8,
                input.StopBits == 1 ? StopBits.One : StopBits.Two)
            {
                Handshake = Handshake.None,
                ReadTimeout = 100,
                WriteTimeout = 1000
            };

            try
            {
                candidate.Open();
                port = candidate;
            }
            catch
            {
                candidate.Dispose();
                throw;
            }
        }
    }

    public void Disconnect()
    {
        lock (gate) ClosePort();
    }

    public Guid? Send(MessageInput input)
    {
        byte[] bytes = Encode(input);

        lock (gate)
        {
            EnsurePort();

            if (input.Hertz is not double hertz)
            {
                Write(bytes, input.Label, null);
                return null;
            }

            CheckCapacity(hertz, null);
            Guid id = Guid.NewGuid();
            Write(bytes, input.Label, id);
            cycles.Add(id, new Cycle(id, input, bytes, Stopwatch.GetTimestamp()));
            return id;
        }
    }

    public void Edit(Guid id, MessageInput input)
    {
        byte[] bytes = Encode(input);
        if (input.Hertz is not double hertz)
            throw new ArgumentException("שידור פעיל דורש תדר.");

        lock (gate)
        {
            if (!cycles.ContainsKey(id)) throw MissingCycle();
            CheckCapacity(hertz, id);
            cycles[id] = new Cycle(id, input, bytes, Stopwatch.GetTimestamp());
        }
    }

    public void Stop(Guid id)
    {
        lock (gate)
            if (!cycles.Remove(id)) throw MissingCycle();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(2));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                lock (gate)
                {
                    if (port is null) continue;

                    try
                    {
                        ReadAvailable();
                        long now = Stopwatch.GetTimestamp();

                        foreach (var cycle in cycles.Values.OrderBy(c => c.Next).ToArray())
                        {
                            if (cycle.Next > now) break;
                            Write(cycle.Bytes, cycle.Input.Label, cycle.Id);

                            // Skip missed periods instead of sending a burst after a delay.
                            long elapsed = Stopwatch.GetTimestamp() - cycle.Next;
                            cycle.Next += (elapsed / cycle.Period + 1) * cycle.Period;
                        }
                    }
                    catch (Exception error) when (error is IOException or InvalidOperationException
                        or UnauthorizedAccessException or TimeoutException or NotSupportedException)
                    {
                        Record("ERROR", null, null, [], error.Message);

                        try { ClosePort(); }
                        catch (IOException closeError)
                        {
                            Record("ERROR", null, null, [], closeError.Message);
                        }
                    }
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally
        {
            Disconnect();
        }
    }

    private void ReadAvailable()
    {
        var current = EnsurePort();
        int available = Math.Min(current.BytesToRead, 4096);
        if (available == 0) return;
        byte[] bytes = new byte[available];
        int read = current.Read(bytes, 0, bytes.Length);
        if (read > 0) Record("RX", null, null, bytes.AsSpan(0, read), null);
    }

    private void Write(byte[] bytes, string? label, Guid? id)
    {
        var current = EnsurePort();
        current.Write(bytes, 0, bytes.Length);
        Record("TX", label, id, bytes, null);
    }

    private void Record(string direction, string? label, Guid? id, ReadOnlySpan<byte> bytes, string? error)
    {
        if (history.Count == HistoryLimit) history.Dequeue();
        var hex = BitConverter.ToString(bytes.ToArray()).Replace('-', ' ');
        history.Enqueue(new Traffic(++sequence, DateTimeOffset.UtcNow, direction, label, id, hex, error));
    }

    private void ClosePort()
    {
        cycles.Clear();
        var current = port;
        port = null;
        current?.Dispose();
    }

    private void CheckCapacity(double hertz, Guid? replace)
    {
        var current = EnsurePort();
        double sum = hertz + cycles.Values.Where(c => c.Id != replace).Sum(c => c.Input.Hertz!.Value);
        int bitsPerByte = 1 + current.DataBits + (current.Parity == Parity.None ? 0 : 1)
            + (current.StopBits == StopBits.Two ? 2 : 1);

        if (sum * 4 * bitsPerByte >= current.BaudRate)
            throw new ArgumentException("סך תדרי ההודעות המחזוריות גבוה מדי לקצב ה־UART.");
    }

    private SerialPort EnsurePort() => port is { IsOpen: true } current
        ? current : throw new InvalidOperationException("התחבר לפורט תחילה.");

    private static KeyNotFoundException MissingCycle() => new("השידור כבר אינו פעיל.");

    private static byte[] Encode(MessageInput input)
    {
        if (input.Label is not { Length: 3 } label || label[0] is < '0' or > '3'
            || label.Any(c => c is < '0' or > '7') || input.Data is < 0 or > 524287
            || input.Sdi is < 0 or > 3 || input.Ssm is < 0 or > 3)
            throw new ArgumentException("בדוק את ה־Label ואת השדות במילה.");

        if (input.Hertz is double hertz && (!double.IsFinite(hertz) || hertz is < 0.1 or > 100))
            throw new ArgumentException("התדר להודעה מחזורית חייב להיות בין 0.1 ל־100 הרץ.");

        if (input.Profile is { Length: > 150 } || input.Editor is { Length: > 100 }
            || input.Editor?.Any(value => value is null || value.Value is null || value.Value.Length > 128) == true)
            throw new ArgumentException("נתוני העורך חורגים מהגודל הנתמך.");

        return ArincWord.Encode(label, input.Data, input.Sdi, input.Ssm);
    }

    private sealed class Cycle(Guid id, MessageInput input, byte[] bytes, long now)
    {
        public Guid Id { get; } = id;
        public MessageInput Input { get; } = input;
        public byte[] Bytes { get; } = bytes;
        public long Period { get; } = (long)Math.Round(Stopwatch.Frequency / input.Hertz!.Value);
        public long Next { get; set; } = now + (long)Math.Round(Stopwatch.Frequency / input.Hertz!.Value);
    }

    private sealed record Traffic(long Sequence, DateTimeOffset Time, string Direction,
        string? Label, Guid? CycleId, string Hex, string? Error);
}
