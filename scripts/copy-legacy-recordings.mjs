import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { constants } from "node:fs";

const sourceDirectory = resolve(process.env.LEGACY_RECORDINGS_SOURCE || "/legacy-source/recordings");
const destinationDirectory = resolve(process.env.LEGACY_RECORDINGS_DESTINATION || "/legacy-recordings");
const maximumBytes = 240_000_000;
const recordingName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$/i;
const markerPath = join(destinationDirectory, ".ascn-legacy-copy-v1.json");

async function openRegular(pathname) {
  const handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
  const info = await handle.stat();
  if (!info.isFile() || info.size < 44 || info.size > maximumBytes) {
    await handle.close();
    throw new Error(`invalid recording file: ${basename(pathname)}`);
  }
  return { handle, info };
}

async function hashFile(pathname) {
  const { handle, info } = await openRegular(pathname);
  const hash = createHash("sha256");
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return { size: info.size, sha256: hash.digest("hex") };
}

async function copyExclusive(sourcePath, destinationPath) {
  try {
    const [source, destination] = await Promise.all([hashFile(sourcePath), hashFile(destinationPath)]);
    if (source.size !== destination.size || source.sha256 !== destination.sha256) {
      throw new Error(`existing legacy recording differs: ${basename(destinationPath)}`);
    }
    return "existing";
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporaryPath = `${destinationPath}.${randomUUID()}.copy-part`;
  const source = await openRegular(sourcePath);
  const destination = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < source.info.size) {
      const { bytesRead } = await source.handle.read(buffer, 0, Math.min(buffer.length, source.info.size - position), position);
      if (!bytesRead) throw new Error(`recording truncated while copying: ${basename(sourcePath)}`);
      await destination.write(buffer, 0, bytesRead, position);
      position += bytesRead;
    }
    await destination.sync();
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  } finally {
    await Promise.allSettled([source.handle.close(), destination.close()]);
  }
  try {
    await link(temporaryPath, destinationPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const [sourceHash, destinationHash] = await Promise.all([hashFile(sourcePath), hashFile(destinationPath)]);
    if (sourceHash.size !== destinationHash.size || sourceHash.sha256 !== destinationHash.sha256) throw error;
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  return "copied";
}

async function completedMarker() {
  try {
    const handle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 4096) return null;
      const marker = JSON.parse(await handle.readFile("utf8"));
      return marker?.version === 1 && marker?.completed === true && marker?.sourceDirectory === sourceDirectory
        ? marker
        : null;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeMarker(marker) {
  const temporaryPath = `${markerPath}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try { await rename(temporaryPath, markerPath); } finally { await unlink(temporaryPath).catch(() => undefined); }
}

async function main() {
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  await chmod(destinationDirectory, 0o700);
  const marker = await completedMarker();
  if (marker) {
    console.log(JSON.stringify({ sourceDirectory, destinationDirectory, skipped: true, marker }));
    return;
  }
  let entries;
  try {
    entries = await readdir(sourceDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") entries = [];
    else throw error;
  }

  let copied = 0;
  let existing = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !recordingName.test(entry.name)) continue;
    const normalizedName = entry.name.toLowerCase();
    const result = await copyExclusive(join(sourceDirectory, entry.name), join(destinationDirectory, normalizedName));
    if (result === "copied") copied += 1;
    else existing += 1;
  }
  await writeMarker({ version: 1, completed: true, sourceDirectory, files: copied + existing, completedAt: new Date().toISOString() });
  const destinationFolder = await open(destinationDirectory, constants.O_RDONLY | constants.O_DIRECTORY).catch((error) => {
    if (["EINVAL", "ENOTSUP", "EPERM"].includes(error?.code)) return null;
    throw error;
  });
  if (destinationFolder) {
    try { await destinationFolder.sync(); } finally { await destinationFolder.close(); }
  }
  console.log(JSON.stringify({ sourceDirectory, destinationDirectory, copied, existing }));
}

await main();
