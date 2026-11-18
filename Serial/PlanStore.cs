using System.Text.Json;
using BallardWeb.Api;

namespace BallardWeb.Serial;

internal sealed record PlanItem(Guid Id, MessageInput Input, bool Paused);
internal sealed record SendPlan(Guid Id, string Name, DateTimeOffset CreatedAt,
    long Revision, PlanItem[] Items);

// Accessed only while UartBoard holds its gate.
internal sealed class PlanStore
{
    private readonly string path;
    private readonly JsonSerializerOptions options = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    public SendPlan[] Plans { get; private set; }
    private int nextNumber = 1;
    private sealed record PlanDocument(int NextNumber, SendPlan[] Plans);

    public PlanStore(string contentRoot)
    {
        path = Path.Combine(contentRoot, "Data", "send-plans.json");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        Plans = [];
        if (File.Exists(path))
        {
            string json = File.ReadAllText(path);
            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind == JsonValueKind.Array)
            {
                Plans = JsonSerializer.Deserialize<SendPlan[]>(json, options)
                    ?? throw new InvalidDataException("קובץ התוכניות אינו תקין.");
                for (int index = 0; index < Plans.Length; index++)
                    Plans[index] = Plans[index] with { Name = "Plan " + (index + 1) };
                nextNumber = Plans.Length + 1;
            }
            else
            {
                var saved = JsonSerializer.Deserialize<PlanDocument>(json, options)
                    ?? throw new InvalidDataException("קובץ התוכניות אינו תקין.");
                Plans = saved.Plans ?? throw new InvalidDataException("חסרה רשימת תוכניות.");
                nextNumber = saved.NextNumber;
                if (nextNumber < 1) throw new InvalidDataException("מספור תוכניות אינו תקין.");
            }
        }
        if (Plans.Any(p => p is null || p.Items is null || p.Revision < 1)
            || Plans.Select(p => p.Id).Distinct().Count() != Plans.Length
            || Plans.SelectMany(p => p.Items).Any(i => i is null || i.Input is null)
            || Plans.SelectMany(p => p.Items).Select(i => i.Id).Distinct().Count()
                != Plans.Sum(p => p.Items.Length))
            throw new InvalidDataException("קובץ התוכניות אינו תקין.");
    }

    public SendPlan Get(Guid id, long revision)
    {
        var plan = Plans.FirstOrDefault(p => p.Id == id)
            ?? throw new KeyNotFoundException("התוכנית לא נמצאה.");
        if (plan.Revision != revision)
            throw new InvalidOperationException("התוכנית השתנתה בחלון אחר. רענן ונסה שוב.");
        return plan;
    }

    public SendPlan Create(MessageInput? input = null)
    {
        var created = DateTimeOffset.Now;
        PlanItem[] items = input is null ? [] : [new(Guid.NewGuid(), input, false)];
        var plan = new SendPlan(Guid.NewGuid(), "Plan " + nextNumber, created, 1, items);
        Commit(Plans.Append(plan).ToArray(), checked(nextNumber + 1));
        return plan;
    }

    public void Save(SendPlan plan) => Commit(Plans.Select(p => p.Id == plan.Id
        ? plan with { Revision = plan.Revision + 1 } : p).ToArray());

    public void Delete(Guid id, long revision)
    {
        Get(id, revision);
        Commit(Plans.Where(p => p.Id != id).ToArray());
    }

    private void Commit(SendPlan[] updated, int? updatedNumber = null)
    {
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write))
            {
                JsonSerializer.Serialize(file, new PlanDocument(updatedNumber ?? nextNumber, updated), options);
                file.Flush(flushToDisk: true);
            }
            File.Move(temporary, path, overwrite: true);
            Plans = updated;
            nextNumber = updatedNumber ?? nextNumber;
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }
}
