import { canonicalPhone, normalizeDialTarget } from "./voice-agents.ts";

export type CampaignRecipientInput = {
  phone: string;
  name: string;
  variables: Record<string, string>;
};

function parseRows(contents: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index];
    if (quoted) {
      if (character === '"' && contents[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"' && !field) quoted = true;
    else if (character === delimiter) { row.push(field.trim()); field = ""; }
    else if (character === "\n") { row.push(field.trim()); rows.push(row); row = []; field = ""; }
    else if (character !== "\r") field += character;
  }
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function delimiterOf(header: string) {
  const counts = [",", ";", "\t"].map((delimiter) => ({ delimiter, count: header.split(delimiter).length - 1 }));
  return counts.sort((left, right) => right.count - left.count)[0]?.delimiter || ",";
}

function normalizedHeader(value: string) {
  return value.replace(/^\uFEFF/, "").trim().toLowerCase();
}

function variableKey(value: string, index: number) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.slice(0, 60) || `column_${index + 1}`;
}

export function parseCampaignCsv(contents: string, defaultPurpose = "") {
  if (Buffer.byteLength(contents, "utf8") > 2_000_000) throw new Error("CSV-файл больше 2 МБ");
  const firstLine = contents.split(/\r?\n/, 1)[0] || "";
  const rows = parseRows(contents, delimiterOf(firstLine));
  if (rows.length < 2) throw new Error("В CSV должна быть строка заголовков и хотя бы один контакт");
  const headers = (rows[0] || []).map(normalizedHeader);
  const phoneIndex = headers.findIndex((header) => ["phone", "telephone", "tel", "number", "номер", "телефон"].includes(header));
  const nameIndex = headers.findIndex((header) => ["name", "client", "customer", "имя", "клиент"].includes(header));
  const purposeIndex = headers.findIndex((header) => ["purpose", "task", "reason", "цель", "задача", "повод"].includes(header));
  if (phoneIndex < 0) throw new Error("Добавьте колонку phone или телефон");

  const recipients: CampaignRecipientInput[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  let duplicates = 0;
  for (const row of rows.slice(1)) {
    if (!row.some((value) => value.trim())) continue;
    const normalized = normalizeDialTarget(row[phoneIndex] || "");
    if (!normalized) { invalid += 1; continue; }
    const phone = canonicalPhone(normalized);
    if (seen.has(phone)) { duplicates += 1; continue; }
    seen.add(phone);
    const name = (nameIndex >= 0 ? row[nameIndex] : "")?.trim().slice(0, 120) || "";
    const purpose = (purposeIndex >= 0 ? row[purposeIndex] : "")?.trim().slice(0, 1000) || defaultPurpose.trim().slice(0, 1000);
    const variables: Record<string, string> = { caller_name: name, caller_purpose: purpose };
    headers.forEach((header, index) => {
      if ([phoneIndex, nameIndex, purposeIndex].includes(index)) return;
      const value = (row[index] || "").trim();
      if (value) variables[variableKey(header, index)] = value.slice(0, 1000);
    });
    recipients.push({ phone, name, variables });
    if (recipients.length > 5_000) throw new Error("В одной кампании поддерживается не больше 5000 уникальных контактов");
  }
  if (!recipients.length) throw new Error("В CSV не найдено корректных телефонных номеров");
  return { recipients, invalid, duplicates };
}
