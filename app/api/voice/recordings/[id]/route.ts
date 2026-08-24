import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const recordingsDirectory = path.join(process.env.DATA_DIR?.trim() || path.join(process.cwd(), ".data"), "recordings");

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  // Идентификатор подставляется в путь, поэтому пускаем только формат UUID.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const file = path.join(recordingsDirectory, `${id}.wav`);
  try {
    const info = await stat(file);
    // Разговоры короткие, файл читаем целиком: так проще и не течёт поток.
    if (info.size > 60_000_000) return new Response("Too large", { status: 413 });
    return new Response(await readFile(file), {
      headers: {
        "content-type": "audio/wav",
        "content-length": String(info.size),
        "cache-control": "private, max-age=3600",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
