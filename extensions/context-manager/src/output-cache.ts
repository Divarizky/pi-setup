import { chmod, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 60_000;

export const OUTPUT_ID_RE = /^output-[a-f0-9]{8}$/;

interface CacheEntry {
  id: string;
  createdAt: number;
  raw: string;
  projectHash?: string;
  sessionId?: string;
  referenceManaged?: boolean;
}

interface ReferenceIndex {
  version: 1;
  projectHash: string;
  sessions: Record<string, { outputIds: string[]; updatedAt: number; sessionFile?: string }>;
}

export function projectHashForDir(dir: string): string {
  return createHash("sha256").update(dir).digest("hex").slice(0, 12);
}

export class OutputCache {
  private directory = join(tmpdir(), "pi-context-manager");
  private readonly activeIds = new Set<string>();
  private projectHash: string | null = null;
  private sessionId: string | null = null;

  setProjectDir(dir: string, storageDirectory?: string): void {
    this.projectHash = projectHashForDir(resolve(dir));
    const root = storageDirectory ? resolve(storageDirectory) : join(tmpdir(), "pi-context-manager");
    this.directory = join(root, this.projectHash);
  }

  setSessionId(sessionId: string | undefined): void { this.sessionId = sessionId ?? null; }
  getProjectHash(): string | null { return this.projectHash; }

  resetSession(): void {
    this.activeIds.clear();
  }

  addActiveId(id: string): void { if (OUTPUT_ID_RE.test(id)) this.activeIds.add(id); }

  async syncSessionReferences(sessionId: string | undefined, outputIds: string[], sessionFile?: string): Promise<void> {
    if (!sessionId || !this.projectHash) return;
    const ids = [...new Set(outputIds.filter((id) => OUTPUT_ID_RE.test(id)))];
    await this.withReferenceIndexLock(async () => {
      const index = await this.readReferenceIndex(true);
      if (!index) throw new Error("Reference index tidak tersedia.");
      index.sessions[sessionId] = {
        outputIds: ids,
        updatedAt: Date.now(),
        sessionFile: sessionFile ? resolve(sessionFile) : index.sessions[sessionId]?.sessionFile,
      };
      await this.writeReferenceIndex(index);
    });
    this.activeIds.clear();
    this.rebuildFromIds(ids);
  }

  async save(raw: string, opts?: { sessionId?: string }): Promise<string> {
    await this.ensureDirectory();
    const id = `output-${randomUUID().slice(0, 8)}`;
    const sessionId = opts?.sessionId ?? this.sessionId ?? undefined;
    const entry: CacheEntry = {
      id,
      createdAt: Date.now(),
      raw,
      projectHash: this.projectHash ?? undefined,
      sessionId,
      referenceManaged: Boolean(sessionId && this.projectHash),
    };
    const filePath = join(this.directory, `${id}.json`);
    const writeEntry = async () => {
      await writeFile(filePath, JSON.stringify(entry), { encoding: "utf8", mode: 0o600 });
      await chmod(filePath, 0o600).catch(() => undefined);
    };

    try {
      if (sessionId && this.projectHash) {
        // File write + index update harus atomik terhadap cleanup instance lain.
        await this.withReferenceIndexLock(async () => {
          await writeEntry();
          const index = await this.readReferenceIndex(true);
          if (!index) throw new Error("Reference index tidak tersedia.");
          const refs = index.sessions[sessionId]?.outputIds ?? [];
          index.sessions[sessionId] = {
            outputIds: [...new Set([...refs, id])],
            updatedAt: Date.now(),
            sessionFile: index.sessions[sessionId]?.sessionFile,
          };
          await this.writeReferenceIndex(index);
        });
      } else {
        await writeEntry();
      }
    } catch (error) {
      await unlink(filePath).catch(() => undefined);
      throw error;
    }

    this.activeIds.add(id);
    return id;
  }

  listActive(): string[] {
    return [...this.activeIds];
  }

  async get(id: string): Promise<string | null> {
    if (!OUTPUT_ID_RE.test(id)) return null;
    try {
      const filePath = join(this.directory, `${id}.json`);
      const metadata = await stat(filePath);
      const entry = JSON.parse(await readFile(filePath, "utf8")) as CacheEntry;
      if (typeof entry.raw !== "string") return null;
      // Isolasi project/session. Entry baru selalu memiliki keduanya; entry legacy
      // tanpa metadata hanya didukung untuk cache API tanpa scope (mis. unit test).
      if (entry.projectHash && entry.projectHash !== this.projectHash) return null;
      if (entry.sessionId && entry.sessionId !== this.sessionId) return null;
      if (this.sessionId && !entry.sessionId) return null;
      // Entry bersession adalah reference-kept durable; GC dilakukan oleh cleanup
      // berdasarkan reference index, bukan TTL lokal instance.
      const sessionOwned = typeof entry.sessionId === "string" && entry.sessionId.length > 0;
      if (!sessionOwned && !this.activeIds.has(id) && Date.now() - metadata.mtimeMs > CACHE_TTL_MS) {
        await unlink(filePath).catch(() => undefined);
        return null;
      }
      return entry.raw;
    } catch {
      return null;
    }
  }

  async remove(id: string): Promise<void> {
    if (!OUTPUT_ID_RE.test(id)) return;
    this.activeIds.delete(id);
    await unlink(join(this.directory, `${id}.json`)).catch(() => undefined);
  }

  async cleanup(): Promise<void> {
    await this.ensureDirectory();
    const files = await readdir(this.directory).catch(() => []);
    await this.withReferenceIndexLock(async () => {
      const index = await this.readReferenceIndex(false);
      let indexChanged = false;
      // Session yang file-nya sudah hilang tidak lagi menjadi akar referensi.
      // Entry index lama tanpa sessionFile dipertahankan secara konservatif.
      if (index) {
        for (const [sessionId, session] of Object.entries(index.sessions)) {
          if (session.sessionFile && !await this.fileExists(session.sessionFile)) {
            delete index.sessions[sessionId];
            indexChanged = true;
          }
        }
      }
      const referencedIds = index
        ? new Set(Object.values(index.sessions).flatMap((session) => session.outputIds))
        : null;

      await Promise.all(files.filter((file) => file.endsWith(".json") && file !== "references.json").map(async (file) => {
        const filePath = join(this.directory, file);
        try {
          const metadata = await stat(filePath);
          const id = file.slice(0, -5);
          const entry = JSON.parse(await readFile(filePath, "utf8")) as CacheEntry;
          const sessionOwned = typeof entry.sessionId === "string" && entry.sessionId.length > 0;
          const referenceManaged = entry.referenceManaged === true;
          // Fail-safe: index tidak tersedia/rusak atau entry legacy tanpa marker
          // selalu dipertahankan. Hanya entry baru yang terdaftar boleh di-GC.
          const keepForReference = sessionOwned && (!referenceManaged || referencedIds === null || referencedIds.has(id));
          if (!keepForReference && !sessionOwned && !this.activeIds.has(id) && Date.now() - metadata.mtimeMs > CACHE_TTL_MS) {
            await unlink(filePath).catch(() => undefined);
          } else if (sessionOwned && referenceManaged && referencedIds !== null && !referencedIds.has(id)) {
            await unlink(filePath).catch(() => undefined);
            this.activeIds.delete(id);
          }
          if (index && !await this.fileExists(filePath)) {
            for (const session of Object.values(index.sessions)) {
              const next = session.outputIds.filter((outputId) => outputId !== id);
              if (next.length !== session.outputIds.length) {
                session.outputIds = next;
                indexChanged = true;
              }
            }
          }
        } catch {
          // Ignore files removed concurrently or inaccessible/corrupt entries.
        }
      }));
      if (index && indexChanged) await this.writeReferenceIndex(index);
    });
  }

  /** Rekonstruksi activeIds dari branch agar resume tidak kehilangan referensi. */
  rebuildFromIds(ids: string[]): void {
    for (const id of ids) if (OUTPUT_ID_RE.test(id)) this.activeIds.add(id);
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try { await stat(filePath); return true; } catch { return false; }
  }

  private async readReferenceIndex(required: boolean): Promise<ReferenceIndex | null> {
    if (!this.projectHash) {
      if (required) throw new Error("Cache project scope belum dikonfigurasi.");
      return null;
    }
    const path = join(this.directory, "references.json");
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ReferenceIndex> | null;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid reference index");
      const sessions = parsed.sessions;
      const validSessions = sessions && typeof sessions === "object" && !Array.isArray(sessions)
        && Object.values(sessions).every((session) => {
          if (!session || typeof session !== "object" || Array.isArray(session)) return false;
          const value = session as { outputIds?: unknown; updatedAt?: unknown };
          return Array.isArray(value.outputIds)
            && value.outputIds.every((id) => typeof id === "string" && OUTPUT_ID_RE.test(id))
            && typeof value.updatedAt === "number";
        });
      if (parsed.version !== 1 || parsed.projectHash !== this.projectHash || !validSessions) throw new Error("Invalid reference index");
      return parsed as ReferenceIndex;
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      if (!required && error instanceof SyntaxError) return null;
      if (!required && error instanceof Error && error.message === "Invalid reference index") return null;
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { version: 1, projectHash: this.projectHash, sessions: {} };
      }
      throw error;
    }
  }

  private async writeReferenceIndex(index: ReferenceIndex): Promise<void> {
    await this.ensureDirectory();
    const path = join(this.directory, "references.json");
    const tempPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(index), { encoding: "utf8", mode: 0o600 });
    await chmod(tempPath, 0o600).catch(() => undefined);
    await rename(tempPath, path).catch(async (error) => {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    });
    await chmod(path, 0o600).catch(() => undefined);
  }

  private async withReferenceIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    const lockPath = join(this.directory, "references.json.lock");
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        await mkdir(lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST" || Date.now() >= deadline) throw error;
        try {
          const lockStat = await stat(lockPath);
          if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) await rm(lockPath, { recursive: true, force: true });
        } catch { /* lock owner may be replacing/removing it */ }
        await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_WAIT_MS));
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700).catch(() => undefined);
  }
}
