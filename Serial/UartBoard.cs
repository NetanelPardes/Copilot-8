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
    private readonly PlanStore store;
    private readonly NumericCatalogue catalogue;
    private readonly UartPacketReader packetReader = new();

    public UartBoard(IWebHostEnvironment environment)
    {
        store = new PlanStore(environment.ContentRootPath);
        catalogue = new NumericCatalogue(environment.ContentRootPath);
    }
    private SerialPort? port;
    private long sequence;

    public object ValueFields() => catalogue.Fields;

    public string[] Ports() => SerialPort.GetPortNames().Order().ToArray();

    public object Snapshot(long after)
    {
        lock (gate)
        {
            long first = history.TryPeek(out var oldest) ? oldest.Sequence : sequence + 1;
            return new
            {
                streamId, port = port?.PortName,
                plans = store.Plans,
                active = cycles.Values.Select(cycle => new
                {
                    cycle.Id, cycle.PlanId, cycle.Input, cycle.Paused, cycle.Completed,
                    currentData = cycle.Current.Data, currentValue = cycle.Source?.LastValue
                }).ToArray(),
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

    public SendPlan CreatePlan()
    {
        lock (gate) return store.Create();
    }

    public void DeletePlan(Guid id, long revision)
    {
        lock (gate)
        {
            store.Delete(id, revision);
            foreach (var key in cycles.Values.Where(c => c.PlanId == id).Select(c => c.Id).ToArray())
                cycles.Remove(key);
        }
    }

    public void SaveItem(Guid planId, Guid? itemId, PlanChange change)
    {
        byte[] bytes = Encode(change.Input);
        lock (gate)
        {
            var plan = store.Get(planId, change.Revision);
            var existing = itemId is Guid id ? plan.Items.FirstOrDefault(i => i.Id == id)
                ?? throw new KeyNotFoundException("ההודעה אינה בתוכנית.") : null;
            var item = new PlanItem(existing?.Id ?? Guid.NewGuid(), change.Input, existing?.Paused ?? false);
            if (existing is not null && cycles.ContainsKey(item.Id))
                CheckCapacity(change.Input.Hertz ?? 0, item.Id, item.Paused);
            var items = existing is null ? plan.Items.Append(item).ToArray()
                : plan.Items.Select(i => i.Id == item.Id ? item : i).ToArray();
            store.Save(plan with { Items = items });
            if (existing is not null && cycles.TryGetValue(item.Id, out var previous))
                cycles[item.Id] = new Cycle(item.Id, planId, item.Input, bytes,
                    Stopwatch.GetTimestamp(), item.Paused, catalogue) { Completed = previous.Completed };
        }
    }

    public void SetPaused(Guid planId, Guid itemId, PauseChange change)
    {
        lock (gate)
        {
            var plan = store.Get(planId, change.Revision);
            var item = plan.Items.FirstOrDefault(i => i.Id == itemId)
                ?? throw new KeyNotFoundException("ההודעה אינה בתוכנית.");
            cycles.TryGetValue(itemId, out var cycle);
            if (cycle is not null && !change.Paused)
                CheckCapacity(item.Input.Hertz ?? 0, item.Id, false);
            store.Save(plan with
            {
                Items = plan.Items.Select(i => i.Id == itemId ? i with { Paused = change.Paused } : i).ToArray()
            });
            if (cycle is not null)
            {
                cycle.Paused = change.Paused;
                cycle.Next = Stopwatch.GetTimestamp();
            }
        }
    }

    public void RemoveItem(Guid planId, Guid itemId, long revision)
    {
        lock (gate)
        {
            var plan = store.Get(planId, revision);
            if (!plan.Items.Any(i => i.Id == itemId)) throw new KeyNotFoundException("ההודעה אינה בתוכנית.");
            store.Save(plan with { Items = plan.Items.Where(i => i.Id != itemId).ToArray() });
            cycles.Remove(itemId);
        }
    }

    public void ActivatePlan(Guid planId, long revision)
    {
        lock (gate)
        {
            var plan = store.Get(planId, revision);
            if (plan.Items.Length == 0) throw new ArgumentException("הוסף הודעה לתוכנית.");
            EnsurePort();
            var ready = plan.Items.Select(item => (Item: item, Bytes: Encode(item.Input))).ToArray();
            double sum = cycles.Values.Where(c => c.PlanId != planId && !c.Paused && !c.Completed)
                .Sum(c => c.Input.Hertz ?? 0)
                + plan.Items.Sum(i => i.Input.Hertz ?? 0);
            ValidateCapacity(sum);
            // Persist the group resume only after all validation succeeds, before
            // replacing runtime jobs. A failed save leaves current jobs unchanged.
            store.Save(plan with
            {
                Items = plan.Items.Select(item => item with { Paused = false }).ToArray()
            });
            foreach (var key in cycles.Values.Where(c => c.PlanId == planId).Select(c => c.Id).ToArray())
                cycles.Remove(key);
            long start = Stopwatch.GetTimestamp();
            foreach (var value in ready)
                cycles.Add(value.Item.Id, new Cycle(value.Item.Id, planId, value.Item.Input,
                    value.Bytes, start, false, catalogue));
        }
    }

    public void Send(MessageInput input)
    {
        byte[] bytes = Encode(input);
        lock (gate)
        {
            EnsurePort();
            CheckCapacity(input.Hertz ?? 0, null, false);
            Guid id = Guid.NewGuid();
            cycles.Add(id, new Cycle(id, null, input, bytes, Stopwatch.GetTimestamp(), false, catalogue));
        }
    }

    public void EditStandalone(Guid id, MessageInput input)
    {
        byte[] bytes = Encode(input);
        lock (gate)
        {
            var previous = Standalone(id);
            CheckCapacity(input.Hertz ?? 0, id, previous.Paused);
            cycles[id] = new Cycle(id, null, input, bytes, Stopwatch.GetTimestamp(), previous.Paused, catalogue)
                { Completed = previous.Completed };
        }
    }

    public void PauseStandalone(Guid id, bool paused)
    {
        lock (gate)
        {
            var cycle = Standalone(id);
            if (!paused) CheckCapacity(cycle.Input.Hertz ?? 0, id, false);
            cycle.Paused = paused;
            cycle.Next = Stopwatch.GetTimestamp();
        }
    }

    public void RemoveStandalone(Guid id)
    {
        lock (gate)
        {
            Standalone(id);
            cycles.Remove(id);
        }
    }

    private Cycle Standalone(Guid id) => cycles.TryGetValue(id, out var cycle) && cycle.PlanId is null
        ? cycle : throw new KeyNotFoundException("השידור העצמאי לא נמצא.");

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

                        var due = cycles.Values.Where(c => !c.Paused && !c.Completed && c.Next <= now)
                            .OrderBy(c => c.Next).ThenBy(c => c.Id).ToArray();
                        foreach (var batch in due.Chunk(UartPacket.MaxWords))
                        {
                            var values = batch.Select(cycle =>
                            {
                                var currentInput = cycle.Source?.Current() ?? cycle.Input;
                                byte[] bytes = ArincWord.Encode(currentInput.Label!, currentInput.Data,
                                    currentInput.Sdi, currentInput.Ssm);
                                return (Cycle: cycle, Input: currentInput, Bytes: bytes);
                            }).ToArray();
                            byte[] packet = UartPacket.Encode(values.Select(value => value.Bytes).ToArray());
                            // One serial write per complete packet. Jobs advance only after it succeeds.
                            EnsurePort().Write(packet, 0, packet.Length);
                            Guid packetId = Guid.NewGuid();
                            string packetHex = Hex(packet);
                            foreach (var value in values)
                            {
                                var cycle = value.Cycle;
                                cycle.Current = value.Input;
                                cycle.Source?.Advance();
                                Record("TX", value.Input.Label, cycle.Id, value.Bytes, null,
                                    packetId, packetHex, batch.Length, packet[^3]);
                                if (cycle.Input.Hertz is null)
                                {
                                    cycle.Completed = true;
                                    continue;
                                }
                                // Keep the original phase; skip overdue periods instead of bursting.
                                long elapsed = Stopwatch.GetTimestamp() - cycle.Next;
                                cycle.Next += (elapsed / cycle.Period + 1) * cycle.Period;
                            }
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
        // Allow a complete maximum-size packet to arrive even at a slow baud rate.
        int bitsPerByte = 1 + current.DataBits + (current.Parity == Parity.None ? 0 : 1)
            + (current.StopBits == StopBits.Two ? 2 : 1);
        var timeout = TimeSpan.FromSeconds(Math.Max(1,
            UartPacket.MaxBytes * bitsPerByte * 3.0 / current.BaudRate));
        int available = Math.Min(current.BytesToRead, 4096);
        byte[] bytes = new byte[available];
        int read = available == 0 ? 0 : current.Read(bytes, 0, bytes.Length);
        var received = packetReader.Feed(bytes.AsSpan(0, read), Stopwatch.GetTimestamp(), timeout);
        foreach (var result in received)
        {
            if (result.Error is not null)
            {
                Record("ERROR", null, null, result.Bytes, result.Error);
                continue;
            }
            byte[] packet = result.Bytes;
            int count = (packet[2] << 8) | packet[3];
            Guid packetId = Guid.NewGuid();
            string packetHex = Hex(packet);
            for (int index = 0; index < count; index++)
            {
                var word = packet.AsSpan(4 + index * 4, 4);
                string label = Convert.ToString(word[0], 8).PadLeft(3, '0');
                Record("RX", label, null, word, null, packetId, packetHex, count, packet[^3]);
            }
        }
    }

    private static string Hex(ReadOnlySpan<byte> bytes) =>
        BitConverter.ToString(bytes.ToArray()).Replace('-', ' ');

    private void Record(string direction, string? label, Guid? id, ReadOnlySpan<byte> bytes,
        string? error, Guid? packetId = null, string? packetHex = null, int? wordCount = null,
        byte? checksum = null)
    {
        if (history.Count == HistoryLimit) history.Dequeue();
        history.Enqueue(new Traffic(++sequence, DateTimeOffset.UtcNow, direction, label, id,
            Hex(bytes), error, packetId, packetHex, wordCount, checksum?.ToString("X2")));
    }

    private void ClosePort()
    {
        cycles.Clear();
        packetReader.Reset();
        var current = port;
        port = null;
        current?.Dispose();
    }

    private void CheckCapacity(double hertz, Guid? replace, bool paused)
    {
        double sum = (paused ? 0 : hertz)
            + cycles.Values.Where(c => c.Id != replace && !c.Paused && !c.Completed)
                .Sum(c => c.Input.Hertz ?? 0);
        ValidateCapacity(sum);
    }

    private void ValidateCapacity(double sum)
    {
        var current = EnsurePort();
        int bitsPerByte = 1 + current.DataBits + (current.Parity == Parity.None ? 0 : 1)
            + (current.StopBits == StopBits.Two ? 2 : 1);
        if (sum * (4 + UartPacket.Overhead) * bitsPerByte >= current.BaudRate)
            throw new ArgumentException("סך תדרי ההודעות, כולל מעטפת UART, גבוה מדי לקצב הפורט.");
    }

    private SerialPort EnsurePort() => port is { IsOpen: true } current
        ? current : throw new InvalidOperationException("התחבר לפורט תחילה.");

    private byte[] Encode(MessageInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        if (input.Label is not { Length: 3 } label || label[0] is < '0' or > '3'
            || label.Any(c => c is < '0' or > '7') || input.Data is < 0 or > 524287
            || input.Sdi is < 0 or > 3 || input.Ssm is < 0 or > 3)
            throw new ArgumentException("בדוק את ה־Label ואת השדות במילה.");

        if (input.Hertz is double hertz && (!double.IsFinite(hertz) || hertz is < 0.1 or > 100))
            throw new ArgumentException("התדר להודעה מחזורית חייב להיות בין 0.1 ל־100 הרץ.");

        if (input.Profile is { Length: > 150 } || input.Editor is { Length: > 100 }
            || input.Editor?.Any(value => value is null || value.Value is null || value.Value.Length > 128) == true)
            throw new ArgumentException("נתוני העורך חורגים מהגודל הנתמך.");

        if (input.Source is not null) _ = new DynamicValueStream(input, catalogue);
        return ArincWord.Encode(label, input.Data, input.Sdi, input.Ssm);
    }

    private sealed class Cycle(Guid id, Guid? planId, MessageInput input, byte[] bytes, long start, bool paused, NumericCatalogue catalogue)
    {
        public Guid Id { get; } = id;
        public Guid? PlanId { get; } = planId;
        public MessageInput Input { get; } = input;
        public byte[] Bytes { get; } = bytes;
        public MessageInput Current { get; set; } = input;
        public DynamicValueStream? Source { get; } = input.Source is null ? null : new(input, catalogue);
        public bool Paused { get; set; } = paused;
        public bool Completed { get; set; }
        public long Period { get; } = input.Hertz is double hz
            ? (long)Math.Round(Stopwatch.Frequency / hz) : 1;
        public long Next { get; set; } = start;
    }

    private sealed record Traffic(long Sequence, DateTimeOffset Time, string Direction,
        string? Label, Guid? CycleId, string Hex, string? Error,
        Guid? PacketId, string? PacketHex, int? WordCount, string? Checksum);
}
