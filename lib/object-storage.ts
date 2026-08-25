import { GetObjectCommand, S3Client, type GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

const RECORDING_PREFIX = "recordings";
const DEFAULT_MAX_RECORDING_BYTES = 240_000_000;

type ObjectStorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  forcePathStyle: boolean;
  maxRecordingBytes: number;
};

export type RecordingObject = {
  body: ReadableStream<Uint8Array>;
  contentLength?: number;
  contentRange?: string;
  etag?: string;
  status: 200 | 206;
};

export class ObjectStorageError extends Error {
  readonly status: number;

  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, { cause: options?.cause });
    this.name = "ObjectStorageError";
    this.status = options?.status || 502;
  }
}

type ObjectStorageGlobals = typeof globalThis & {
  __ascnObjectStorageClient?: { fingerprint: string; client: S3Client };
};

const objectStorageGlobals = globalThis as ObjectStorageGlobals;

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function configuredObjectStorage(): ObjectStorageConfig | null {
  const values = {
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT?.trim() || "",
    bucket: process.env.OBJECT_STORAGE_BUCKET?.trim() || "",
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim() || "",
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim() || "",
  };
  const anyConfigured = Object.values(values).some(Boolean);
  if (!anyConfigured) return null;

  const missing = Object.entries(values).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new ObjectStorageError(`Object storage настроен не полностью: отсутствуют ${missing.join(", ")}`, { status: 503 });
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(values.bucket)) {
    throw new ObjectStorageError("OBJECT_STORAGE_BUCKET имеет недопустимый формат", { status: 503 });
  }
  if (/[/\r\n]/.test(values.accessKeyId) || /[\r\n]/.test(values.secretAccessKey)) {
    throw new ObjectStorageError("Object storage credentials имеют недопустимый формат", { status: 503 });
  }

  let endpoint: URL;
  try {
    endpoint = new URL(values.endpoint);
  } catch {
    throw new ObjectStorageError("OBJECT_STORAGE_ENDPOINT не является URL", { status: 503 });
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new ObjectStorageError("OBJECT_STORAGE_ENDPOINT не должен содержать credentials, query или fragment", { status: 503 });
  }
  const allowHttp = process.env.OBJECT_STORAGE_ALLOW_INSECURE_HTTP === "true";
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && allowHttp)) {
    throw new ObjectStorageError("Object storage требует HTTPS; для изолированной внутренней сети явно задайте OBJECT_STORAGE_ALLOW_INSECURE_HTTP=true", { status: 503 });
  }

  return {
    endpoint: endpoint.toString().replace(/\/$/, ""),
    region: process.env.OBJECT_STORAGE_REGION?.trim() || "us-east-1",
    bucket: values.bucket,
    accessKeyId: values.accessKeyId,
    secretAccessKey: values.secretAccessKey,
    sessionToken: process.env.OBJECT_STORAGE_SESSION_TOKEN?.trim() || undefined,
    forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE !== "false",
    maxRecordingBytes: positiveInteger(process.env.OBJECT_STORAGE_MAX_RECORDING_BYTES, DEFAULT_MAX_RECORDING_BYTES),
  };
}

function objectStorageClient(config: ObjectStorageConfig) {
  const credentialsHash = createHash("sha256")
    .update(`${config.accessKeyId}\0${config.secretAccessKey}\0${config.sessionToken || ""}`)
    .digest("hex");
  // В fingerprint хранится только необратимый hash, но runtime-ротация
  // credentials всё равно немедленно пересоздаёт client.
  const fingerprint = JSON.stringify([
    config.endpoint,
    config.region,
    config.bucket,
    config.forcePathStyle,
    credentialsHash,
  ]);
  if (objectStorageGlobals.__ascnObjectStorageClient?.fingerprint === fingerprint) {
    return objectStorageGlobals.__ascnObjectStorageClient.client;
  }
  objectStorageGlobals.__ascnObjectStorageClient?.client.destroy();
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
    },
    maxAttempts: 2,
  });
  objectStorageGlobals.__ascnObjectStorageClient = { fingerprint, client };
  return client;
}

function safeTenantSegment(tenantId: string) {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(tenantId)) {
    throw new ObjectStorageError("Tenant id имеет недопустимый формат", { status: 500 });
  }
  return tenantId;
}

function safeRecordingId(callId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callId)) {
    throw new ObjectStorageError("Recording id имеет недопустимый формат", { status: 404 });
  }
  return callId.toLowerCase();
}

export function recordingObjectKey(tenantId: string, callId: string) {
  return `${RECORDING_PREFIX}/${safeTenantSegment(tenantId)}/${safeRecordingId(callId)}.wav`;
}

function legacyRecordingObjectKey(callId: string) {
  return `${RECORDING_PREFIX}/${safeRecordingId(callId)}.wav`;
}

function validRange(range: string | undefined) {
  if (!range) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (!match[1] && !match[2])) {
    throw new ObjectStorageError("Некорректный Range", { status: 416 });
  }
  if (match[1] && match[2] && Number(match[1]) > Number(match[2])) {
    throw new ObjectStorageError("Некорректный Range", { status: 416 });
  }
  if ((match[1] && !Number.isSafeInteger(Number(match[1]))) || (match[2] && !Number.isSafeInteger(Number(match[2])))) {
    throw new ObjectStorageError("Некорректный Range", { status: 416 });
  }
  return `bytes=${match[1]}-${match[2]}`;
}

function isMissingObject(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const problem = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return problem.name === "NoSuchKey" || problem.name === "NotFound" || problem.$metadata?.httpStatusCode === 404;
}

function isInvalidRange(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const problem = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return problem.name === "InvalidRange" || problem.$metadata?.httpStatusCode === 416;
}

function webBody(body: GetObjectCommandOutput["Body"]) {
  if (!body) throw new ObjectStorageError("Object storage вернул пустой response body");
  const mixedBody = body as GetObjectCommandOutput["Body"] & { transformToWebStream?: () => ReadableStream<Uint8Array> };
  if (typeof mixedBody.transformToWebStream === "function") return mixedBody.transformToWebStream();
  if (body instanceof Readable) return Readable.toWeb(body) as ReadableStream<Uint8Array>;
  throw new ObjectStorageError("Object storage вернул неподдерживаемый response body");
}

async function getByKey(config: ObjectStorageConfig, key: string, range?: string): Promise<RecordingObject | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), positiveInteger(process.env.OBJECT_STORAGE_REQUEST_TIMEOUT_MS, 15_000));
  let output: GetObjectCommandOutput;
  try {
    output = await objectStorageClient(config).send(new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Range: validRange(range),
    }), { abortSignal: controller.signal });
  } catch (error) {
    if (isMissingObject(error)) return null;
    if (isInvalidRange(error)) throw new ObjectStorageError("Запрошенный диапазон вне файла", { cause: error, status: 416 });
    throw new ObjectStorageError("Не удалось прочитать запись из object storage", { cause: error });
  } finally {
    clearTimeout(timeout);
  }

  const contentLength = output.ContentLength;
  const totalLength = Number(/\/(\d+)$/.exec(output.ContentRange || "")?.[1] || contentLength);
  if (Number.isFinite(totalLength) && totalLength > config.maxRecordingBytes) {
    (output.Body as { destroy?: () => void } | undefined)?.destroy?.();
    throw new ObjectStorageError("Запись превышает разрешённый размер", { status: 413 });
  }
  return {
    body: webBody(output.Body),
    contentLength,
    contentRange: output.ContentRange,
    etag: output.ETag,
    status: output.ContentRange ? 206 : 200,
  };
}

/**
 * Возвращает tenant-scoped объект. Старый общий key проверяется только после
 * того, как route подтвердил владение call record текущим tenant-ом.
 * Ошибки S3 не маскируются локальным файлом: fallback разрешён лишь для 404.
 */
export async function getRecordingObject(tenantId: string, callId: string, range?: string) {
  const config = configuredObjectStorage();
  if (!config) return null;
  return await getByKey(config, recordingObjectKey(tenantId, callId), range)
    || await getByKey(config, legacyRecordingObjectKey(callId), range);
}

export function objectStorageEnabled() {
  return configuredObjectStorage() !== null;
}
