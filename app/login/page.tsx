"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";

export default function LoginPage() {
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      const result = await response.json();
      if (!response.ok) return setError(result.error || "Не получилось войти");
      window.location.href = "/";
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-shell">
    <form className="auth-card" onSubmit={submit}>
      <div className="brand"><Image className="brand-emblem" src="/emblem.svg" width={36} height={36} alt="ASCN.AI" priority /><span>ASCN.AI Voice</span></div>
      <h1>Вход</h1>
      <p>Голосовые агенты на вашем номере телефона.</p>
      <label>Логин или почта<input type="text" autoComplete="username" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="admin или you@example.com" /></label>
      <label>Пароль<input type="password" autoComplete="current-password" required value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
      {error && <p className="auth-error">{error}</p>}
      <button className="primary-button" disabled={busy} type="submit">{busy ? "Входим…" : "Войти"}</button>
      <small>Нет аккаунта? <Link href="/register">Зарегистрироваться</Link></small>
    </form>
  </main>;
}
