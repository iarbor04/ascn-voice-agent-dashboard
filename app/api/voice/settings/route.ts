import { tenantRoute } from "@/lib/guard";
import { getVoiceSettings, saveVoiceSettings } from "@/lib/voice-agents";

async function handleGET() {
  return Response.json(await getVoiceSettings());
}

async function handlePUT(request: Request) {
  const body = await request.json().catch(() => null);
  try {
    const settings = await saveVoiceSettings(body);
    const gatewayUrl = process.env.VOICE_GATEWAY_INTERNAL_URL?.trim();
    if (gatewayUrl) await fetch(`${gatewayUrl.replace(/\/$/, "")}/reload`, { method: "POST", headers: { authorization: `Bearer ${process.env.INTERNAL_API_KEY?.trim() || ""}` }, signal: AbortSignal.timeout(3000) }).catch(() => undefined);
    return Response.json(settings);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось сохранить подключение" }, { status: 400 });
  }
}

export const GET = tenantRoute(handleGET);
export const PUT = tenantRoute(handlePUT);
