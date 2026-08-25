import { getRequestURL, getRouterParam, proxyRequest } from "h3";

export default defineEventHandler(async (event) => {
  const path = getRouterParam(event, "path") || "";
  const config = useRuntimeConfig(event);
  const target = new URL(`/api/${path}`, config.backendUrl);
  target.search = getRequestURL(event).search;
  return proxyRequest(event, target.toString());
});
