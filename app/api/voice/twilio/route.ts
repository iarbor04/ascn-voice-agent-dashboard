import { tenantRoute } from "@/lib/guard";
// Проверка ключей Twilio: их API отвечает 401 на неверную пару SID/токен,
// поэтому мы можем сказать сразу, а не после первого пропавшего звонка.
async function handlePOST(request: Request) {
  const body = await request.json().catch(() => null) as { accountSid?: string; authToken?: string } | null;
  const accountSid = String(body?.accountSid || "").trim();
  const authToken = String(body?.authToken || "").trim();
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) return Response.json({ error: "Account SID выглядит неверно: он начинается с AC и содержит 34 символа" }, { status: 400 });
  if (!authToken) return Response.json({ error: "Укажите Auth Token" }, { status: 400 });
  try {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`, {
      headers: { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}` },
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 401) return Response.json({ error: "Twilio не принял пару SID и токен" }, { status: 401 });
    const data = await response.json().catch(() => ({})) as { friendly_name?: string; status?: string; message?: string };
    if (!response.ok) return Response.json({ error: data.message || `Twilio вернул ${response.status}` }, { status: 502 });
    return Response.json({ ok: true, account: data.friendly_name || accountSid, status: data.status || "" });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 502 });
  }
}

export const POST = tenantRoute(handlePOST);
