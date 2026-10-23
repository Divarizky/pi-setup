// agent-memory: injeksi read-only `memory brief` (vault Obsidian bersama
// untuk Pi, Claude Code, Codex) ke system prompt setiap sesi. Tanpa LLM,
// tanpa server, tanpa capture per turn — menulis tetap lewat skill.
//
// Brief diambil di background saat session_start, lalu disimpan ke cache disk
// per direktori kerja. Prompt pertama memakai cache bila ada; bila belum ada,
// menunggu paling lama BRIEF_WAIT_MS. Brief dikunci untuk satu sesi.
//
// Catatan: import hanya untuk tipe TypeScript (dihapus saat kompilasi), kecuali
// modul fs/promises dan os yang dipakai untuk cache disk.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

type Attempt = [string, string[]];

const BRIEF_ARGS = ["brief", "--max-tokens", "300"];
const BRIEF_WAIT_MS = 1_500;
const CACHE_FILE = join(homedir(), ".pi", "agent", "cache", "agent-memory-brief.json");

let pending: { cwd: string; promise: Promise<string> } | undefined;
let pinned: { cwd: string; text: string } | undefined;
// Kunci percobaan yang terakhir berhasil, dicoba lebih dulu pada pemanggilan berikutnya.
let preferredAttempt: string | undefined;

function skillScript(): string {
  if (process.env.AGENT_MEMORY_SKILL) return process.env.AGENT_MEMORY_SKILL;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const sep = process.platform === "win32" ? "\\" : "/";
  const j = (...parts: string[]): string => parts.join(sep);
  if (process.platform === "win32") {
    return j("G:", "My Drive", "AGENT-MEMORY", "agent-memory-skill", "memory.py");
  }
  if (process.platform === "darwin") {
    return j(
      home, "Library", "CloudStorage",
      "GoogleDrive-divarizky28@gmail.com", "My Drive",
      "AGENT-MEMORY", "agent-memory-skill", "memory.py",
    );
  }
  return j(home, ".agents", "skills", "agent-memory", "memory.py");
}

function attempts(): Attempt[] {
  const script = skillScript();
  // unix: pakai `memory` di PATH dulu (termasuk hasil install.sh).
  // Windows: Node spawn tanpa shell tidak bisa menjalankan .bat, jadi
  // panggil python langsung dengan path absolut ke memory.py.
  // Folder skill per-OS (~/.agents/skills/...) dicoba juga sebagai fallback.
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const sep = process.platform === "win32" ? "\\" : "/";
  const local = home
    + sep + ".agents" + sep + "skills" + sep + "agent-memory" + sep + "memory.py";
  return process.platform === "win32"
    ? [
        ["py", ["-3", script, ...BRIEF_ARGS]],
        ["python", [script, ...BRIEF_ARGS]],
        ["py", ["-3", local, ...BRIEF_ARGS]],
        ["python", [local, ...BRIEF_ARGS]],
      ]
    : [
        ["memory", [...BRIEF_ARGS]],
        ["python3", [script, ...BRIEF_ARGS]],
        ["python3", [local, ...BRIEF_ARGS]],
      ];
}

function attemptKey([cmd, args]: Attempt): string {
  return [cmd, ...args].join("\u0000");
}

function orderedAttempts(): Attempt[] {
  const list = attempts();
  if (!preferredAttempt) return list;
  const preferred = list.filter((attempt) => attemptKey(attempt) === preferredAttempt);
  return [...preferred, ...list.filter((attempt) => attemptKey(attempt) !== preferredAttempt)];
}

async function runBrief(pi: ExtensionAPI, cwd: string): Promise<string> {
  for (const attempt of orderedAttempts()) {
    const [cmd, args] = attempt;
    try {
      const { stdout, code } = await pi.exec(cmd, args, { cwd, timeout: 15000 });
      if (code === 0 && stdout && stdout.trim()) {
        preferredAttempt = attemptKey(attempt);
        return stdout.trim();
      }
    } catch {
      // coba cara berikutnya; gagal total = sesi jalan tanpa brief
    }
  }
  return "";
}

async function readCacheMap(): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(CACHE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function readDiskBrief(cwd: string): Promise<string> {
  const text = (await readCacheMap())[cwd];
  return typeof text === "string" ? text : "";
}

async function writeDiskBrief(cwd: string, text: string): Promise<void> {
  try {
    const map = await readCacheMap();
    map[cwd] = text;
    await mkdir(dirname(CACHE_FILE), { recursive: true });
    // Tulis ke file sementara lalu ganti, supaya pembacaan bersamaan tidak melihat file setengah jadi.
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(map, null, 2), "utf8");
    await rename(tmp, CACHE_FILE);
  } catch {
    // cache disk opsional; kegagalan tulis tidak menghentikan sesi
  }
}

/** Satu proses di latar belakang per direktori kerja. Tidak pernah reject. */
function refreshBrief(pi: ExtensionAPI, cwd: string): Promise<string> {
  if (pending && pending.cwd === cwd) return pending.promise;
  const promise: Promise<string> = (async () => {
    const text = await runBrief(pi, cwd);
    // Hasil gagal tidak disimpan, supaya sesi berikutnya mencoba lagi.
    if (text) await writeDiskBrief(cwd, text);
    return text;
  })().finally(() => {
    if (pending?.promise === promise) pending = undefined;
  });
  pending = { cwd, promise };
  return promise;
}

function waitAtMost(promise: Promise<string>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function briefForTurn(cwd: string): Promise<string> {
  const cached = await readDiskBrief(cwd);
  if (cached) return cached;
  // Belum ada cache: tunggu proses yang sedang berjalan, tapi tidak lebih dari BRIEF_WAIT_MS.
  if (pending && pending.cwd === cwd) return waitAtMost(pending.promise, BRIEF_WAIT_MS);
  return "";
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    pinned = undefined;
    // Tidak di-await: startup Pi tidak menunggu subprocess Python.
    void refreshBrief(pi, ctx.cwd);
  });

  pi.on(
    "before_agent_start",
    async (
      event: BeforeAgentStartEvent,
      ctx: ExtensionContext,
    ): Promise<BeforeAgentStartEventResult | undefined> => {
      // Brief dikunci per sesi agar system prompt tidak berubah di tengah sesi,
      // karena perubahan prompt membuat prompt cache provider tidak terpakai.
      if (!pinned || pinned.cwd !== ctx.cwd) {
        const text = await briefForTurn(ctx.cwd);
        pinned = { cwd: ctx.cwd, text };
      }
      if (!pinned.text) return;
      return {
        systemPrompt:
          event.systemPrompt +
          "\n\n## Agent Memory (vault bersama)\n" +
          pinned.text +
          "\n",
      };
    },
  );
}
