import type { VoiceConnectionSettings } from "../voice-agents.ts";
import { transport, type ApiResponse } from "./transport.ts";
import { detailText, IntegrationError, summaryLine, type CallExport, type Destination } from "./types.ts";

// Идентификаторы типов владельца в CRM Bitrix: лид, сделка, контакт, компания.
const OWNER_LEAD = 1;
const OWNER_CONTACT = 3;

function describeError(response: ApiResponse) {
  const body = response.json && typeof response.json === "object" ? response.json as Record<string, unknown> : {};
  const description = typeof body.error_description === "string" ? body.error_description : "";
  const code = typeof body.error === "string" ? body.error : "";
  if (description || code) return `Bitrix24 отказал: ${description || code}`;
  return `Bitrix24 ответил ${response.status}`;
}

async function bitrix(webhook: string, method: string, params: Record<string, unknown>) {
  const base = webhook.replace(/\/+$/, "");
  const response = await transport.call(`${base}/${method}.json`, { body: JSON.stringify(params) }) as ApiResponse;
  const body = response.json && typeof response.json === "object" ? response.json as Record<string, unknown> : {};
  if (response.status < 200 || response.status >= 300 || body.error) throw new IntegrationError(describeError(response), response.status);
  return body.result;
}

// Ответственного берём из самой ссылки вебхука: она имеет вид
// https://портал.bitrix24.ru/rest/<id пользователя>/<токен>/ — отдельное поле
// в настройках было бы лишним вопросом клиенту.
function responsibleId(webhook: string) {
  const match = webhook.match(/\/rest\/(\d+)\//);
  return match ? Number(match[1]) : 0;
}

// Ищем, к кому прикрепить звонок: сначала контакт, затем лид. Так повторные
// звонки одного клиента ложатся в его карточку, а не плодят сущности.
async function findOwner(webhook: string, phone: string) {
  for (const [entityType, ownerTypeId] of [["CONTACT", OWNER_CONTACT], ["LEAD", OWNER_LEAD]] as const) {
    const found = await bitrix(webhook, "crm.duplicate.findbycomm", { type: "PHONE", values: [phone], entity_type: entityType });
    const list = found && typeof found === "object" ? (found as Record<string, unknown>)[entityType] : null;
    const id = Array.isArray(list) ? Number(list[0]) : 0;
    if (id) return { ownerTypeId, ownerId: id, created: false };
  }
  return null;
}

export const bitrixDestination: Destination = {
  id: "bitrix",
  label: "Bitrix24",

  configured(settings) {
    return Boolean(settings.bitrixWebhookUrl);
  },

  async send(call: CallExport, settings: VoiceConnectionSettings) {
    const webhook = settings.bitrixWebhookUrl;
    const owner = await findOwner(webhook, call.phone)
      ?? {
        ownerTypeId: OWNER_LEAD,
        ownerId: Number(await bitrix(webhook, "crm.lead.add", {
          fields: {
            TITLE: `Звонок ${call.phone} — ${call.agentName || "голосовой агент"}`,
            PHONE: [{ VALUE: call.phone, VALUE_TYPE: "WORK" }],
            SOURCE_DESCRIPTION: "Голосовой агент ASCN Voice",
            COMMENTS: call.outcome?.summary || "",
          },
        })),
        created: true,
      };

    const activityId = await bitrix(webhook, "crm.activity.add", {
      fields: {
        OWNER_TYPE_ID: owner.ownerTypeId,
        OWNER_ID: owner.ownerId,
        TYPE_ID: 2,
        DIRECTION: call.direction === "inbound" ? 1 : 2,
        SUBJECT: summaryLine(call),
        DESCRIPTION: detailText(call),
        DESCRIPTION_TYPE: 1,
        COMMUNICATIONS: [{ VALUE: call.phone, ENTITY_ID: owner.ownerId, ENTITY_TYPE_ID: owner.ownerTypeId }],
        START_TIME: call.startedAt,
        END_TIME: call.endedAt,
        COMPLETED: "Y",
        RESPONSIBLE_ID: responsibleId(webhook),
      },
    });

    const target = owner.ownerTypeId === OWNER_CONTACT ? "контакту" : "лиду";
    const note = owner.created ? `создан лид ${owner.ownerId}` : `${target} ${owner.ownerId}`;
    return { entityId: String(activityId ?? ""), detail: `Звонок добавлен ${note}` };
  },

  async probe(settings) {
    if (!settings.bitrixWebhookUrl) return { ok: false, detail: "Вебхук не указан" };
    try {
      // Чтение справочника статусов ничего не создаёт и требует того же права crm.
      await bitrix(settings.bitrixWebhookUrl, "crm.status.list", {});
      return { ok: true, detail: "Вебхук отвечает, доступ к CRM есть" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "Не удалось обратиться к Bitrix24" };
    }
  },
};
