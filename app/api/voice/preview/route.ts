import WebSocket from "ws";
import { previewSession, realtimeEndpoint, wavFromPcm16 } from "@/lib/realtime-endpoint";
import { getVoiceSettings, providerLabels, type AiProvider } from "@/lib/voice-agents";

function speak(url: string, headers: Record<string, string>, session: object) {
  return new Promise<{ pcm: Buffer } | { error: string }>((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: { pcm: Buffer } | { error: string }) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* уже закрыт */ }
      resolve(result);
    };
    const socket = new WebSocket(url, { headers, handshakeTimeout: 9000 });
    socket.on("message", (raw) => {
      let event: { type?: string; delta?: string; error?: { message?: string; code?: string } };
      try { event = JSON.parse(raw.toString()); } catch { return; }
      if (event.type === "error") return finish({ error: event.error?.message || event.error?.code || "провайдер отклонил запрос" });
      if (event.type === "session.created") {
        socket.send(JSON.stringify(session));
        setTimeout(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "response.create" })), 400);
        return;
      }
      if (event.type === "response.output_audio.delta" && event.delta) chunks.push(Buffer.from(event.delta, "base64"));
      if (event.type === "response.done") finish(chunks.length ? { pcm: Buffer.concat(chunks) } : { error: "провайдер не вернул звук" });
    });
    socket.on("unexpected-response", (_request, response) => finish({ error: `провайдер ответил ${response.statusCode}` }));
    socket.on("error", (error) => finish({ error: error.message }));
    setTimeout(() => finish(chunks.length ? { pcm: Buffer.concat(chunks) } : { error: "провайдер не ответил за 20 секунд" }), 20000);
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { provider?: string; voice?: string; model?: string; phrase?: string } | null;
  const providers = Object.keys(providerLabels) as AiProvider[];
  const provider = providers.find((item) => item === body?.provider);
  const voice = typeof body?.voice === "string" ? body.voice.trim().slice(0, 80) : "";
  if (!provider || !voice) return Response.json({ error: "Не указан провайдер или голос" }, { status: 400 });
  const phrase = (typeof body?.phrase === "string" && body.phrase.trim() ? body.phrase : "Здравствуйте! Чем могу помочь?").slice(0, 300);
  const endpoint = realtimeEndpoint(provider, await getVoiceSettings(false), typeof body?.model === "string" ? body.model : undefined);
  if ("error" in endpoint) return Response.json({ error: endpoint.error }, { status: 409 });
  const result = await speak(endpoint.url, endpoint.headers, previewSession(provider, voice, phrase, endpoint.rate));
  if ("error" in result) return Response.json({ error: result.error }, { status: 502 });
  return new Response(new Uint8Array(wavFromPcm16(result.pcm, endpoint.rate)), {
    headers: { "content-type": "audio/wav", "cache-control": "no-store" },
  });
}
