import { parseCampaignCsv } from "@/lib/campaign-csv";
import { tenantRoute } from "@/lib/guard";

const PREVIEW_ROWS = 50;

// Разбор идёт тем же парсером, что и создание кампании: превью не может
// расходиться с тем, что реально загрузится.
async function handlePOST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) return Response.json({ error: "Выберите CSV-файл" }, { status: 400 });
    if (file.size > 2_000_000) return Response.json({ error: "CSV-файл больше 2 МБ" }, { status: 413 });
    const purposeTemplate = String(form.get("purposeTemplate") || "");
    const parsed = parseCampaignCsv(await file.text(), purposeTemplate);
    const extraKeys = [...new Set(parsed.recipients.flatMap((recipient) => Object.keys(recipient.variables)))]
      .filter((key) => key !== "caller_name" && key !== "caller_purpose");
    return Response.json({
      total: parsed.recipients.length,
      invalid: parsed.invalid,
      duplicates: parsed.duplicates,
      extraKeys,
      rows: parsed.recipients.slice(0, PREVIEW_ROWS).map((recipient) => ({
        phone: recipient.phone,
        name: recipient.name,
        purpose: recipient.variables.caller_purpose || "",
        extra: Object.fromEntries(extraKeys.map((key) => [key, recipient.variables[key] || ""])),
      })),
      shown: Math.min(parsed.recipients.length, PREVIEW_ROWS),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось разобрать CSV" }, { status: 400 });
  }
}

export const POST = tenantRoute(handlePOST);
