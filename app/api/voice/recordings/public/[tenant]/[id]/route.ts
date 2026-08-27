import { isCallId, isTenantId, verifyRecordingToken } from "@/lib/recording-link";
import { recordingResponse } from "@/lib/recording-stream";
import { withTenant } from "@/lib/tenant-context";

// Единственный роут записей без сессии: ссылку открывает менеджер из карточки
// в CRM, у которого доступа в панель нет. Поэтому здесь нет tenantRoute, а
// тенант берётся из пути и проверяется до любого обращения к хранилищу.
// Доступ даёт только подпись HMAC, отзыв — ротацией RECORDING_LINK_SECRET.
export async function GET(request: Request, context: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant, id } = await context.params;
  if (!isTenantId(tenant) || !isCallId(id)) return new Response("Not found", { status: 404 });
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!verifyRecordingToken(tenant, id, token)) return new Response("Not found", { status: 404 });
  const response = await withTenant(tenant, () => recordingResponse(id, request.headers.get("range")));
  // Публичную ссылку не должны кешировать промежуточные прокси: запись —
  // персональные данные, и отзыв секрета обязан срабатывать сразу.
  response.headers.set("cache-control", "no-store");
  return response;
}
