import { tenantRoute } from "@/lib/guard";
import { destinations, probeDestination } from "@/lib/integrations";
import { serviceAccountEmail } from "@/lib/integrations/sheets";
import { getVoiceSettings } from "@/lib/voice-agents";

// Адрес общего сервисного аккаунта нужен в панели: без него клиент не знает,
// на кого расшаривать таблицу.
async function handleGET() {
  const settings = await getVoiceSettings(false);
  return Response.json({
    serviceAccountEmail: serviceAccountEmail(settings),
    destinations: destinations.map((destination) => ({
      id: destination.id,
      label: destination.label,
      configured: destination.configured(settings),
    })),
  });
}

async function handlePOST(request: Request) {
  const body = await request.json().catch(() => null) as { id?: string } | null;
  const result = await probeDestination(String(body?.id || ""));
  if (!result) return Response.json({ error: "Неизвестная интеграция" }, { status: 400 });
  return Response.json(result);
}

export const GET = tenantRoute(handleGET);
export const POST = tenantRoute(handlePOST);
