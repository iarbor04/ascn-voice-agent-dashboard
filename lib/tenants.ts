import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { QueryResultRow } from "pg";
import { databaseQuery, databaseTransaction, hashSessionToken } from "./db.ts";

const scrypt = promisify(scryptCallback);
const SESSION_DAYS = 30;

export type User = { id: string; email: string; passwordHash: string; salt: string; createdAt: string };

interface UserRow extends QueryResultRow {
  id: string;
  email: string;
  password_hash: string;
  salt: string;
  created_at: Date | string;
}

function isoTimestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function userFromRow(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    salt: row.salt,
    createdAt: isoTimestamp(row.created_at),
  };
}

function normalizeEmail(value: unknown) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 200 ? email : "";
}

async function hashPassword(password: string, salt: string) {
  const derived = await scrypt(password, salt, 64) as Buffer;
  return derived.toString("hex");
}

export async function registerUser(rawEmail: unknown, password: string) {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new Error("Укажите настоящий адрес почты");
  if (typeof password !== "string" || password.length < 8) throw new Error("Пароль — минимум 8 символов");
  if (password.length > 200) throw new Error("Пароль слишком длинный");

  const salt = randomBytes(16).toString("hex");
  const passwordHash = await hashPassword(password, salt);
  const user: User = {
    id: crypto.randomUUID(),
    email,
    passwordHash,
    salt,
    createdAt: new Date().toISOString(),
  };

  try {
    const result = await databaseQuery<UserRow>(
      `INSERT INTO ascn_users (id, email, password_hash, salt, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, password_hash, salt, created_at`,
      [user.id, user.email, user.passwordHash, user.salt, user.createdAt],
    );
    return userFromRow(result.rows[0]);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new Error("Такая почта уже зарегистрирована — войдите");
    }
    throw error;
  }
}

export async function verifyUser(rawEmail: unknown, password: string) {
  const email = normalizeEmail(rawEmail);
  if (!email || typeof password !== "string") return null;

  const result = await databaseQuery<UserRow>(
    `SELECT id, email, password_hash, salt, created_at
     FROM ascn_users
     WHERE lower(email) = $1
     LIMIT 1`,
    [email],
  );
  const row = result.rows[0];
  // Хэш считаем и для несуществующего пользователя, чтобы по времени ответа
  // нельзя было понять, зарегистрирована ли почта.
  const salt = row?.salt || "0".repeat(32);
  const hash = await hashPassword(password, salt);
  if (!row) return null;
  const actual = Buffer.from(hash, "hex");
  const expected = Buffer.from(row.password_hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? userFromRow(row) : null;
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  await databaseTransaction(async (client) => {
    await client.query("DELETE FROM ascn_sessions WHERE expires_at <= now()");
    await client.query(
      `INSERT INTO ascn_sessions (token_hash, user_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [hashSessionToken(token), userId, now, expiresAt],
    );
  });
  return token;
}

export async function createAdminSession() {
  const email = (process.env.ADMIN_USERNAME || "admin").trim();
  await databaseQuery(
    `INSERT INTO ascn_users (id, email, password_hash, salt, created_at)
     VALUES ('default', $1, repeat('0', 128), repeat('0', 32), now())
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
    [email],
  );
  return createSession("default");
}

export async function sessionUser(token: string) {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const result = await databaseQuery<UserRow>(
    `SELECT u.id, u.email, u.password_hash, u.salt, u.created_at
     FROM ascn_sessions s
     JOIN ascn_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()
     LIMIT 1`,
    [hashSessionToken(token)],
  );
  return result.rows[0] ? userFromRow(result.rows[0]) : null;
}

export async function destroySession(token: string) {
  if (/^[0-9a-f]{64}$/.test(token)) {
    await databaseQuery("DELETE FROM ascn_sessions WHERE token_hash = $1", [hashSessionToken(token)]);
  }
  return true;
}
