import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

type MemoryEntry = { value: number; expiresAt: number };

const memoryCounters = new Map<string, MemoryEntry>();
let clientPromise: Promise<RedisClientType> | null = null;

function redisUrl() {
  const value = process.env.REDIS_URL?.trim() || "";
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error("REDIS_URL обязателен в production");
  }
  return value || "memory://local-development";
}

export function redisKeyPart(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function getRedis(): Promise<RedisClientType | null> {
  const url = redisUrl();
  if (url.startsWith("memory://")) return null;
  if (!clientPromise) {
    const client = createClient({ url });
    client.on("error", (error) => console.error("Redis error:", error.message));
    clientPromise = client.connect().then(() => client as RedisClientType).catch((error) => {
      clientPromise = null;
      throw error;
    });
  }
  return clientPromise;
}

export async function rateLimit(namespace: string, identity: string, limit: number, windowSeconds: number) {
  const key = `ascn:rate:${namespace}:${redisKeyPart(identity || "unknown")}`;
  const client = await getRedis();
  if (client) {
    const count = Number(await client.eval(
      `local count = redis.call('INCR', KEYS[1])
       if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
       return count`,
      { keys: [key], arguments: [String(Math.max(1, Math.round(windowSeconds)))] },
    ));
    return { limited: count > limit, remaining: Math.max(0, limit - count) };
  }

  const now = Date.now();
  const current = memoryCounters.get(key);
  if (!current || current.expiresAt <= now) {
    memoryCounters.set(key, { value: 1, expiresAt: now + windowSeconds * 1000 });
    return { limited: false, remaining: Math.max(0, limit - 1) };
  }
  current.value += 1;
  return { limited: current.value > limit, remaining: Math.max(0, limit - current.value) };
}
