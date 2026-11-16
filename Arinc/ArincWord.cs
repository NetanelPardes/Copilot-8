using System.Buffers.Binary;
using System.Numerics;

namespace BallardWeb.Arinc;

internal static class ArincWord
{
    public static byte[] Encode(string? label, int data, int sdi, int ssm)
    {
        if (label is not { Length: 3 } || label[0] is < '0' or > '3' ||
            label.Any(digit => digit is < '0' or > '7'))
            throw new ArgumentException("הזן Label באוקטלי בין 000 ל־377.");

        if (data is < 0 or > 0x7FFFF || sdi is < 0 or > 3 || ssm is < 0 or > 3)
            throw new ArgumentException("Data, SDI או SSM מחוץ לטווח.");

        uint word = (uint)Convert.ToInt32(label, 8)
            | ((uint)sdi << 8)
            | ((uint)data << 10)
            | ((uint)ssm << 29);

        if (BitOperations.PopCount(word) % 2 == 0)
            word |= 1u << 31;

        // UART byte 1 contains bits 1–8, the label.
        var bytes = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(bytes, word);
        return bytes;
    }
}