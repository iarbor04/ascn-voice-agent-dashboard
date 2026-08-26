import { deleteCampaign, getCampaign, updateCampaignState } from "@/lib/campaigns";
import { tenantRoute } from "@/lib/guard";
import { resolveOutboundRoute } from "@/lib/voice-agents";

async function handleGET(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const campaign = await getCampaign(id);
  return campaign ? Response.json({ campaign }) : Response.json({ error: "Кампания не найдена" }, { status: 404 });
}

async function handlePATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null) as { action?: string } | null;
  const action = body?.action;
  if (!action || !["start", "pause", "resume", "retry_failed"].includes(action)) {
    return Response.json({ error: "Неизвестное действие" }, { status: 400 });
  }
  try {
    const existing = await getCampaign(id);
    if (!existing) return Response.json({ error: "Кампания не найдена" }, { status: 404 });
    if (action !== "pause") {
      const { agent, connection } = await resolveOutboundRoute(existing.agentId, existing.connectionId);
      if (!agent?.active) return Response.json({ error: "Агент кампании не найден или выключен" }, { status: 409 });
      if (!connection || connection.id !== existing.connectionId) return Response.json({ error: "SIP-подключение кампании выключено или не настроено" }, { status: 409 });
    }
    return Response.json({ campaign: await updateCampaignState(id, action as "start" | "pause" | "resume" | "retry_failed") });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось изменить кампанию" }, { status: 409 });
  }
}

async function handleDELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return await deleteCampaign(id)
    ? Response.json({ ok: true })
    : Response.json({ error: "Остановите кампанию перед удалением" }, { status: 409 });
}

export const GET = tenantRoute(handleGET);
export const PATCH = tenantRoute(handlePATCH);
export const DELETE = tenantRoute(handleDELETE);
