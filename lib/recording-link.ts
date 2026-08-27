import { createHmac, timingSafeEqual } from "node:crypto";
import { DEFAULT_TENANT } from "./tenant-context.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_LENGTH = 32;

function linkSecret() {
  return process.env.RECORDING_LINK_SECRET?.trim() || "";
}

// Ссылки на записи работают только когда секрет задан. Иначе интеграции
// отправляют выгрузку без записи, а панель объясняет, почему тумблер недоступен.
export function recordingLinksAvailable() {
  return Boolean(linkSecret());
}

export function isCallId(value: string) {
  return UUID.test(value);
}

export function isTenantId(value: string) {
  return value === DEFAULT_TENANT || UUID.test(value);
}

export function recordingToken(tenantId: string, callId: string) {
  const secret = linkSecret();
  if (!secret) return "";
  return createHmac("sha256", secret).update(`${tenantId}:${callId}`).digest("hex").slice(0, TOKEN_LENGTH);
}

export function verifyRecordingToken(tenantId: string, callId: string, token: string) {
  const expected = recordingToken(tenantId, callId);
  if (!expected || token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

// Абсолютная ссылка нужна потому, что открывать её будет менеджер из карточки
// в CRM, а не браузер, знающий адрес панели.
export function recordingUrl(tenantId: string, callId: string) {
  const base = process.env.PUBLIC_APP_URL?.trim().replace(/\/+$/, "") || "";
  const token = recordingToken(tenantId, callId);
  if (!base || !token || !isCallId(callId) || !isTenantId(tenantId)) return "";
  return `${base}/api/voice/recordings/public/${tenantId}/${callId}?token=${token}`;
}
