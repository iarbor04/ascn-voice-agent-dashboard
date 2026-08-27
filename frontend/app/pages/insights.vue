<script setup lang="ts">
import { RefreshCw } from "@lucide/vue";

type Insights = {
  days: number; liveCalls: number; conversations: number; totalMinutes: number; costUsd: number; toolCalls: number;
  durationP50: number | null; firstAudioP50: number | null; errorRate: number | null; transferRate: number | null;
  chart: { day: string; count: number }[];
};

const ranges = [{ days: 1, label: "Сутки" }, { days: 7, label: "7 дней" }, { days: 30, label: "30 дней" }, { days: 90, label: "90 дней" }];
const days = ref(7);
const data = ref<Insights | null>(null);
const loading = ref(true);

function duration(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return "—";
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const peak = computed(() => Math.max(1, ...(data.value?.chart.map((point) => point.count) || [1])));
const tiles = computed(() => [
  { label: "Идут сейчас", value: String(data.value?.liveCalls ?? 0) },
  { label: "Разговоров", value: String(data.value?.conversations ?? 0) },
  { label: "Минут всего", value: String(data.value?.totalMinutes ?? 0) },
  { label: "Стоимость, оценка", value: `$${(data.value?.costUsd ?? 0).toFixed(2)}` },
  { label: "Вызовов инструментов", value: String(data.value?.toolCalls ?? 0) },
  { label: "Длительность, медиана", value: duration(data.value?.durationP50) },
  { label: "До первого звука, медиана", value: data.value?.firstAudioP50 ? `${(data.value.firstAudioP50 / 1000).toFixed(1)} с` : "—" },
  { label: "Доля ошибок", value: data.value?.errorRate === null || data.value?.errorRate === undefined ? "—" : `${data.value.errorRate}%` },
  { label: "Доля переводов", value: data.value?.transferRate === null || data.value?.transferRate === undefined ? "—" : `${data.value.transferRate}%` },
]);

async function refresh() {
  loading.value = true;
  try {
    data.value = await apiFetch<Insights>(`/api/voice/insights?days=${days.value}`);
  } finally {
    loading.value = false;
  }
}

watch(days, refresh);
onMounted(refresh);
</script>

<template>
  <div class="page-header"><div><h1>Показатели</h1><p>Считается по сохранённым звонкам. Стоимость — оценка по минутной ставке модели.</p></div><button class="ghost-button" @click="refresh"><RefreshCw :size="15" /> Обновить</button></div>
  <div class="insights-range"><button v-for="range in ranges" :key="range.days" :class="{ active: days === range.days }" @click="days = range.days">{{ range.label }}</button></div>
  <section class="insights-grid"><article v-for="tile in tiles" :key="tile.label"><small>{{ tile.label }}</small><strong>{{ loading && !data ? "…" : tile.value }}</strong></article></section>
  <section class="insights-chart">
    <header><strong>Разговоры по дням</strong><small>{{ data?.chart.length ? `${data.chart.length} дн. с активностью` : "нет данных" }}</small></header>
    <div v-if="data?.chart.length" class="insights-bars"><div v-for="point in data.chart" :key="point.day" :title="`${point.day}: ${point.count}`"><i :style="{ height: `${Math.max(6, point.count / peak * 100)}%` }"></i><small>{{ point.day.slice(5) }}</small><b>{{ point.count }}</b></div></div>
    <p v-else class="insights-empty">Позвоните на номер агента — показатели появятся здесь сразу после разговора.</p>
  </section>
</template>
