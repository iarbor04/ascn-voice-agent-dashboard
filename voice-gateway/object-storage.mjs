import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, link, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

// 8 kHz * 2 channels * 16-bit PCM * 7,200 seconds + WAV header = 230,400,044.
const DEFAULT_MAX_RECORDING_BYTES = 240_000_000;
const SIDECAR_SUFFIX = ".wav.upload.json";
let cachedClient;
let cachedFingerprint = "";
const activeArchives = new Map();
let retryScanCursor = 0;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function configuration() {
  const values = {
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT?.trim() || "",
    bucket: process.env.OBJECT_STORAGE_BUCKET?.trim() || "",
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim() || "",
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim() || "",
  };
  if (!Object.values(values).some(Boolean)) return null;
  const missing = Object.entries(values).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`object storage is incomplete: missing ${missing.join(", ")}`);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(values.bucket)) throw new Error("invalid OBJECT_STORAGE_BUCKET");
  if (/[/\r\n]/.test(values.accessKeyId) || /[\r\n]/.test(values.secretAccessKey)) throw new Error("invalid object storage credentials");

  let endpoint;
  try {
    endpoint = new URL(values.endpoint);
  } catch {
    throw new Error("OBJECT_STORAGE_ENDPOINT is not a URL");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("OBJECT_STORAGE_ENDPOINT must not contain credentials, query, or fragment");
  }
  const allowHttp = process.env.OBJECT_STORAGE_ALLOW_INSECURE_HTTP === "true";
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && allowHttp)) {
    throw new Error("object storage requires HTTPS (or explicit OBJECT_STORAGE_ALLOW_INSECURE_HTTP=true)");
  }

  const serverSideEncryption = process.env.OBJECT_STORAGE_SERVER_SIDE_ENCRYPTION?.trim() || undefined;
  if (serverSideEncryption && serverSideEncryption !== "AES256" && serverSideEncryption !== "aws:kms") {
    throw new Error("OBJECT_STORAGE_SERVER_SIDE_ENCRYPTION must be AES256 or aws:kms");
  }
  const sseKmsKeyId = process.env.OBJECT_STORAGE_SSE_KMS_KEY_ID?.trim() || undefined;
  if (serverSideEncryption === "aws:kms" && !sseKmsKeyId) {
    throw new Error("OBJECT_STORAGE_SSE_KMS_KEY_ID is required for aws:kms");
  }

  return {
    endpoint: endpoint.toString().replace(/\/$/, ""),
    region: process.env.OBJECT_STORAGE_REGION?.trim() || "us-east-1",
    bucket: values.bucket,
    accessKeyId: values.accessKeyId,
    secretAccessKey: values.secretAccessKey,
    sessionToken: process.env.OBJECT_STORAGE_SESSION_TOKEN?.trim() || undefined,
    forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE !== "false",
    serverSideEncryption,
    sseKmsKeyId,
    maxRecordingBytes: positiveInteger(process.env.OBJECT_STORAGE_MAX_RECORDING_BYTES, DEFAULT_MAX_RECORDING_BYTES),
  };
}

function client(config) {
  const credentialsHash = createHash("sha256")
    .update(`${config.accessKeyId}\0${config.secretAccessKey}\0${config.sessionToken || ""}`)
    .digest("hex");
  const fingerprint = JSON.stringify([
    config.endpoint,
    config.region,
    config.bucket,
    config.forcePathStyle,
    credentialsHash,
  ]);
  if (cachedClient && cachedFingerprint === fingerprint) return cachedClient;
  cachedClient?.destroy();
  cachedClient = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
    },
    maxAttempts: 3,
  });
  cachedFingerprint = fingerprint;
  return cachedClient;
}

function recordingKey(tenantId, callId) {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(tenantId || "")) throw new Error("invalid recording tenant id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(callId || "")) {
    throw new Error("invalid recording call id");
  }
  return `recordings/${tenantId}/${callId.toLowerCase()}.wav`;
}

function archivePaths({ filePath, tenantId, callId, recordedSeconds }) {
  const normalizedCallId = String(callId || "").toLowerCase();
  // Also validates tenantId and callId before either reaches a path or sidecar.
  recordingKey(tenantId, normalizedCallId);
  const absoluteFilePath = resolve(String(filePath || ""));
  if (basename(absoluteFilePath).toLowerCase() !== `${normalizedCallId}.wav`) {
    throw new Error("recording file name does not match call id");
  }
  return {
    filePath: absoluteFilePath,
    sidecarPath: `${absoluteFilePath}.upload.json`,
    tenantId,
    callId: normalizedCallId,
    recordedSeconds: Number(recordedSeconds) || 0,
  };
}

async function atomicWrite(pathname, contents, exclusive) {
  const temporary = `${pathname}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (exclusive) await link(temporary, pathname);
    else await rename(temporary, pathname);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  const directory = await open(dirname(pathname), constants.O_RDONLY | constants.O_DIRECTORY).catch((error) => {
    if (["EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) return null;
    throw error;
  });
  if (directory) {
    try {
      await directory.sync().catch((error) => {
        if (!["EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) throw error;
      });
    } finally {
      await directory.close();
    }
  }
}

async function readSidecar(sidecarPath) {
  const handle = await open(sidecarPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 2 || info.size > 4096) throw new Error("invalid recording upload sidecar size");
    const parsed = JSON.parse(await handle.readFile("utf8"));
    const validDuration = parsed?.state === "recording"
      ? parsed.recordedSeconds === undefined || parsed.recordedSeconds === 0
      : Number.isFinite(parsed?.recordedSeconds) && parsed.recordedSeconds > 0 && parsed.recordedSeconds <= 7200;
    if (parsed?.version !== 1 || !["recording", "queued", "uploaded"].includes(parsed?.state)
      || !/^[a-zA-Z0-9._-]{1,128}$/.test(parsed?.tenantId || "")
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parsed?.callId || "")
      || !validDuration) {
      throw new Error("invalid recording upload sidecar");
    }
    return parsed;
  } finally {
    await handle.close();
  }
}

function queuedSidecar(paths, createdAt = new Date().toISOString()) {
  return {
    version: 1,
    state: "queued",
    tenantId: paths.tenantId,
    callId: paths.callId,
    recordedSeconds: paths.recordedSeconds,
    createdAt,
  };
}

async function promoteSidecarToQueued(paths, existing) {
  if (existing.tenantId !== paths.tenantId || existing.callId !== paths.callId) {
    throw new Error("recording upload sidecar conflicts with the requested archive");
  }
  if (existing.state !== "recording") return existing;
  const queued = queuedSidecar(paths, existing.createdAt);
  await atomicWrite(paths.sidecarPath, `${JSON.stringify(queued)}\n`, false);
  return queued;
}

async function ensureQueuedSidecar(paths) {
  if (!Number.isFinite(paths.recordedSeconds) || paths.recordedSeconds <= 0 || paths.recordedSeconds > 7200) {
    throw new Error("recordedSeconds is required for durable recording commit");
  }
  const queued = queuedSidecar(paths);
  try {
    await atomicWrite(paths.sidecarPath, `${JSON.stringify(queued)}\n`, true);
    return queued;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readSidecar(paths.sidecarPath);
    const promoted = await promoteSidecarToQueued(paths, existing);
    if (promoted.recordedSeconds !== paths.recordedSeconds) {
      throw new Error("recording upload sidecar conflicts with the requested archive");
    }
    return promoted;
  }
}

/**
 * Writes tenant/call binding before the recorder opens its temporary file.
 * A completed WAV can therefore be recovered after a crash without guessing a
 * tenant from a DID or from an untrusted path.
 */
export async function prepareRecordingArchive({ directory, tenantId, callId }) {
  if (!configuration()) return { prepared: false, disabled: true, filePath: "" };
  if (!directory) throw new Error("RECORDINGS_DIR is required before recording");
  const spoolDirectory = resolve(directory);
  await mkdir(spoolDirectory, { recursive: true, mode: 0o700 });
  await chmod(spoolDirectory, 0o700);
  const normalizedCallId = String(callId || "").toLowerCase();
  const paths = archivePaths({
    filePath: join(spoolDirectory, `${normalizedCallId}.wav`),
    tenantId,
    callId: normalizedCallId,
    recordedSeconds: 0,
  });
  return exclusiveArchive(paths.sidecarPath, async () => {
    const sidecar = {
      version: 1,
      state: "recording",
      tenantId: paths.tenantId,
      callId: paths.callId,
      createdAt: new Date().toISOString(),
    };
    try {
      await atomicWrite(paths.sidecarPath, `${JSON.stringify(sidecar)}\n`, true);
      return { prepared: true, disabled: false, filePath: paths.filePath };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readSidecar(paths.sidecarPath);
      if (existing.tenantId !== paths.tenantId || existing.callId !== paths.callId) {
        throw new Error("recording preparation conflicts with existing retry metadata");
      }
      return { prepared: true, disabled: false, recovered: true, filePath: paths.filePath };
    }
  });
}

async function markSidecarUploaded(paths, result, createdAt) {
  const uploaded = {
    version: 1,
    state: "uploaded",
    tenantId: paths.tenantId,
    callId: paths.callId,
    recordedSeconds: paths.recordedSeconds,
    createdAt,
    uploadedAt: new Date().toISOString(),
    key: result.key,
    bytes: result.bytes,
    sha256: result.sha256,
  };
  await atomicWrite(paths.sidecarPath, `${JSON.stringify(uploaded)}\n`, false);
  return uploaded;
}

async function removeIfPresent(pathname) {
  await unlink(pathname).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function finishCommittedArchive(paths) {
  if (process.env.OBJECT_STORAGE_KEEP_LOCAL_COPY !== "true") await removeIfPresent(paths.filePath);
  await removeIfPresent(paths.sidecarPath);
}

function exclusiveArchive(sidecarPath, operation, waitForExisting = true) {
  const existing = activeArchives.get(sidecarPath);
  if (existing) return waitForExisting ? existing : Promise.resolve({ skipped: true });
  const running = operation().finally(() => {
    if (activeArchives.get(sidecarPath) === running) activeArchives.delete(sidecarPath);
  });
  activeArchives.set(sidecarPath, running);
  return running;
}

async function sha256File(pathname) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(pathname)) hash.update(chunk);
  return { hex: hash.digest("hex") };
}

async function completedRecordingSeconds(pathname) {
  const handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 48) throw new Error("completed recording is too small");
    const header = Buffer.alloc(44);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const dataBytes = header.readUInt32LE(40);
    if (bytesRead !== header.length
      || header.subarray(0, 4).toString() !== "RIFF"
      || header.subarray(8, 12).toString() !== "WAVE"
      || header.subarray(12, 16).toString() !== "fmt "
      || header.readUInt16LE(20) !== 1
      || header.readUInt16LE(22) !== 2
      || header.readUInt32LE(24) !== 8000
      || header.readUInt16LE(34) !== 16
      || header.subarray(36, 40).toString() !== "data"
      || dataBytes <= 0
      || dataBytes % 4 !== 0
      || dataBytes + 44 !== info.size) {
      throw new Error("recording is not a finalized ASCN WAV");
    }
    const seconds = Math.round(dataBytes / 32_000 * 10) / 10;
    if (seconds <= 0 || seconds > 7200) throw new Error("completed recording duration is outside limits");
    return seconds;
  } finally {
    await handle.close();
  }
}

function preconditionFailed(error) {
  return error && typeof error === "object" && error.$metadata?.httpStatusCode === 412;
}

async function existingObjectMatches(config, key, size, checksum) {
  const output = await client(config).send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
  return output.ContentLength === size && output.Metadata?.sha256 === checksum;
}

/**
 * Uploads one closed WAV with a tenant-scoped, immutable key. A retry after an
 * acknowledged/lost response is accepted only when HEAD proves that size and
 * SHA-256 match; an unrelated existing object is never overwritten.
 */
export async function uploadRecordingFile({ filePath, tenantId, callId }) {
  const config = configuration();
  if (!config) return { uploaded: false, disabled: true, key: "" };
  const key = recordingKey(tenantId, callId);
  const info = await stat(filePath);
  if (!info.isFile() || info.size < 44) throw new Error("recording is not a valid WAV file");
  if (info.size > config.maxRecordingBytes) throw new Error("recording exceeds OBJECT_STORAGE_MAX_RECORDING_BYTES");
  const checksum = (await sha256File(filePath)).hex;

  try {
    await client(config).send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: createReadStream(filePath),
      ContentLength: info.size,
      ContentType: "audio/wav",
      CacheControl: "private, max-age=3600",
      IfNoneMatch: "*",
      Metadata: { sha256: checksum },
      ServerSideEncryption: config.serverSideEncryption,
      SSEKMSKeyId: config.sseKmsKeyId,
    }));
  } catch (error) {
    if (!preconditionFailed(error) || !(await existingObjectMatches(config, key, info.size, checksum))) throw error;
  }
  return { uploaded: true, disabled: false, key, bytes: info.size, sha256: checksum };
}

async function processArchive(paths, sidecar) {
  if (sidecar.state === "uploaded") {
    return {
      uploaded: true,
      recovered: true,
      disabled: false,
      readyToCommit: true,
      key: sidecar.key || "",
      archive: sidecar,
    };
  }
  const result = await uploadRecordingFile(paths);
  if (!result.uploaded) return result;
  const uploadedSidecar = await markSidecarUploaded(paths, result, sidecar.createdAt);
  return { ...result, readyToCommit: true, archive: uploadedSidecar };
}

/**
 * Promotes pre-recording metadata to queued before the first upload. Only a
 * closed recorder calls this function; the final .wav name is the durable
 * "safe to scan" marker.
 */
export async function archiveRecordingFile(details) {
  if (!configuration()) return { uploaded: false, disabled: true, key: "" };
  const paths = archivePaths(details);
  return exclusiveArchive(paths.sidecarPath, async () => {
    const sidecar = await ensureQueuedSidecar(paths);
    return processArchive(paths, sidecar);
  });
}

/** Removes retry state only after the app has acknowledged recorded_seconds. */
export async function commitRecordingArchive(details) {
  const paths = archivePaths(details);
  return exclusiveArchive(paths.sidecarPath, async () => {
    const sidecar = await readSidecar(paths.sidecarPath);
    if (sidecar.state !== "uploaded" || sidecar.tenantId !== paths.tenantId || sidecar.callId !== paths.callId) {
      throw new Error("recording archive is not ready to commit");
    }
    await finishCommittedArchive(paths);
    return { committed: true, key: sidecar.key || "" };
  });
}

function bounded(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isSafeInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function safeFailure(error) {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unknown upload error";
}

/**
 * Scans only durable sidecars. Recorders write to .wav.part and publish the
 * final .wav atomically, so a state=recording sidecar plus final WAV is a safe
 * crash-recovery candidate, never an actively-written file. Individual
 * failures are retained and do not block other jobs.
 */
export async function drainRecordingSpool(directory, options = {}) {
  if (!configuration()) return { disabled: true, scanned: 0, uploaded: 0, recovered: 0, committed: 0, awaitingCommit: 0, skipped: 0, failed: 0, failures: [] };
  if (!directory) throw new Error("RECORDINGS_DIR is required for the recording retry worker");
  const spoolDirectory = resolve(directory);
  let entries;
  try {
    entries = await readdir(spoolDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { disabled: false, scanned: 0, uploaded: 0, recovered: 0, committed: 0, awaitingCommit: 0, skipped: 0, failed: 0, failures: [] };
    throw error;
  }

  const scanLimit = bounded(options.scanLimit || process.env.OBJECT_STORAGE_UPLOAD_SCAN_LIMIT, 500, 1, 5000);
  const allSidecars = entries
    .filter((entry) => entry.isFile() && /^[0-9a-f-]{36}\.wav\.upload\.json$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const sidecars = [];
  for (let offset = 0; offset < Math.min(scanLimit, allSidecars.length); offset += 1) {
    sidecars.push(allSidecars[(retryScanCursor + offset) % allSidecars.length]);
  }
  if (allSidecars.length) retryScanCursor = (retryScanCursor + sidecars.length) % allSidecars.length;
  const summary = { disabled: false, scanned: sidecars.length, uploaded: 0, recovered: 0, committed: 0, awaitingCommit: 0, skipped: 0, failed: 0, failures: [] };
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < sidecars.length) {
      const entry = sidecars[nextIndex++];
      const sidecarPath = join(spoolDirectory, entry.name);
      try {
        const fileCallId = entry.name.slice(0, -SIDECAR_SUFFIX.length);
        const result = await exclusiveArchive(sidecarPath, async () => {
          let sidecar = await readSidecar(sidecarPath);
          if (fileCallId.toLowerCase() !== sidecar.callId) throw new Error("sidecar call id does not match its file name");
          const filePath = join(spoolDirectory, `${fileCallId}.wav`);
          let recordedSeconds = sidecar.recordedSeconds;
          if (sidecar.state === "recording") recordedSeconds = await completedRecordingSeconds(filePath);
          const paths = archivePaths({
            filePath,
            tenantId: sidecar.tenantId,
            callId: sidecar.callId,
            recordedSeconds,
          });
          if (sidecar.state === "recording") sidecar = await promoteSidecarToQueued(paths, sidecar);
          const archived = await processArchive(paths, sidecar);
          if (!archived.readyToCommit || typeof options.onArchiveReady !== "function") return archived;
          // recorded_seconds is an idempotent assignment. A crash after this ACK
          // merely repeats it; the sidecar is deleted only afterwards.
          await options.onArchiveReady(archived.archive);
          await finishCommittedArchive(paths);
          return { ...archived, committed: true };
        }, false);
        if (result.skipped) summary.skipped += 1;
        else {
          if (result.recovered) summary.recovered += 1;
          else if (result.uploaded) summary.uploaded += 1;
          if (result.committed) summary.committed += 1;
          else if (result.readyToCommit) summary.awaitingCommit += 1;
        }
      } catch (error) {
        summary.failed += 1;
        if (summary.failures.length < 20) summary.failures.push({ sidecar: entry.name, error: safeFailure(error) });
      }
    }
  }

  const concurrency = Math.min(
    sidecars.length || 1,
    bounded(options.concurrency || process.env.OBJECT_STORAGE_UPLOAD_CONCURRENCY, 2, 1, 8),
  );
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return summary;
}

/** Starts one immediate drain and a non-overlapping, unref'd retry interval. */
export function startRecordingSpoolRetryWorker(directory, options = {}) {
  const intervalMs = bounded(options.intervalMs || process.env.OBJECT_STORAGE_UPLOAD_RETRY_MS, 60_000, 10_000, 3_600_000);
  let stopped = false;
  let running;
  const runNow = () => {
    if (stopped) return Promise.resolve(null);
    if (running) return running;
    running = drainRecordingSpool(directory, options)
      .then((result) => { options.onResult?.(result); return result; })
      .catch((error) => { options.onError?.(error); return null; })
      .finally(() => { running = undefined; });
    return running;
  };
  void runNow();
  const timer = setInterval(() => { void runNow(); }, intervalMs);
  timer.unref();
  return {
    runNow,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
