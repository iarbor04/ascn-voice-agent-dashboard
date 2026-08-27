<script setup lang="ts">
import { ArrowUp } from "@lucide/vue";

type BuilderMessage = { role: "assistant" | "user"; text: string };
type BuilderDraft = {
  name: string;
  description: string;
  instructions: string;
  firstMessage: string;
  keyterms: string;
  guardrails: string;
  speaksFirst: boolean;
};

const props = defineProps<{ seed?: string }>();
const emit = defineEmits<{ cancel: []; skip: []; ready: [draft: BuilderDraft] }>();
const { notify } = useToast();
const messages = ref<BuilderMessage[]>([
  { role: "assistant", text: "Привет! Помогу собрать голосового агента. Расскажите своими словами, что он должен делать по телефону." },
]);
const text = ref("");
const busy = ref(false);
const feed = ref<HTMLElement | null>(null);

async function send(outgoing: string) {
  if (!outgoing.trim() || busy.value) return;
  const next: BuilderMessage[] = [...messages.value, { role: "user", text: outgoing.trim() }];
  messages.value = next;
  text.value = "";
  busy.value = true;
  try {
    const result = await apiFetch<{ reply: string; ready?: boolean; draft?: Omit<BuilderDraft, "speaksFirst"> }>("/api/voice/agent-builder", {
      method: "POST",
      body: { provider: "xai", messages: next },
    });
    messages.value.push({ role: "assistant", text: result.reply });
    if (result.ready && result.draft) {
      emit("ready", { ...result.draft, speaksFirst: Boolean(result.draft.firstMessage) });
      notify("Промпт собран — проверьте и сохраните");
    }
  } catch (failure) {
    notify(failure instanceof Error ? failure.message : "Помощник не ответил");
    messages.value.push({ role: "assistant", text: "Не получилось спросить модель. Попробуйте ещё раз или нажмите «Пропустить»." });
  } finally {
    busy.value = false;
  }
}

watch(messages, async () => {
  await nextTick();
  if (feed.value) feed.value.scrollTop = feed.value.scrollHeight;
}, { deep: true });

onMounted(() => {
  if (props.seed?.trim()) void send(`Хочу собрать агента: ${props.seed.trim()}.`);
});
</script>

<template>
  <div class="dialog-overlay" role="presentation" @click.self="emit('cancel')">
    <div class="dialog builder" role="dialog" aria-modal="true" aria-label="Сборка голосового агента">
      <header><div><h2>Сборка голосового агента</h2><p>Помощник задаст вопросы и подготовит промпт.</p></div><button type="button" class="pill-button" @click="emit('skip')">Пропустить</button></header>
      <div ref="feed" class="builder-feed"><p v-for="(message, index) in messages" :key="`${index}-${message.text.slice(0, 12)}`" :class="message.role">{{ message.text }}</p><p v-if="busy" class="assistant thinking"><span></span><span></span><span></span></p></div>
      <footer class="builder-input"><input v-model="text" placeholder="Опишите, что должен делать агент" aria-label="Сообщение помощнику" @keydown.enter.prevent="send(text)"><button type="button" class="pill-button solid" :disabled="busy || !text.trim()" aria-label="Отправить" @click="send(text)"><ArrowUp :size="16" /></button></footer>
    </div>
  </div>
</template>
