using System.Text.Json;
using BallardWeb.Api;
using System.Text.RegularExpressions;

namespace BallardWeb.Serial;

internal sealed record NumericField(string Id, string Title, decimal Minimum, decimal Maximum,
    decimal Step, int First, int Width, string Encoding, int Shift = 0)
{
    public long Tick(decimal value)
    {
        if (value < Minimum || value > Maximum)
            throw new ArgumentException($"{Title}: הערך מחוץ לטווח {Minimum} עד {Maximum}.");
        decimal tick = Math.Round(value / Step, 0, MidpointRounding.AwayFromZero);
        if (Math.Abs(value - tick * Step) > Step / 1000000)
            throw new ArgumentException($"{Title}: הערך חייב להיות בטווח {Minimum} עד {Maximum}, בצעדים של {Step}.");
        return checked((long)tick);
    }
    public decimal Decode(int data, int sdi)
    {
        uint combined = ((uint)data << 2) | (uint)sdi;
        uint raw = (combined >> (First - 9)) & ((1u << Width) - 1);
        decimal value;
        if (Encoding == "adf")
            value = ReadBcd(raw >> 1) + ((raw & 1) == 0 ? 0m : .5m);
        else if (Encoding == "bcd")
        {
            if ((raw & ((1u << Shift) - 1)) != 0)
                throw new ArgumentException("ביטי ריפוד BCD אינם אפס.");
            value = ReadBcd(raw >> Shift) * Step;
        }
        else
        {
            long ticks = raw;
            if (Minimum < 0 && (raw & (1u << (Width - 1))) != 0)
                ticks -= 1L << Width;
            value = ticks * Step;
        }
        Tick(value);
        return value;
    }

    private static long ReadBcd(uint raw)
    {
        long result = 0, multiplier = 1;
        while (raw != 0)
        {
            uint digit = raw & 15;
            if (digit > 9) throw new ArgumentException("ספרת BCD אינה תקינה.");
            result += digit * multiplier;
            multiplier *= 10;
            raw >>= 4;
        }
        return result;
    }

}

internal sealed class NumericCatalogue
{
    public Dictionary<string, NumericField[]> Fields { get; } = [];
    private readonly Dictionary<string, string> codes = [];

    public NumericCatalogue(string root)
    {
        using var json = JsonDocument.Parse(File.ReadAllText(Path.Combine(root, "wwwroot", "labels.json")));
        foreach (var label in json.RootElement.EnumerateArray())
        {
            string code = label.GetProperty("code").GetString()!;
            string[] equipment = label.GetProperty("equipment").EnumerateArray().Select(e => e.GetString()!).ToArray();
            string section = label.GetProperty("section").GetString()!;
            string page = label.GetProperty("page").ToString();
            string key = string.Join("|", code, string.Join(",", equipment), section, page);
            codes.TryAdd(key, code[..3]);
            var fields = new List<NumericField>();
            if (label.TryGetProperty("numericBnr", out var bnr))
            {
                int first = bnr.GetProperty("first").GetInt32();
                decimal step = bnr.GetProperty("step").GetDecimal();
                fields.Add(new("numeric", bnr.GetProperty("title").GetString()!,
                    bnr.GetProperty("minTick").GetDecimal() * step,
                    bnr.GetProperty("maxTick").GetDecimal() * step, step, first, 30 - first, "binary"));
            }
            else if (section == "3.1" && equipment.Length == 1)
            {
                string eq = equipment[0];
                NumericField? numeric = code switch
                {
                    "001" when eq is "02" or "09" => new("numeric", "מרחק ליעד במיילים ימיים", 0, 3999.9m, .1m, 11, 19, "bcd"),
                    "002" when eq is "02" or "09" => new("numeric", "זמן ליעד בדקות", 0, 399.9m, .1m, 11, 19, "bcd", 4),
                    "012" when eq is "02" or "09" => new("numeric", "מהירות קרקע בקשרים", 0, 7999.9m, .1m, 11, 19, "bcd"),
                    "017" when eq == "10" => new("numeric", "כיוון מסלול במעלות", 0, 359.9m, .1m, 11, 19, "bcd", 4),
                    "210" when eq == "02" => new("numeric", "מהירות אוויר אמיתית בקשרים", 0, 2047.9375m, .0625m, 14, 16, "binary"),
                    "327G" when eq == "02" => new("numeric", "קנה מידה אנכי ברגל", -2048, 2047.9375m, .0625m, 14, 16, "binary"),
                    "032" when eq is "02" or "12" => new("numeric", "תדר ADF בקילוהרץ", 190, 1750, .5m, 14, 16, "adf"),
                    _ => null
                };
                if (numeric is not null) fields.Add(numeric);
            }
            if (fields.Count == 0 && label.TryGetProperty("fields", out var raw)
                && StandardEnvelope(raw)
                && !Regex.IsMatch(label.TryGetProperty("note", out var note) ? note.GetString() ?? "" : "",
                    "PRIVATE USE|USER DEFINED|PER GAMA|PER A429", RegexOptions.IgnoreCase))
            {
                foreach (var field in raw.EnumerateArray())
                {
                    int first = field.GetProperty("first").GetInt32(), last = field.GetProperty("last").GetInt32();
                    string name = field.GetProperty("name").GetString()!;
                    if (first < 11 || last > 29 || Regex.IsMatch(name,
                        @"^SPARES?\b|\bRESERVED\b|\bPAD ZERO\b|\bALWAYS ZERO\b", RegexOptions.IgnoreCase)) continue;
                    int width = last - first + 1;
                    int max = (1 << width) - 1;
                    if (Regex.IsMatch(name, @"^(THOUSANDTHS|HUNDREDTHS|TENTHS|UNITS|TENS|HUNDREDS|THOUSANDS) OF\b", RegexOptions.IgnoreCase))
                        max = Math.Min(max, 9);
                    fields.Add(new($"bits:{first}:{last}", $"ביטים {first}–{last} · {name}", 0, max, 1, first, width, "binary"));
                }
            }
            if (fields.Count > 0) Fields.TryAdd(key, fields.ToArray());
        }
    }

    public NumericField Get(string? profile, string? fieldId)
    {
        if (profile is null || !Fields.TryGetValue(profile, out var fields)
            || fields.FirstOrDefault(f => f.Id == fieldId) is not { } field)
            throw new ArgumentException("אין הגדרת שדה מספרי מאומתת למקור הנתונים שבחרת.");
        return field;
    }

    public void Validate(MessageInput input)
    {
        if (string.IsNullOrEmpty(input.Profile)) return; // Existing raw diagnostic API input.
        if (!codes.TryGetValue(input.Profile, out var code) || code != input.Label)
            throw new ArgumentException("פרופיל הציוד אינו תואם ל־Label.");
        if (!Fields.TryGetValue(input.Profile, out var fields)) return;
        foreach (var field in fields) field.Decode(input.Data, input.Sdi);
    }

    private static bool StandardEnvelope(JsonElement raw)
    {
        var fields = raw.EnumerateArray().ToArray();
        var bits = fields.SelectMany(f => Enumerable.Range(f.GetProperty("first").GetInt32(),
            f.GetProperty("last").GetInt32() - f.GetProperty("first").GetInt32() + 1));
        bool Match(int first, int last, string pattern) => fields.Any(f =>
            f.GetProperty("first").GetInt32() == first && f.GetProperty("last").GetInt32() == last
            && Regex.IsMatch(f.GetProperty("name").GetString()!, pattern, RegexOptions.IgnoreCase));
        return bits.SequenceEqual(Enumerable.Range(1, 32)) && Match(1, 8, "LABEL")
            && Match(9, 10, "^SDI") && Match(30, 31, @"SSM|SIGN\s*/\s*STATUS MATRIX") && Match(32, 32, "PARITY");
    }
}
