import { callPublicApi } from "../../voice-gateway/public-webhook.mjs";

// Единственный шов для тестов. Обращаться к чужим API напрямую через fetch
// нельзя: callPublicApi несёт защиту от SSRF и DNS rebinding из PR #1, а она
// по делу не пускает запросы на localhost — значит поднять тестовый сервер и
// сходить в него настоящим транспортом невозможно. Подменяется только в тестах.
export const transport = { call: callPublicApi };

export type ApiResponse = { status: number; text: string; json: unknown };
