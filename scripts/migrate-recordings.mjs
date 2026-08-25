import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import pg from "pg";

const { Pool } = pg;
const CALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_ID_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_RECORDING_BYTES = 240_000_000;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function storageConfiguration() {
  const endpointValue = required("OBJECT_STORAGE_ENDPOINT");
  let endpoint;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new Error("OBJECT_STORAGE_ENDPOINT must be a valid URL");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("OBJECT_STORAGE_ENDPOINT must not contain credentials, query, or fragment");
  }
  if (endpoint.protocol !== "https:"
    && !(endpoint.protocol === "http:" && process.env.OBJECT_STORAGE_ALLOW_INSECURE_HTTP === "true")) {
    throw new Error("object storage requires HTTPS (or OBJECT_STORAGE_ALLOW_INSECURE_HTTP=true)");
  }

  const bucket = required("OBJECT_STORAGE_BUCKET");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error("OBJECT_STORAGE_BUCKET is invalid");
  }
  const accessKeyId = required("OBJECT_STORAGE_ACCESS_KEY_ID");
  const secretAccessKey = required("OBJECT_STORAGE_SECRET_ACCESS_KEY");
  if (/[/\r\n]/.test(accessKeyId) || /[\r\n]/.test(secretAccessKey)) {
    throw new Error("object storage credentials are invalid");
  }

  const serverSideEncryption = process.env.OBJECT_STORAGE_SERVER_SIDE_ENCRYPTION?.trim() || undefined;
  if (serverSideEncryption && !["AES256", "aws:kms"].includes(serverSideEncryption)) {
    throw new Error("OBJECT_STORAGE_SERVER_SIDE_ENCRYPTION must be AES256 or aws:kms");
  }
  const sseKmsKeyId = process.env.OBJECT_STORAGE_SSE_KMS_KEY_ID?.trim() || undefined;
  if (serverSideEncryption === "aws:kms" && !sseKmsKeyId) {
    throw new Error("OBJECT_STORAGE_SSE_KMS_KEY_ID is required for aws:kms");
  }

  return {
    endpoint: endpoint.toString().replace(/\/$/, ""),
    region: process.env.OBJECT_STORAGE_REGION?.trim() || "us-east-1",
    bucket,
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.OBJECT_STORAGE_SESSION_TOKEN?.trim() || undefined,
    forcePathStyle: process.env.OBJECT_STORAGE_FORCE_PATH_STYLE !== "false",
    serverSideEncryption,
    sseKmsKeyId,
  };
}

function legacyDirectory() {
  const configured = required("LEGACY_RECORDINGS_DIR");
  if (!isAbsolute(configured)) throw new Error("LEGACY_RECORDINGS_DIR must be an absolute path");
  const directory = resolve(configured);
  if (directory === "/") throw new Error("LEGACY_RECORDINGS_DIR must not be the filesystem root");
  return directory;
}

function migrationMarkerPath() {
  const configured = process.env.MIGRATION_MARKER_PATH?.trim() || "/migration-state/recordings-v1.json";
  if (!isAbsolute(configured)) throw new Error("MIGRATION_MARKER_PATH must be an absolute path");
  const markerPath = resolve(configured);
  if (markerPath === "/") throw new Error("MIGRATION_MARKER_PATH must not be the filesystem root");
  return markerPath;
}

function markerMatches(marker, identity) {
  return marker?.version === 1
    && marker?.completed === true
    && marker?.endpoint === identity.endpoint
    && marker?.bucket === identity.bucket
    && marker?.legacyDirectory === identity.legacyDirectory;
}

async function completedMarker(markerPath, identity) {
  try {
    const handle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size < 2 || info.size > 4096) return null;
      try {
        const marker = JSON.parse(await handle.readFile("utf8"));
        return markerMatches(marker, identity) ? marker : null;
      } catch (error) {
        if (error instanceof SyntaxError) return null;
        throw error;
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function syncDirectory(directoryPath) {
  const handle = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY).catch((error) => {
    if (["EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) return null;
    throw error;
  });
  if (!handle) return;
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeCompletedMarker(markerPath, marker) {
  const markerDirectory = dirname(markerPath);
  await mkdir(markerDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${markerPath}.${randomUUID()}.tmp`;
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, markerPath);
    await syncDirectory(markerDirectory);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function recordingCandidates(directory, maximum) {
  const candidates = [];
  let handle;
  try {
    handle = await opendir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") return candidates;
    throw error;
  }
  for await (const entry of handle) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".wav")) continue;
    const callId = entry.name.slice(0, -4).toLowerCase();
    if (!CALL_ID_PATTERN.test(callId)) continue;
    candidates.push({ callId, filePath: join(directory, entry.name) });
    if (candidates.length > maximum) {
      throw new Error(`more than ${maximum} legacy WAV files found; raise MIGRATION_MAX_FILES explicitly`);
    }
  }
  candidates.sort((left, right) => left.callId.localeCompare(right.callId));
  return candidates;
}

async function tenantMappings(pool, candidates, batchSize) {
  const tenantsByCall = new Map();
  for (let offset = 0; offset < candidates.length; offset += batchSize) {
    const ids = candidates.slice(offset, offset + batchSize).map(({ callId }) => callId);
    const result = await pool.query(
      `SELECT id,
              min(tenant_id) AS tenant_id,
              count(DISTINCT tenant_id) AS tenant_count
       FROM ascn_call_records
       WHERE id = ANY($1::text[])
       GROUP BY id
       ORDER BY id`,
      [ids],
    );
    for (const row of result.rows) {
      tenantsByCall.set(String(row.id), {
        tenantId: String(row.tenant_id),
        count: Number(row.tenant_count),
      });
    }
  }
  return tenantsByCall;
}

function objectKey(tenantId, callId) {
  if (!TENANT_ID_PATTERN.test(tenantId)) throw new Error(`invalid tenant id for call ${callId}`);
  return `recordings/${tenantId}/${callId}.wav`;
}

function notFound(error) {
  return error?.name === "NotFound"
    || error?.name === "NoSuchKey"
    || error?.$metadata?.httpStatusCode === 404;
}

function preconditionConflict(error) {
  return error?.$metadata?.httpStatusCode === 409
    || error?.$metadata?.httpStatusCode === 412
    || error?.name === "PreconditionFailed"
    || error?.name === "ConditionalRequestConflict";
}

async function headObject(s3, config, key) {
  try {
    return await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

function objectMatches(head, size, checksumHex) {
  return head
    && Number(head.ContentLength) === size
    && String(head.Metadata?.sha256 || "").toLowerCase() === checksumHex;
}

async function checksum(handle, size) {
  const hash = createHash("sha256");
  const stream = handle.createReadStream({ autoClose: false, start: 0, end: size - 1 });
  for await (const chunk of stream) hash.update(chunk);
  const digest = hash.digest();
  return { hex: digest.toString("hex"), base64: digest.toString("base64") };
}

function sameFile(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function migrateOne(s3, config, candidate, tenantId, maximumBytes) {
  const key = objectKey(tenantId, candidate.callId);
  const handle = await open(candidate.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    const size = Number(before.size);
    if (!before.isFile() || size < 44) throw new Error("not a valid WAV file");
    if (!Number.isSafeInteger(size) || size > maximumBytes) {
      throw new Error(`recording exceeds ${maximumBytes} bytes`);
    }

    const header = Buffer.alloc(12);
    const headerRead = await handle.read(header, 0, header.length, 0);
    if (headerRead.bytesRead !== 12 || header.toString("ascii", 0, 4) !== "RIFF"
      || header.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("invalid WAV header");
    }

    const digest = await checksum(handle, size);
    const existing = await headObject(s3, config, key);
    if (existing) {
      if (!objectMatches(existing, size, digest.hex)) throw new Error("immutable object conflict");
      return { state: "present", key, bytes: size, sha256: digest.hex };
    }

    try {
      await s3.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: handle.createReadStream({ autoClose: false, start: 0, end: size - 1 }),
        ContentLength: size,
        ContentType: "audio/wav",
        CacheControl: "private, max-age=3600",
        IfNoneMatch: "*",
        ChecksumSHA256: digest.base64,
        Metadata: { sha256: digest.hex, source: "legacy-migration" },
        ServerSideEncryption: config.serverSideEncryption,
        SSEKMSKeyId: config.sseKmsKeyId,
      }));
    } catch (error) {
      if (!preconditionConflict(error)) throw error;
      const raced = await headObject(s3, config, key);
      if (!objectMatches(raced, size, digest.hex)) throw new Error("immutable object conflict after concurrent upload");
      return { state: "present", key, bytes: size, sha256: digest.hex };
    }

    const after = await handle.stat({ bigint: true });
    if (!sameFile(before, after)) throw new Error("legacy WAV changed while it was being migrated");
    const uploaded = await headObject(s3, config, key);
    if (!objectMatches(uploaded, size, digest.hex)) throw new Error("uploaded object failed HEAD checksum verification");
    return { state: "uploaded", key, bytes: size, sha256: digest.hex };
  } finally {
    await handle.close();
  }
}

function safeError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 400) : "unknown error";
}

async function main() {
  const databaseUrl = required("DATABASE_URL");
  const directory = legacyDirectory();
  const config = storageConfiguration();
  const markerPath = migrationMarkerPath();
  const markerIdentity = {
    endpoint: config.endpoint,
    bucket: config.bucket,
    legacyDirectory: directory,
  };
  const marker = await completedMarker(markerPath, markerIdentity);
  if (marker) {
    process.stdout.write(`${JSON.stringify({ recordingMigrationSkipped: true, markerPath, marker })}\n`);
    return;
  }
  const concurrency = boundedInteger("MIGRATION_CONCURRENCY", 4, 1, 32);
  const maximumFiles = boundedInteger("MIGRATION_MAX_FILES", DEFAULT_MAX_FILES, 1, 1_000_000);
  const maximumBytes = boundedInteger(
    "OBJECT_STORAGE_MAX_RECORDING_BYTES",
    DEFAULT_MAX_RECORDING_BYTES,
    44,
    2_000_000_000,
  );
  const queryBatchSize = boundedInteger("MIGRATION_QUERY_BATCH_SIZE", 500, 1, 5_000);
  const allowOrphanRecordings = process.env.ALLOW_ORPHAN_RECORDINGS === "true";
  const candidates = await recordingCandidates(directory, maximumFiles);
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: /^(1|true|required)$/i.test(process.env.DATABASE_SSL?.trim() || "")
      ? { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" }
      : undefined,
    max: 2,
    connectionTimeoutMillis: 10_000,
    application_name: "ascn-recording-migration",
  });
  const s3 = new S3Client({
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
  const summary = {
    scanned: candidates.length,
    uploaded: 0,
    present: 0,
    missingDatabaseRecord: 0,
    ambiguousTenant: 0,
    failed: 0,
    allowOrphanRecordings,
    failures: [],
  };
  const appendFailure = (failure) => {
    if (summary.failures.length < 100) summary.failures.push(failure);
  };

  try {
    const tenantsByCall = await tenantMappings(pool, candidates, queryBatchSize);
    const jobs = [];
    for (const candidate of candidates) {
      const tenant = tenantsByCall.get(candidate.callId);
      if (!tenant) {
        summary.missingDatabaseRecord += 1;
        if (!allowOrphanRecordings) {
          appendFailure({ callId: candidate.callId, error: "legacy WAV has no tenant-scoped call record" });
        }
        continue;
      }
      if (tenant.count !== 1) {
        summary.ambiguousTenant += 1;
        appendFailure({ callId: candidate.callId, error: "call id belongs to multiple tenants" });
        continue;
      }
      jobs.push({ candidate, tenantId: tenant.tenantId });
    }

    let nextJob = 0;
    async function worker() {
      while (nextJob < jobs.length) {
        const job = jobs[nextJob++];
        try {
          const result = await migrateOne(s3, config, job.candidate, job.tenantId, maximumBytes);
          summary[result.state] += 1;
          process.stdout.write(`${JSON.stringify({ callId: job.candidate.callId, tenantId: job.tenantId, ...result })}\n`);
        } catch (error) {
          summary.failed += 1;
          appendFailure({ callId: job.candidate.callId, error: safeError(error) });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length || 1) }, () => worker()));
  } finally {
    await pool.end();
    s3.destroy();
  }

  process.stdout.write(`${JSON.stringify({ migrationSummary: summary })}\n`);
  const unsuccessful = summary.failed || summary.ambiguousTenant
    || (summary.missingDatabaseRecord && !allowOrphanRecordings);
  if (unsuccessful) {
    process.exitCode = 1;
    return;
  }
  await writeCompletedMarker(markerPath, {
    version: 1,
    completed: true,
    ...markerIdentity,
    scanned: summary.scanned,
    uploaded: summary.uploaded,
    present: summary.present,
    missingDatabaseRecord: summary.missingDatabaseRecord,
    allowOrphanRecordings,
    completedAt: new Date().toISOString(),
  });
}

main().catch((error) => {
  process.stderr.write(`recording migration failed: ${safeError(error)}\n`);
  process.exitCode = 1;
});
