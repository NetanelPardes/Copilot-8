using System.Diagnostics;

namespace BallardWeb.Serial;

internal sealed record PacketRead(byte[] Bytes, string? Error);

// UART is a byte stream: a read can contain a partial packet or several packets.
internal sealed class UartPacketReader
{
    private readonly List<byte> buffer = [];
    private long lastReceived;

    public void Reset() => buffer.Clear();

    public List<PacketRead> Feed(ReadOnlySpan<byte> bytes, long now, TimeSpan timeout)
    {
        var results = Expire(now, timeout);
        if (bytes.IsEmpty) return results;
        // Feed bounded chunks even if the caller supplies a large block.
        while (!bytes.IsEmpty)
        {
            int length = Math.Min(bytes.Length, UartPacket.MaxBytes);
            foreach (byte value in bytes[..length]) buffer.Add(value);
            bytes = bytes[length..];
            lastReceived = now;
            Drain(results);
        }
        return results;
    }

    public List<PacketRead> Expire(long now, TimeSpan timeout)
    {
        var results = new List<PacketRead>();
        if (buffer.Count > 0 && Stopwatch.GetElapsedTime(lastReceived, now) >= timeout)
        {
            results.Add(new PacketRead(buffer.ToArray(), "תם זמן ההמתנה להשלמת חבילת UART."));
            // All buffered candidates have expired. Keep seeking complete valid packets
            // behind a corrupt/truncated header instead of dropping the entire buffer.
            while (buffer.Count > 0)
            {
                buffer.RemoveAt(0);
                Drain(results);
            }
        }
        return results;
    }

    private void Drain(List<PacketRead> results)
    {
        while (buffer.Count > 0)
        {
            int header = -1;
            for (int index = 0; index + 1 < buffer.Count; index++)
            {
                if (buffer[index] == 0xAA && buffer[index + 1] == 0x55)
                {
                    header = index;
                    break;
                }
            }
            if (header != 0)
            {
                int discarded = header >= 0 ? header : buffer.Count - (buffer[^1] == 0xAA ? 1 : 0);
                if (discarded > 0)
                {
                    results.Add(new PacketRead(buffer.GetRange(0, discarded).ToArray(),
                        "נזרקו בתים מחוץ לחבילת UART תקינה."));
                    buffer.RemoveRange(0, discarded);
                }
                if (header < 0) return;
            }
            if (buffer.Count < 4) return;
            int count = (buffer[2] << 8) | buffer[3];
            if (count is < 1 or > UartPacket.MaxWords)
            {
                results.Add(new PacketRead(buffer.GetRange(0, 4).ToArray(), "כמות מילים לא תקינה בחבילה."));
                buffer.RemoveAt(0);
                continue;
            }
            int length = count * 4 + UartPacket.Overhead;
            if (buffer.Count < length) return;
            byte[] packet = buffer.GetRange(0, length).ToArray();
            string? error = packet[^2] != 0xAA || packet[^1] != 0x55
                ? "סימן הסיום אינו תקין."
                : UartPacket.Checksum(packet.AsSpan(2, length - 5)) != packet[^3]
                    ? "Checksum של החבילה אינו תואם." : null;
            results.Add(new PacketRead(packet, error));
            if (error is null) buffer.RemoveRange(0, length);
            else buffer.RemoveAt(0); // Seek the next candidate without trusting a corrupt count.
        }
    }
}
