import { AsyncLocalStorage } from "node:async_hooks";

// Контекст тенанта живёт в AsyncLocalStorage: хранилища берут его сами,
// поэтому забытый параметр превращается в ошибку, а не в чужие данные.
const storage = new AsyncLocalStorage<string>();

export const DEFAULT_TENANT = "default";

export function withTenant<T>(tenantId: string, operation: () => T): T {
  return storage.run(tenantId, operation);
}

export function currentTenantId(): string {
  const tenantId = storage.getStore();
  if (!tenantId) throw new Error("Обращение к хранилищу вне контекста тенанта");
  return tenantId;
}
