import { parseCampaignCsv } from "@/lib/campaign-csv";
import { createCampaign, listCampaigns } from "@/lib/campaigns";
import { tenantRoute } from "@/lib/guard";
import { resolveOutboundRoute } from "@/lib/voice-agents";

async function handleGET() {
  return Response.json({ campaigns: await listCampaigns() });
}

async function handlePOST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) return Response.json({ error: "Выберите CSV-файл" }, { status: 400 });
    if (file.size > 2_000_000) return Response.json({ error: "CSV-файл больше 2 МБ" }, { status: 413 });
    const name = String(form.get("name") || "");
    const agentId = String(form.get("agentId") || "");
    const connectionId = String(form.get("connectionId") || "");
    const purposeTemplate = String(form.get("purposeTemplate") || "");
    const intervalSeconds = Number(form.get("intervalSeconds"));
    const { agent, connection } = await resolveOutboundRoute(agentId, connectionId);
    if (!agent || agent.id !== agentId) return Response.json({ error: "Выберите существующего голосового агента" }, { status: 400 });
    if (!agent.active) return Response.json({ error: "Выбранный агент выключен" }, { status: 409 });
    if (!connection || connection.id !== connectionId) return Response.json({ error: "Выберите активное SIP-подключение с сохранённым паролем" }, { status: 409 });
    const parsed = parseCampaignCsv(await file.text(), purposeTemplate);
    const campaign = await createCampaign({ name, agentId, connectionId, purposeTemplate, intervalSeconds, recipients: parsed.recipients });
    return Response.json({ campaign, import: { imported: parsed.recipients.length, invalid: parsed.invalid, duplicates: parsed.duplicates } }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось создать кампанию" }, { status: 400 });
  }
}

export const GET = tenantRoute(handleGET);
export const POST = tenantRoute(handlePOST);
