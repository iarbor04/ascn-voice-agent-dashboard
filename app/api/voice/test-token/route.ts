import { createHmac } from "node:crypto";
import { getVoiceAgent } from "@/lib/voice-agents";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { agentId?: string } | null;
  const secret = process.env.INTERNAL_API_KEY?.trim();
  if (!secret) return Response.json({ error: "INTERNAL_API_KEY не настроен" }, { status: 503 });
  const agent = body?.agentId ? await getVoiceAgent(body.agentId) : null;
  if (!agent) return Response.json({ error: "Голосовой агент не найден" }, { status: 404 });
  const expiresAt = Math.floor(Date.now() / 1000) + 120;
  const payload = `${agent.id}.${expiresAt}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return Response.json({ token: `${payload}.${signature}`, expiresAt });
}
