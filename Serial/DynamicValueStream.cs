using BallardWeb.Api;
using System.Security.Cryptography;

namespace BallardWeb.Serial;

internal sealed class DynamicValueStream
{
    private readonly MessageInput input;
    private readonly DataSource source;
    private readonly NumericField field;
    private readonly long minimum, maximum, start, increment;
    private long position;
    private decimal? pending;
    public decimal? LastValue { get; private set; }

    public DynamicValueStream(MessageInput input, NumericCatalogue catalogue)
    {
        this.input = input;
        source = input.Source ?? throw new ArgumentException("חסר מקור נתונים.");
        if (input.Hertz is null) throw new ArgumentException("מקור משתנה דורש שידור מחזורי.");
        field = catalogue.Get(input.Profile, source.Field);
        if (input.Label != input.Profile?.Split('|')[0][..3]) throw new ArgumentException("Label אינו תואם לפרופיל.");
        if (source.Mode is not ("ramp" or "triangle" or "sine" or "random" or "sequence"))
            throw new ArgumentException("סוג שינוי לא מוכר.");
        minimum = field.Tick(source.Minimum);
        maximum = field.Tick(source.Maximum);
        if (minimum > maximum) throw new ArgumentException("המינימום גדול מהמקסימום.");
        start = field.Tick(source.Start);
        if (source.Mode is "ramp" or "triangle")
        {
            if (start < minimum || start > maximum) throw new ArgumentException("ערך ההתחלה מחוץ לטווח.");
            if (source.Increment == 0 || Math.Abs(source.Increment) > field.Maximum - field.Minimum)
                throw new ArgumentException("השינוי חייב להיות לא אפסי ובתוך רוחב טווח השדה.");
            decimal ticks = source.Increment / field.Step;
            if (ticks != Math.Round(ticks) || ticks == 0 || Math.Abs(ticks) > maximum - minimum)
                throw new ArgumentException("השינוי חייב להיות צעד לא אפסי התואם לרזולוציה ולטווח.");
            increment = (long)ticks;
        }
        if (source.Mode == "sine" && (source.SamplesPerPeriod is < 4 or > 1000000))
            throw new ArgumentException("מספר דגימות למחזור סינוס חייב להיות בין 4 ל־1,000,000.");
        if (source.Mode == "sequence")
        {
            if (source.Values is not { Length: > 0 and <= 4096 })
                throw new ArgumentException("הרשימה חייבת להכיל בין 1 ל־4096 ערכים.");
            foreach (decimal value in source.Values)
                if (field.Tick(value) < minimum || field.Tick(value) > maximum)
                    throw new ArgumentException("ערך ברשימה מחוץ לטווח שנבחר.");
        }
    }

    public MessageInput Current()
    {
        pending ??= Generate();
        long ticks = field.Tick(pending.Value);
        uint encoded = field.Encoding switch
        {
            "bcd" => Bcd(ticks) << field.Shift << (field.First - 9),
            "adf" => ((Bcd((long)decimal.Floor(pending.Value)) << 4)
                | ((uint)((long)(pending.Value * 2) % 2) << 3)) << 2,
            _ => unchecked((uint)ticks) << (field.First - 9)
        };
        uint mask = ((1u << field.Width) - 1) << (field.First - 9);
        uint previous = ((uint)input.Data << 2) | (uint)input.Sdi;
        uint combined = (previous & ~mask) | (encoded & mask);
        return input with { Data = (int)(combined >> 2), Sdi = (int)(combined & 3), Source = null };
    }

    // Called only after the complete packet was successfully written.
    public void Advance()
    {
        LastValue = pending;
        pending = null;
        position = position == long.MaxValue ? 0 : position + 1;
    }

    private decimal Generate()
    {
        if (source.Mode == "sequence") return source.Values![(int)(position % source.Values.Length)];
        if (source.Mode == "random") return RandomNumberGenerator.GetInt32((int)minimum, checked((int)maximum + 1)) * field.Step;
        if (source.Mode == "sine")
        {
            double phase = 2 * Math.PI * (position % source.SamplesPerPeriod) / source.SamplesPerPeriod;
            decimal ticks = minimum + (maximum - minimum) * (decimal)((1 + Math.Sin(phase)) / 2);
            return Math.Clamp(Math.Round(ticks, 0, MidpointRounding.AwayFromZero), minimum, maximum) * field.Step;
        }
        if (source.Mode == "ramp")
        {
            long firstRun = increment > 0 ? (maximum - start) / increment + 1 : (start - minimum) / -increment + 1;
            if (position < firstRun) return (start + position * increment) * field.Step;
            long origin = increment > 0 ? minimum : maximum;
            long length = (maximum - minimum) / Math.Abs(increment) + 1;
            return (origin + ((position - firstRun) % length) * increment) * field.Step;
        }
        long range = maximum - minimum;
        if (range == 0) return minimum * field.Step;
        decimal travel = (decimal)position * increment + (start - minimum);
        decimal phaseTicks = ((travel % (2 * range)) + 2 * range) % (2 * range);
        return (minimum + (phaseTicks <= range ? phaseTicks : 2 * range - phaseTicks)) * field.Step;
    }

    private static uint Bcd(long value)
    {
        uint result = 0;
        for (int shift = 0; value > 0; shift += 4, value /= 10)
            result |= (uint)(value % 10) << shift;
        return result;
    }
}
