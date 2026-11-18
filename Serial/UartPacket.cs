using System.Buffers.Binary;

namespace BallardWeb.Serial;

internal static class UartPacket
{
    public const int MaxWords = 256;
    public const int Overhead = 7;
    public const int MaxBytes = MaxWords * 4 + Overhead;

    public static byte[] Encode(IReadOnlyList<byte[]> words)
    {
        if (words.Count is < 1 or > MaxWords || words.Any(word => word is null || word.Length != 4))
            throw new ArgumentException("חבילה דורשת בין 1 ל־256 מילים של ארבעה בתים.");
        byte[] packet = new byte[words.Count * 4 + Overhead];
        packet[0] = 0xAA;
        packet[1] = 0x55;
        BinaryPrimitives.WriteUInt16BigEndian(packet.AsSpan(2, 2), checked((ushort)words.Count));
        for (int index = 0; index < words.Count; index++)
            words[index].CopyTo(packet, 4 + index * 4);
        packet[^3] = Checksum(packet.AsSpan(2, packet.Length - 5));
        packet[^2] = 0xAA;
        packet[^1] = 0x55;
        return packet;
    }

    // Sum the two count bytes and the payload bytes, modulo 256.
    public static byte Checksum(ReadOnlySpan<byte> bytes)
    {
        int sum = 0;
        foreach (byte value in bytes) sum += value;
        return (byte)(sum & 0xFF);
    }
}
