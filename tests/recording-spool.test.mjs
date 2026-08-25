import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("a crash after recorder.close leaves a tenant-bound retriable WAV", async () => {
  let putRequests = 0;
  const objectServer = createServer((request, response) => {
    if (request.method === "PUT") putRequests += 1;
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { etag: '"test-etag"' });
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    objectServer.once("error", reject);
    objectServer.listen(0, "127.0.0.1", resolve);
  });

  const address = objectServer.address();
  const directory = await mkdtemp(join(tmpdir(), "ascn-spool-crash-"));
  const callId = "11111111-2222-4333-8444-555555555555";
  const tenantId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const wavPath = join(directory, `${callId}.wav`);
  const partPath = `${wavPath}.part`;
  const sidecarPath = `${wavPath}.upload.json`;

  process.env.OBJECT_STORAGE_ENDPOINT = `http://127.0.0.1:${address.port}`;
  process.env.OBJECT_STORAGE_ALLOW_INSECURE_HTTP = "true";
  process.env.OBJECT_STORAGE_BUCKET = "ascn-test-recordings";
  process.env.OBJECT_STORAGE_ACCESS_KEY_ID = "test-access-key";
  process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY = "test-secret-key";
  process.env.OBJECT_STORAGE_REGION = "us-east-1";

  try {
    const { drainRecordingSpool, prepareRecordingArchive } = await import("../voice-gateway/object-storage.mjs");
    const { startRecording } = await import("../voice-gateway/recorder.mjs");

    await prepareRecordingArchive({ directory, tenantId, callId });
    const prepared = JSON.parse(await readFile(sidecarPath, "utf8"));
    assert.equal(prepared.state, "recording");
    assert.equal(prepared.tenantId, tenantId);

    const recorder = startRecording(directory, callId);
    assert.ok(recorder);
    await access(partPath);
    await assert.rejects(access(wavPath));

    const caller = Buffer.alloc(320);
    const agent = Buffer.alloc(320);
    for (let frame = 0; frame < 50; frame += 1) recorder.frame(caller, agent);
    assert.equal(await recorder.close(), 1);
    await access(wavPath);
    await assert.rejects(access(partPath));

    // Simulate process death here: archiveRecordingFile was never called.
    let acknowledged;
    const result = await drainRecordingSpool(directory, {
      onArchiveReady: async (archive) => { acknowledged = archive; },
      concurrency: 1,
    });
    assert.equal(result.committed, 1);
    assert.equal(putRequests, 1);
    assert.equal(acknowledged.callId, callId);
    assert.equal(acknowledged.tenantId, tenantId);
    assert.equal(acknowledged.recordedSeconds, 1);
    await assert.rejects(access(wavPath));
    await assert.rejects(access(sidecarPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
    await new Promise((resolve) => objectServer.close(resolve));
  }
});
