import { databaseQuery } from "@/lib/db";
import { getRedis } from "@/lib/redis";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const redis = await getRedis();
    await Promise.all([
      databaseQuery("SELECT 1"),
      redis ? redis.ping() : Promise.resolve("PONG"),
    ]);
    return Response.json({ status: "ok" });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
