"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";

export default function RegisterPage() {
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      const result = await response.json();
      if (!response.ok) return setError(result.error || "Не получилось зарегистрироваться");
      window.location.href = "/";
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-shell">
    <form className="auth-card" onSubmit={submit}>
      <div className="brand"><Image className="brand-emblem" src="/emblem.svg" width={36} height={36} alt="ASCN.AI" priority /><span>ASCN.AI Voice</span></div>
      <h1>Регистрация</h1>
      <p>Аккаунт бесплатный: агент, номер и ключи провайдеров вы подключаете свои.</p>
      <label>Почта<input type="email" autoComplete="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="you@example.com" /></label>
      <label>Пароль<input type="password" autoComplete="new-password" required minLength={8} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="минимум 8 символов" /></label>
      {error && <p className="auth-error">{error}</p>}
      <button className="primary-button" disabled={busy} type="submit">{busy ? "Создаём…" : "Создать аккаунт"}</button>
      <small>Уже есть аккаунт? <Link href="/login">Войти</Link></small>
    </form>
  </main>;
}
