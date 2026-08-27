// Транспорт живёт в .mjs, потому что его использует и шлюз, работающий без
// сборки. Объявления нужны приложению на TypeScript.

export function isUnsafeAddress(address: string): boolean;

export function callPublicApi(
  rawUrl: string,
  options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer | object;
    contentType?: string;
    timeoutMs?: number;
  },
): Promise<{ status: number; text: string; json: unknown }>;

export function postPublicWebhook(
  rawUrl: string,
  options?: { authorization?: string; payload?: unknown; timeoutMs?: number },
): Promise<unknown>;
