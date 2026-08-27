import {
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  id: string;
  createdAt: number;
  raw: string;
}

export class OutputCache {
  private readonly directory = join(
    tmpdir(),
    "pi-context-manager",
    String(process.pid),
  );

  async save(raw: string): Promise<string> {
    await this.ensureDirectory();
    await this.cleanup();
    const id = `output-${randomUUID().slice(0, 8)}`;
    const entry: CacheEntry = { id, createdAt: Date.now(), raw };
    await writeFile(
      join(this.directory, `${id}.json`),
      JSON.stringify(entry),
      "utf8",
    );
    return id;
  }

  async get(id: string): Promise<string | null> {
    if (!/^output-[a-f0-9-]+$/.test(id)) return null;
    try {
      const filePath = join(this.directory, `${id}.json`);
      const metadata = await stat(filePath);
      if (Date.now() - metadata.mtimeMs > CACHE_TTL_MS) {
        await unlink(filePath).catch(() => undefined);
        return null;
      }
      const entry = JSON.parse(await readFile(filePath, "utf8")) as CacheEntry;
      return typeof entry.raw === "string" ? entry.raw : null;
    } catch {
      return null;
    }
  }

  async remove(id: string): Promise<void> {
    if (!/^output-[a-f0-9-]+$/.test(id)) return;
    await unlink(join(this.directory, `${id}.json`)).catch(() => undefined);
  }

  async cleanup(): Promise<void> {
    await this.ensureDirectory();
    const files = await readdir(this.directory).catch(() => []);
    await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          const filePath = join(this.directory, file);
          try {
            const metadata = await stat(filePath);
            if (Date.now() - metadata.mtimeMs > CACHE_TTL_MS)
              await unlink(filePath);
          } catch {
            // Ignore files removed concurrently or inaccessible cache entries.
          }
        }),
    );
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }
}
