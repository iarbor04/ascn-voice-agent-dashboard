import { chmodSync, constants, createWriteStream, mkdirSync, openSync } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
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
  if (!directory || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callId)) return null;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // WAV до выгрузки в object storage содержит персональные данные.
    chmodSync(directory, 0o700);
  } catch {
    return null;
  }
  const path = join(directory, `${callId}.wav`);
  const temporaryPath = `${path}.part`;
  let descriptor;
  try {
    // The final .wav name is published only by close(). A retry worker can
    // therefore never mistake a file still being written for a completed call.
    descriptor = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch {
    return null;
  }
  const stream = createWriteStream(temporaryPath, { fd: descriptor, autoClose: true });
  let streamError;
  stream.on("error", (error) => { streamError = error; });
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
      await new Promise((resolve) => {
        if (stream.closed) return resolve();
        stream.once("close", resolve);
        stream.end();
      });
      if (streamError) throw streamError;
      if (!dataBytes) {
        await unlink(temporaryPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
        return 0;
      }
      // Размеры известны только в конце, поэтому правим заголовок на месте.
      const file = await open(temporaryPath, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        await file.write(header(dataBytes), 0, 44, 0);
        await file.sync();
      } finally {
        await file.close();
      }
      // Hard-link installation has O_EXCL semantics: a stale/final recording
      // is never overwritten. A crash after link() leaves a complete .wav that
      // the pre-created sidecar can recover on restart.
      await link(temporaryPath, path);
      await unlink(temporaryPath);
      const folder = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY).catch((error) => {
        if (["EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) return null;
        throw error;
      });
      if (folder) {
        try {
          await folder.sync().catch((error) => {
            if (!["EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) throw error;
          });
        } finally {
          await folder.close();
        }
      }
      return Math.round(dataBytes / (RATE * CHANNELS * 2) * 10) / 10;
    },
  };
}
