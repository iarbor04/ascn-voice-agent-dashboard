"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

type Insights = {
  days: number;
  liveCalls: number;
  conversations: number;
  totalMinutes: number;
  costUsd: number;
  toolCalls: number;
  durationP50: number | null;
  firstAudioP50: number | null;
  errorRate: number | null;
  transferRate: number | null;
  chart: { day: string; count: number }[];
};

const ranges = [{ days: 1, label: "Сутки" }, { days: 7, label: "7 дней" }, { days: 30, label: "30 дней" }, { days: 90, label: "90 дней" }];

function duration(seconds: number | null) {
  if (seconds === null) return "—";
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export default function InsightsView() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<Insights | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (range: number) => {
    try {
      const response = await fetch(`/api/voice/insights?days=${range}`, { cache: "no-store" });
      setData(await response.json() as Insights);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(days); }, [days, refresh]);

  const peak = Math.max(1, ...(data?.chart.map((point) => point.count) || [1]));
  const tiles = [
    { label: "Идут сейчас", value: String(data?.liveCalls ?? 0) },
    { label: "Разговоров", value: String(data?.conversations ?? 0) },
    { label: "Минут всего", value: String(data?.totalMinutes ?? 0) },
    { label: "Стоимость, оценка", value: `$${(data?.costUsd ?? 0).toFixed(2)}` },
    { label: "Вызовов инструментов", value: String(data?.toolCalls ?? 0) },
    { label: "Длительность, медиана", value: duration(data?.durationP50 ?? null) },
    { label: "До первого звука, медиана", value: data?.firstAudioP50 ? `${(data.firstAudioP50 / 1000).toFixed(1)} с` : "—" },
    { label: "Доля ошибок", value: data?.errorRate === null || data?.errorRate === undefined ? "—" : `${data.errorRate}%` },
    { label: "Доля переводов", value: data?.transferRate === null || data?.transferRate === undefined ? "—" : `${data.transferRate}%` },
  ];

  return <>
    <div className="page-header">
      <div><h1>Показатели</h1><p>Считается по сохранённым звонкам. Стоимость — оценка по минутной ставке модели, точный тариф публикует только xAI.</p></div>
      <button className="ghost-button" onClick={() => { setLoading(true); void refresh(days); }}><RefreshCw size={15} /> Обновить</button>
    </div>
    <div className="insights-range">{ranges.map((range) => <button key={range.days} className={days === range.days ? "active" : ""} onClick={() => { setLoading(true); setDays(range.days); }}>{range.label}</button>)}</div>
    <section className="insights-grid">{tiles.map((tile) => <article key={tile.label}><small>{tile.label}</small><strong>{loading && !data ? "…" : tile.value}</strong></article>)}</section>
    <section className="insights-chart">
      <header><strong>Разговоры по дням</strong><small>{data?.chart.length ? `${data.chart.length} дн. с активностью` : "нет данных"}</small></header>
      {data?.chart.length ? <div className="insights-bars">{data.chart.map((point) => <div key={point.day} title={`${point.day}: ${point.count}`}><i style={{ height: `${Math.max(6, point.count / peak * 100)}%` }} /><small>{point.day.slice(5)}</small><b>{point.count}</b></div>)}</div>
        : <p className="insights-empty">Позвоните на номер агента — показатели появятся здесь сразу после разговора.</p>}
    </section>
  </>;
}
