import { getVoiceSettings, saveVoiceSettings } from "@/lib/voice-agents";

export async function GET() {
  return Response.json(await getVoiceSettings());
}

export async function PUT(request: Request) {
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
