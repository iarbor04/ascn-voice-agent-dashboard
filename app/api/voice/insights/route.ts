import { listCallRecords } from "@/lib/calls";
import { aggregateCalls } from "@/lib/insights";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 7));
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000).toISOString();
  const agentId = url.searchParams.get("agentId") || "";
  const everything = await listCallRecords();
  const all = agentId ? everything.filter((call) => call.agentId === agentId) : everything;
  const calls = all.filter((call) => call.createdAt >= from && call.createdAt <= to.toISOString());
  return Response.json({ days, from, to: to.toISOString(), ...aggregateCalls(calls, all) });
}
