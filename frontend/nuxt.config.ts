export default defineNuxtConfig({
  compatibilityDate: "2026-08-25",
  devtools: { enabled: false },
  css: ["~/assets/main.css"],
  runtimeConfig: {
    backendUrl: process.env.NUXT_BACKEND_URL || "http://127.0.0.1:3000",
  },
  app: {
    head: {
      htmlAttrs: { lang: "ru" },
      title: "ASCN.AI Voice — голосовые AI-агенты",
      meta: [
        { name: "description", content: "Голосовые агенты Yandex AI Studio, xAI и OpenAI Realtime для телефонных номеров и SIP." },
        { name: "theme-color", content: "#ffffff" },
      ],
      link: [
        { rel: "icon", href: "/emblem.svg" },
        { rel: "preconnect", href: "https://fonts.googleapis.com" },
        { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" },
        { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono&display=swap" },
      ],
    },
  },
  nitro: {
    preset: "node-server",
  },
  typescript: {
    strict: true,
    typeCheck: true,
  },
});
