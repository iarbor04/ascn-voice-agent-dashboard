import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import net from "node:net";

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 100 * 1024;

function ipv4Parts(address) {
  if (net.isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function unsafeIpv4(address) {
  const parts = ipv4Parts(address);
  if (!parts) return true;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function ipv6Parts(address) {
  if (net.isIP(address) !== 6) return null;
  const clean = address.toLowerCase().split("%")[0];
  const halves = clean.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half) => {
    if (!half) return [];
    const chunks = half.split(":");
    const last = chunks.at(-1);
    if (last?.includes(".")) {
      const v4 = ipv4Parts(last);
      if (!v4) return null;
      chunks.splice(chunks.length - 1, 1, ((v4[0] << 8) | v4[1]).toString(16), ((v4[2] << 8) | v4[3]).toString(16));
    }
    if (!chunks.every((chunk) => /^[0-9a-f]{1,4}$/.test(chunk))) return null;
    return chunks.map((chunk) => Number.parseInt(chunk, 16));
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] || "");
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}

function unsafeIpv6(address) {
  const parts = ipv6Parts(address);
  if (!parts) return true;
  const allZero = parts.every((part) => part === 0);
  const loopback = parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1;
  if (allZero || loopback) return true;
  if ((parts[0] & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((parts[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((parts[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (parts[0] === 0x2001 && (parts[1] === 0 || parts[1] === 0x0db8)) return true; // Teredo/documentation
  if (parts[0] === 0x2002 || (parts[0] === 0x0064 && parts[1] === 0xff9b)) return true; // 6to4/NAT64
  const mappedV4 = parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;
  if (mappedV4) {
    return unsafeIpv4(`${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`);
  }
  return false;
}

export function isUnsafeAddress(address) {
  const family = net.isIP(address);
  return family === 4 ? unsafeIpv4(address) : family === 6 ? unsafeIpv6(address) : true;
}

async function resolvePublicAddress(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local") || normalized.endsWith(".internal") || normalized.endsWith(".home.arpa")) {
    throw new Error("Webhook host is not public");
  }
  const literalFamily = net.isIP(normalized);
  const addresses = literalFamily
    ? [{ address: normalized, family: literalFamily }]
    : await dnsLookup(normalized, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isUnsafeAddress(address))) {
    throw new Error("Webhook DNS resolved to a non-public address");
  }
  return addresses[0];
}

// Один запрос к чужому API с теми же гарантиями, что и у вебхуков: адрес
// резолвится один раз и пинится в lookup, редиректы запрещены, размеры обрезаны.
// Возвращает статус и тело как есть — решение по коду ответа принимает вызывающий,
// потому что Bitrix и amoCRM описывают причину отказа в теле, а не в статусе.
export async function callPublicApi(rawUrl, { method = "POST", headers = {}, body, contentType = "application/json", timeoutMs = 15_000 } = {}) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw new Error("Webhook must be a credential-free HTTPS URL");
  }
  const payload = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  if (payload && payload.length > MAX_REQUEST_BYTES) throw new Error("Webhook request is too large");
  const target = await resolvePublicAddress(url.hostname);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const request = https.request(url, {
      method,
      headers: {
        ...(payload ? { "content-type": contentType, "content-length": String(payload.length) } : {}),
        ...headers,
      },
      timeout: timeoutMs,
      maxHeaderSize: 16 * 1024,
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        finish(reject, new Error("Webhook redirects are not allowed"));
        return;
      }
      let size = 0;
      const chunks = [];
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("Webhook response is too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        finish(resolve, { status: response.statusCode, text, json });
      });
    });
    request.on("timeout", () => request.destroy(new Error("Webhook timeout")));
    request.on("error", (error) => finish(reject, error));
    request.end(payload ?? undefined);
  });
}

// Прежний контракт вебхуков агента: бросает на любой не-2xx и отдаёт разобранный JSON.
export async function postPublicWebhook(rawUrl, { authorization = "", payload, timeoutMs = 15_000 } = {}) {
  const response = await callPublicApi(rawUrl, {
    method: "POST",
    headers: authorization ? { authorization } : {},
    body: JSON.stringify(payload ?? {}),
    timeoutMs,
  });
  if (response.status < 200 || response.status >= 300) throw new Error(`Webhook returned ${response.status}`);
  return response.json ?? { result: response.text };
}
