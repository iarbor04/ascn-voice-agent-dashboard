import { tenantRoute } from "@/lib/guard";
import { getCallRecord } from "@/lib/calls";
import { exportCall } from "@/lib/integrations";

// Повтор упавшей выгрузки из панели. Здесь ждём результат, в отличие от
// автоматической отправки: человек нажал кнопку и должен увидеть, чем кончилось.
async function handlePOST(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const call = await getCallRecord(id);
  if (!call) return Response.json({ error: "Звонок не найден" }, { status: 404 });
  if (call.status !== "ended") return Response.json({ error: "Выгружать можно только завершённый звонок" }, { status: 409 });
  await exportCall(id, { retry: false });
  return Response.json({ call: await getCallRecord(id) });
}

export const POST = tenantRoute(handlePOST);
