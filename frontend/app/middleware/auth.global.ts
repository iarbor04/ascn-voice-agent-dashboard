export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === "/login" || to.path === "/register") return;
  try {
    const requestFetch = useRequestFetch();
    await requestFetch("/api/auth/me");
  } catch {
    return navigateTo({ path: "/login", query: { next: to.fullPath } });
  }
});
