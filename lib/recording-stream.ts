import { getCallRecord } from "./calls.ts";
import { currentTenantId } from "./tenant-context.ts";
import { getRecordingObject, ObjectStorageError } from "./object-storage.ts";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

const legacyDataDirectory = process.env.LEGACY_DATA_DIR?.trim()
  || process.env.DATA_DIR?.trim()
  || path.join(process.cwd(), ".data");
const recordingsDirectory = path.join(legacyDataDirectory, "recordings");
const maximumRecordingBytes = 240_000_000;

function responseHeaders(length?: number) {
  const headers = new Headers({
    "content-type": "audio/wav",
    "cache-control": "private, max-age=3600",
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
  });
  if (typeof length === "number") headers.set("content-length", String(length));
  return headers;
}

function localRange(header: string | null, size: number) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return null;
    end = Math.min(end, size - 1);
  }
  if (start >= size || start < 0 || end < 0) return null;
  return { start, end, partial: true };
}

async function localRecording(file: string, rangeHeader: string | null) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0) {
      await handle.close();
      return null;
    }
    if (info.size > maximumRecordingBytes) {
      await handle.close();
      return new Response("Too large", { status: 413 });
    }
    const range = localRange(rangeHeader, info.size);
    if (!range) {
      await handle.close();
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${info.size}`, "accept-ranges": "bytes" },
      });
    }
    const headers = responseHeaders(range.end - range.start + 1);
    if (range.partial) headers.set("content-range", `bytes ${range.start}-${range.end}/${info.size}`);
    const stream = handle.createReadStream({
      start: range.start,
      end: range.end,
      autoClose: true,
    });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: range.partial ? 206 : 200,
      headers,
    });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") return null;
    throw error;
  }
}

// Отдача записи общая для двух роутов: авторизованного в панели и публичного
// по подписанной ссылке. Разница между ними только в проверке доступа, поэтому
// работа с object storage, range-запросами и legacy-каталогом живёт здесь.
// Вызывать строго внутри контекста тенанта: и S3 key, и каталог общие для процесса.
export async function recordingResponse(callId: string, range: string | null) {
  // Идентификатор подставляется в путь, поэтому пускаем только формат UUID.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callId)) {
    return new Response("Not found", { status: 404 });
  }
  if (!(await getCallRecord(callId))) return new Response("Not found", { status: 404 });
  try {
    const stored = await getRecordingObject(currentTenantId(), callId, range || undefined);
    if (stored) {
      const headers = responseHeaders(stored.contentLength);
      if (stored.contentRange) headers.set("content-range", stored.contentRange);
      if (stored.etag) headers.set("etag", stored.etag);
      return new Response(stored.body, { status: stored.status, headers });
    }
    // Мягкая миграция: старые WAV продолжают читаться с диска, но только при
    // честном 404 из object storage. Сбой S3 никогда не маскируется fallback-ом.
    const local = await localRecording(path.join(recordingsDirectory, `${callId.toLowerCase()}.wav`), range);
    return local || new Response("Not found", { status: 404 });
  } catch (error) {
    if (error instanceof ObjectStorageError) {
      const headers = error.status === 416 ? { "accept-ranges": "bytes" } : undefined;
      return new Response(error.status >= 500 ? "Recording storage unavailable" : error.message, { status: error.status, headers });
    }
    console.error("Recording read failed", error);
    return new Response("Recording storage unavailable", { status: 503 });
  }
}
