using System.Buffers.Binary;
using System.Numerics;

namespace BallardWeb.Arinc;

internal static class ArincWord
{
    public static bool HasOddParity(ReadOnlySpan<byte> bytes) => bytes.Length == 4
        && BitOperations.PopCount(BinaryPrimitives.ReadUInt32LittleEndian(bytes)) % 2 == 1;

    public static byte[] Encode(string label, int data, int sdi, int ssm)
    {
        uint word = (uint)Convert.ToInt32(label, 8) | ((uint)sdi << 8)
            | ((uint)data << 10) | ((uint)ssm << 29);

        if (BitOperations.PopCount(word) % 2 == 0)
            word |= 1u << 31;

        var bytes = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(bytes, word);
        return bytes;
    }
}
