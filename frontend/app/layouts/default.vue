<script setup lang="ts">
import { BarChart3, Bot, PhoneCall } from "@lucide/vue";

type Account = { email: string; kind: string };

const route = useRoute();
const account = ref<Account | null>(null);
const { message } = useToast();

const title = computed(() => {
  if (route.path.startsWith("/calls")) return "Звонки";
  if (route.path.startsWith("/insights")) return "Аналитика";
  return "Голосовые агенты";
});

onMounted(async () => {
  try {
    account.value = await apiFetch<Account>("/api/auth/me");
  } catch {
    await navigateTo("/login");
  }
});

async function logout() {
  await apiFetch("/api/auth/logout", { method: "POST" });
  await navigateTo("/login");
}
</script>

<template>
  <main class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <img class="brand-emblem" src="/emblem.svg" width="36" height="36" alt="ASCN.AI">
        <span>ASCN.AI Voice</span>
      </div>
      <nav class="main-nav">
        <p>ГОЛОСОВАЯ ПЛАТФОРМА</p>
        <NuxtLink to="/agents" custom v-slot="{ navigate, isActive }">
          <button :class="{ active: isActive }" @click="navigate"><Bot class="nav-icon" />Голосовые агенты</button>
        </NuxtLink>
        <NuxtLink to="/calls" custom v-slot="{ navigate, isActive }">
          <button :class="{ active: isActive }" @click="navigate"><PhoneCall class="nav-icon" />Звонки</button>
        </NuxtLink>
        <NuxtLink to="/insights" custom v-slot="{ navigate, isActive }">
          <button :class="{ active: isActive }" @click="navigate"><BarChart3 class="nav-icon" />Аналитика</button>
        </NuxtLink>
      </nav>
      <div v-if="account" class="sidebar-account">
        <b :title="account.email">{{ account.email }}</b>
        <button v-if="account.kind === 'session'" @click="logout">Выйти</button>
      </div>
    </aside>
    <section class="workspace">
      <header class="topbar">
        <div class="breadcrumbs"><span>Голосовой проект</span><i>/</i><strong>{{ title }}</strong></div>
      </header>
      <div class="content"><slot /></div>
    </section>
    <div v-if="message" class="toast"><span>✓</span>{{ message }}</div>
  </main>
</template>
