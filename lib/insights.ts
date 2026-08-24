import type { CallRecord } from "@/lib/calls";

// Минутные ставки в долларах. Плоский тариф публикует только xAI,
// у остальных это пересчёт из цены за токены — поэтому «оценка».
const perMinuteUsd: Record<string, number> = {
  "grok-voice-think-fast-2.0": 0.08,
  "gpt-realtime-2.1": 0.06,
  "gpt-realtime-2.1-mini": 0.02,
  "gpt-realtime-2": 0.06,
  "gpt-realtime-1.5": 0.06,
  "speech-realtime-260528": 0.025,
  "speech-realtime-250923": 0.025,
  "speech-realtime-deepseek-v4-flash": 0.025,
};

function seconds(call: CallRecord) {
  if (!call.endedAt) return 0;
  const started = Date.parse(call.createdAt);
  const ended = Date.parse(call.endedAt);
  return Number.isFinite(started) && Number.isFinite(ended) && ended > started ? (ended - started) / 1000 : 0;
}

function percentile(values: number[], share: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

// Чистая агрегация: звонки уже отобраны по периоду, all нужен только для «идут сейчас».
export function aggregateCalls(calls: CallRecord[], all: CallRecord[]) {
  const finished = calls.filter((call) => call.status === "ended");
  const durations = finished.map(seconds).filter((value) => value > 0);
  const firstAudio = calls.map((call) => call.firstAudioMs).filter((value) => value > 0);
  const totalSeconds = durations.reduce((sum, value) => sum + value, 0);
  const cost = finished.reduce((sum, call) => sum + (perMinuteUsd[call.model] || 0) * seconds(call) / 60, 0);
  const byDay = new Map<string, number>();
  for (const call of calls) {
    const day = call.createdAt.slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }
  return {
    liveCalls: all.filter((call) => call.status === "live" || call.status === "dialing").length,
    conversations: calls.length,
    totalMinutes: Math.round(totalSeconds / 60 * 10) / 10,
    costUsd: Math.round(cost * 100) / 100,
    toolCalls: calls.reduce((sum, call) => sum + (call.toolCalls || 0), 0),
    toolUsage: calls.reduce<Record<string, number>>((total, call) => {
      for (const [name, count] of Object.entries(call.toolUsage || {})) total[name] = (total[name] || 0) + count;
      return total;
    }, {}),
    durationP50: percentile(durations, 0.5),
    firstAudioP50: percentile(firstAudio, 0.5),
    errorRate: calls.length ? Math.round(calls.filter((call) => call.status === "failed" || call.error).length / calls.length * 100) : null,
    transferRate: calls.length ? Math.round(calls.filter((call) => (call.transfers || 0) > 0).length / calls.length * 100) : null,
    chart: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count })),
  };
}
