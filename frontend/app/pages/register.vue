<script setup lang="ts">
definePageMeta({ layout: false });

const form = reactive({ email: "", password: "" });
const error = ref("");
const busy = ref(false);

async function submit() {
  busy.value = true;
  error.value = "";
  try {
    await apiFetch("/api/auth/register", { method: "POST", body: form });
    await navigateTo("/agents", { external: true });
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "Не получилось зарегистрироваться";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="auth-shell">
    <form class="auth-card" @submit.prevent="submit">
      <div class="brand"><img class="brand-emblem" src="/emblem.svg" width="36" height="36" alt="ASCN.AI"><span>ASCN.AI Voice</span></div>
      <h1>Регистрация</h1>
      <p>Аккаунт бесплатный: агент, номер и ключи провайдеров вы подключаете свои.</p>
      <label>Почта<input v-model="form.email" type="email" autocomplete="email" required placeholder="you@example.com"></label>
      <label>Пароль<input v-model="form.password" type="password" autocomplete="new-password" required minlength="8" placeholder="минимум 8 символов"></label>
      <p v-if="error" class="auth-error">{{ error }}</p>
      <button class="primary-button" :disabled="busy" type="submit">{{ busy ? "Создаём…" : "Создать аккаунт" }}</button>
      <small>Уже есть аккаунт? <NuxtLink to="/login">Войти</NuxtLink></small>
    </form>
  </main>
</template>
