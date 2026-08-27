import { timingSafeEqual } from "node:crypto";

function equal(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function verifyAdmin(headers: Headers) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return false;
  const username = process.env.ADMIN_USERNAME || "admin";
  const authorization = headers.get("authorization") || "";
  if (!authorization.startsWith("Basic ")) return false;
  const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  return equal(decoded, `${username}:${password}`);
}

export function verifyAdminCredentials(rawUsername: unknown, rawPassword: unknown) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return false;
  const username = process.env.ADMIN_USERNAME || "admin";
  return equal(`${String(rawUsername || "").trim()}:${String(rawPassword || "")}`, `${username}:${password}`);
}
