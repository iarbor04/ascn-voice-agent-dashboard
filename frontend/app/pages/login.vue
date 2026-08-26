<script setup lang="ts">
definePageMeta({ layout: false });

const route = useRoute();
const form = reactive({ email: "", password: "" });
const error = ref("");
const busy = ref(false);

async function submit() {
  busy.value = true;
  error.value = "";
  try {
    await apiFetch("/api/auth/login", { method: "POST", body: form });
    const next = typeof route.query.next === "string" && route.query.next.startsWith("/") ? route.query.next : "/agents";
    await navigateTo(next, { external: true });
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "Не получилось войти";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="auth-shell">
    <form class="auth-card" @submit.prevent="submit">
      <div class="brand"><img class="brand-emblem" src="/emblem.svg" width="36" height="36" alt="ASCN.AI"><span>ASCN.AI Voice</span></div>
      <h1>Вход</h1>
      <p>Голосовые агенты на вашем номере телефона.</p>
      <label>Логин или почта<input v-model="form.email" type="text" autocomplete="username" required placeholder="admin или you@example.com"></label>
      <label>Пароль<input v-model="form.password" type="password" autocomplete="current-password" required></label>
      <p v-if="error" class="auth-error">{{ error }}</p>
      <button class="primary-button" :disabled="busy" type="submit">{{ busy ? "Входим…" : "Войти" }}</button>
      <small>Нет аккаунта? <NuxtLink to="/register">Зарегистрироваться</NuxtLink></small>
    </form>
  </main>
</template>
