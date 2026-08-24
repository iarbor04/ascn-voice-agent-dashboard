import { createWriteStream, mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

const RATE = 8000;
const CHANNELS = 2;

function header(dataBytes) {
  const buffer = Buffer.alloc(44);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(RATE, 24);
  buffer.writeUInt32LE(RATE * CHANNELS * 2, 28);
  buffer.writeUInt16LE(CHANNELS * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

// Пишем стерео: слева абонент, справа агент. Так по записи слышно, кто говорил
// и где агент перебил — при сведении в моно это теряется.
export function startRecording(directory, callId) {
  if (!directory || !/^[0-9a-f-]{36}$/i.test(callId)) return null;
  try {
    mkdirSync(directory, { recursive: true });
  } catch {
    return null;
  }
  const path = join(directory, `${callId}.wav`);
  const stream = createWriteStream(path);
  stream.on("error", () => undefined);
  stream.write(header(0));
  let dataBytes = 0;

  return {
    path,
    // Кадры приходят с одного 20-мс тикера, поэтому дорожки не разъезжаются.
    frame(caller, agent) {
      const samples = Math.max(caller.length, agent.length) / 2;
      const out = Buffer.alloc(samples * 4);
      for (let i = 0; i < samples; i += 1) {
        out.writeInt16LE(i * 2 + 1 < caller.length ? caller.readInt16LE(i * 2) : 0, i * 4);
        out.writeInt16LE(i * 2 + 1 < agent.length ? agent.readInt16LE(i * 2) : 0, i * 4 + 2);
      }
      dataBytes += out.length;
      stream.write(out);
    },
    async close() {
      await new Promise((resolve) => stream.end(resolve));
      if (!dataBytes) return 0;
      // Размеры известны только в конце, поэтому правим заголовок на месте.
      const file = await open(path, "r+");
      try {
        await file.write(header(dataBytes), 0, 44, 0);
      } finally {
        await file.close();
      }
      return Math.round(dataBytes / (RATE * CHANNELS * 2) * 10) / 10;
    },
  };
}
