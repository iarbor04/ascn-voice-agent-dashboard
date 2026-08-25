import { tenantRoute } from "@/lib/guard";
import { getVoiceSettings, saveVoiceSettings } from "@/lib/voice-agents";

async function handleGET() {
  return Response.json(await getVoiceSettings());
}

async function handlePUT(request: Request) {
  const body = await request.json().catch(() => null);
  try {
    const gatewayUrl = process.env.VOICE_GATEWAY_INTERNAL_URL?.trim();
    const gatewayKey = process.env.APP_GATEWAY_KEY?.trim();
    if (gatewayUrl && !gatewayKey) return Response.json({ error: "APP_GATEWAY_KEY не настроен" }, { status: 503 });
    const settings = await saveVoiceSettings(body);
    if (gatewayUrl) {
      try {
        const response = await fetch(`${gatewayUrl.replace(/\/$/, "")}/reload`, {
          method: "POST",
          headers: { authorization: `Bearer ${gatewayKey}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`voice gateway вернул ${response.status}`);
      } catch (error) {
        console.error("Asterisk config reload failed", error);
        return Response.json({
          error: "Настройки сохранены, но Asterisk не подтвердил перезагрузку. Повторите сохранение после восстановления gateway.",
          settings,
          reloadPending: true,
        }, { status: 503 });
      }
    }
    return Response.json(settings);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Не удалось сохранить подключение" }, { status: 400 });
  }
}

export const GET = tenantRoute(handleGET);
export const PUT = tenantRoute(handlePUT);
