import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export type User = { id: string; email: string; passwordHash: string; salt: string; createdAt: string };
type Session = { token: string; userId: string; createdAt: string; expiresAt: string };
type Store = { users: User[]; sessions: Session[] };

const rootDirectory = process.env.DATA_DIR?.trim() || path.join(process.cwd(), ".data");
const storePath = path.join(rootDirectory, "users.json");
const SESSION_DAYS = 30;

let queue = Promise.resolve();

async function readStore(): Promise<Store> {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as Partial<Store>;
    return { users: parsed.users || [], sessions: parsed.sessions || [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { users: [], sessions: [] };
  }
}

async function writeStore(store: Store) {
  await mkdir(rootDirectory, { recursive: true });
  const temporary = `${storePath}.tmp`;
  await writeFile(temporary, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, storePath);
}

function mutate<T>(operation: (store: Store) => T | Promise<T>) {
  const run = queue.catch(() => undefined).then(async () => {
    const store = await readStore();
    const result = await operation(store);
    await writeStore(store);
    return result;
  });
  queue = run.then(() => undefined, () => undefined);
  return run;
}

function normalizeEmail(value: unknown) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 200 ? email : "";
}

async function hashPassword(password: string, salt: string) {
  const derived = await scrypt(password, salt, 64) as Buffer;
  return derived.toString("hex");
}

// Простая защита от перебора: по IP, в памяти процесса. Для одного
// инстанса этого достаточно; при масштабировании нужен общий счётчик.
const attempts = new Map<string, { count: number; resetAt: number }>();
export function rateLimited(ip: string) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 20;
}

export async function registerUser(rawEmail: unknown, password: string) {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new Error("Укажите настоящий адрес почты");
  if (typeof password !== "string" || password.length < 8) throw new Error("Пароль — минимум 8 символов");
  if (password.length > 200) throw new Error("Пароль слишком длинный");
  const salt = randomBytes(16).toString("hex");
  const passwordHash = await hashPassword(password, salt);
  return mutate((store) => {
    if (store.users.some((user) => user.email === email)) throw new Error("Такая почта уже зарегистрирована — войдите");
    const user: User = { id: crypto.randomUUID(), email, passwordHash, salt, createdAt: new Date().toISOString() };
    store.users.push(user);
    return user;
  });
}

export async function verifyUser(rawEmail: unknown, password: string) {
  const email = normalizeEmail(rawEmail);
  if (!email || typeof password !== "string") return null;
  const store = await readStore();
  const user = store.users.find((item) => item.email === email);
  // Хэш считаем и для несуществующего пользователя, чтобы по времени ответа
  // нельзя было понять, зарегистрирована ли почта.
  const salt = user?.salt || "0".repeat(32);
  const hash = await hashPassword(password, salt);
  if (!user) return null;
  const a = Buffer.from(hash);
  const b = Buffer.from(user.passwordHash);
  return a.length === b.length && timingSafeEqual(a, b) ? user : null;
}

export function createSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  return mutate((store) => {
    // Заодно чистим протухшие сессии, отдельного уборщика не нужно.
    store.sessions = store.sessions.filter((session) => Date.parse(session.expiresAt) > now);
    store.sessions.push({
      token,
      userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_DAYS * 86400000).toISOString(),
    });
    return token;
  });
}

export async function sessionUser(token: string) {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const store = await readStore();
  const session = store.sessions.find((item) => item.token === token);
  if (!session || Date.parse(session.expiresAt) < Date.now()) return null;
  return store.users.find((user) => user.id === session.userId) || null;
}

export function destroySession(token: string) {
  return mutate((store) => {
    store.sessions = store.sessions.filter((session) => session.token !== token);
    return true;
  });
}
