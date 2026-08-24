import WebSocket from "ws";
import { realtimeEndpoint } from "@/lib/realtime-endpoint";
import { getVoiceSettings, providerLabels, type AiProvider } from "@/lib/voice-agents";

function openSession(probe: { url: string; headers: Record<string, string> }) {
  return new Promise<{ ok: boolean; detail: string }>((resolve) => {
    let settled = false;
    const finish = (ok: boolean, detail: string) => { if (settled) return; settled = true; try { socket.close(); } catch { /* уже закрыт */ } resolve({ ok, detail }); };
    const socket = new WebSocket(probe.url, { headers: probe.headers, handshakeTimeout: 9000 });
    socket.on("message", (raw) => {
      let event: { type?: string; error?: { message?: string; code?: string; type?: string } };
      try { event = JSON.parse(raw.toString()); } catch { return; }
      if (event.type === "ping") return;
      if (event.type === "error") {
        const reason = event.error?.message || event.error?.code || event.error?.type || "провайдер отклонил сессию";
        return finish(false, `Ключ не принят: ${String(reason).slice(0, 180)}`);
      }
      if (event.type === "session.created" || event.type === "session.updated") return finish(true, "Realtime-сессия открыта, ключ работает");
      finish(true, `Сессия отвечает (${event.type || "без типа"})`);
    });
    socket.on("unexpected-response", (_request, response) => {
      const status = response.statusCode || 0;
      const hint = status === 401 || status === 403 ? "ключ не принят или нет доступа к realtime" : status === 404 ? "модель недоступна для этого ключа" : "провайдер отклонил подключение";
      finish(false, `Провайдер ответил ${status} — ${hint}`);
    });
    socket.on("error", (error) => finish(false, `Не удалось подключиться: ${error.message}`));
    socket.on("close", () => finish(false, "Провайдер закрыл соединение, не открыв сессию"));
    setTimeout(() => finish(false, "Провайдер не ответил за 12 секунд"), 12000);
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { provider?: string } | null;
  const providers = Object.keys(providerLabels) as AiProvider[];
  const provider = providers.find((item) => item === body?.provider);
  if (!provider) return Response.json({ error: "Неизвестный провайдер" }, { status: 400 });
  const probe = realtimeEndpoint(provider, await getVoiceSettings(false));
  if ("error" in probe) return Response.json({ ok: false, detail: probe.error });
  return Response.json({ provider, ...(await openSession(probe)) });
}
