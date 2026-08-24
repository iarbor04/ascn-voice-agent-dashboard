import { connect as netConnect } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { Socket } from "node:net";

export type SmtpConfig = { host: string; port: number; user: string; password: string; from: string };

type AnySocket = Socket | TLSSocket;

// Минимальный SMTP-клиент: письмо после звонка не стоит новой зависимости.
// Поддержаны implicit TLS (465) и STARTTLS (587/25) с AUTH LOGIN.
function talk(socket: AnySocket, timeoutMs: number) {
  let buffer = "";
  const waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void; expect: number }> = [];
  const fail = (error: Error) => { while (waiters.length) waiters.shift()!.reject(error); };
  socket.setTimeout(timeoutMs, () => fail(new Error("SMTP-сервер не ответил вовремя")));
  socket.on("error", (error: Error) => fail(error));
  socket.on("close", () => fail(new Error("SMTP-соединение закрыто раньше времени")));
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    // Последняя строка ответа отделена пробелом после кода: «250 OK», а не «250-…».
    let match = /^(\d{3})(?: [^\n]*)?\r?\n/m.exec(buffer);
    while (match) {
      const lines = buffer.slice(0, match.index + match[0].length);
      const complete = new RegExp(`^${match[1]} `, "m").test(lines);
      if (!complete) break;
      buffer = buffer.slice(match.index + match[0].length);
      const waiter = waiters.shift();
      if (waiter) {
        const code = Number(match[1]);
        if (code !== waiter.expect) waiter.reject(new Error(`SMTP: ${lines.trim().slice(0, 200)}`));
        else waiter.resolve(lines);
      }
      match = /^(\d{3})(?: [^\n]*)?\r?\n/m.exec(buffer);
    }
  });
  return {
    expect(code: number) { return new Promise<string>((resolve, reject) => waiters.push({ resolve, reject, expect: code })); },
    send(line: string) { socket.write(`${line}\r\n`); },
  };
}

function header(value: string) {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export async function sendMail(config: SmtpConfig, to: string, subject: string, text: string) {
  if (!config.host || !config.from || !to) throw new Error("Почта не настроена");
  const implicit = config.port === 465;
  const socket: AnySocket = implicit
    ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
    : netConnect({ host: config.host, port: config.port });
  let channel = talk(socket, 20000);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once(implicit ? "secureConnect" : "connect", () => resolve());
      socket.once("error", reject);
    });
    await channel.expect(220);
    channel.send("EHLO ascn-voice");
    const greeting = await channel.expect(250);
    let active = socket;
    if (!implicit && /STARTTLS/i.test(greeting)) {
      channel.send("STARTTLS");
      await channel.expect(220);
      active = tlsConnect({ socket, servername: config.host });
      channel = talk(active, 20000);
      await new Promise<void>((resolve, reject) => {
        (active as TLSSocket).once("secureConnect", () => resolve());
        active.once("error", reject);
      });
      channel.send("EHLO ascn-voice");
      await channel.expect(250);
    }
    if (config.user) {
      channel.send("AUTH LOGIN");
      await channel.expect(334);
      channel.send(Buffer.from(config.user, "utf8").toString("base64"));
      await channel.expect(334);
      channel.send(Buffer.from(config.password, "utf8").toString("base64"));
      await channel.expect(235);
    }
    channel.send(`MAIL FROM:<${config.from}>`);
    await channel.expect(250);
    channel.send(`RCPT TO:<${to}>`);
    await channel.expect(250);
    channel.send("DATA");
    await channel.expect(354);
    const body = text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    channel.send([
      `From: ${config.from}`,
      `To: ${to}`,
      `Subject: ${header(subject)}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
      ".",
    ].join("\r\n"));
    await channel.expect(250);
    channel.send("QUIT");
    // Ждём прощание, иначе разрыв на середине выглядит для сервера как сброс.
    await channel.expect(221).catch(() => undefined);
  } finally {
    socket.destroy();
  }
}
