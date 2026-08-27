type ApiErrorBody = { error?: string; message?: string };

export async function apiFetch<T>(path: string, options: Parameters<typeof $fetch<T>>[1] = {}): Promise<T> {
  try {
    return await $fetch<T>(path, {
      credentials: "include",
      ...options,
    });
  } catch (error: unknown) {
    const failure = error as { data?: ApiErrorBody; statusMessage?: string; message?: string };
    throw new Error(failure.data?.error || failure.data?.message || failure.statusMessage || failure.message || "Ошибка запроса");
  }
}
