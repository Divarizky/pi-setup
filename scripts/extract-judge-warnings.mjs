#!/usr/bin/env node
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DEFAULT_SINCE, parseLog } from "./task-judge-fp.mjs";

/**
 * Mengekstrak konteks peringatan task-judge (decision = tidak_terverifikasi)
 * dari riwayat sesi Pi untuk mempercepat pelabelan manual false positive.
 *
 * Output: draf JSON array dengan field `real: null` untuk diisi manual.
 *
 * Opsi:
 *   --log          path task-judge.log (default: ~/.pi/agent/task-judge.log)
 *   --sessions-dir direktori sesi Pi (default: ~/.pi/agent/sessions)
 *   --output       path JSON output (default: scripts/data/task-judge-labels-draft.json)
 *   --since        ISO timestamp batas awal (default: DEFAULT_SINCE)
 */

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = path.join(
  SCRIPT_DIR,
  "data",
  "task-judge-labels-draft.json",
);
const PREVIEW_CHARS = 300;
const EDIT_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "execute"]);

/** Mengumpulkan semua file .jsonl di bawah direktori, rekursif. */
export async function listSessionFiles(dir) {
  const out = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

/**
 * Mencari berkas sesi untuk sessionId. Nama berkas sesi Pi berbentuk
 * `<timestamp>_<sessionId>.jsonl`, jadi pencocokan dilakukan pada basename.
 */
export function matchSessionFile(files, sessionId) {
  const suffix = `_${sessionId}.jsonl`;
  return files.filter((f) => path.basename(f).endsWith(suffix));
}

/** Parse isi JSONL sesi menjadi daftar entri, melewati baris tidak valid. */
export function parseSessionText(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // baris rusak dilewati
    }
  }
  return entries;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

function truncate(text, max = PREVIEW_CHARS) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Mengekstrak konteks ringkas dari entri sesi: file yang diedit, perintah shell,
 * dan preview prompt user pertama. Hanya entri dengan timestamp di dalam
 * jendela (windowStart, windowEnd] yang dipakai, agar konteks sesuai satu run.
 */
export function extractContext(sessionEntries, windowStart, windowEnd) {
  const editedPaths = new Set();
  const commands = new Set();
  let promptPreview = "";

  for (const entry of sessionEntries) {
    if (entry.type !== "message" || !entry.message) continue;
    const ts = entry.timestamp;
    if (typeof ts !== "string") continue;
    if (windowStart && ts <= windowStart) continue;
    if (windowEnd && ts > windowEnd) continue;

    const { role, content } = entry.message;
    if (role === "user" && !promptPreview) {
      const text = textOf(content);
      if (text) promptPreview = truncate(text);
    }
    if (role !== "assistant" || !Array.isArray(content)) continue;

    for (const part of content) {
      if (!part || part.type !== "toolCall") continue;
      const args = part.arguments || {};
      if (EDIT_TOOLS.has(part.name) && typeof args.path === "string") {
        editedPaths.add(args.path);
      }
      if (SHELL_TOOLS.has(part.name)) {
        const cmd =
          typeof args.command === "string" ? args.command : args.script;
        if (typeof cmd === "string" && cmd.trim())
          commands.add(truncate(cmd, 200));
      }
    }
  }

  return {
    editedPaths: [...editedPaths],
    commands: [...commands],
    promptPreview,
  };
}

/**
 * Menyusun draf label dari entri peringatan. Setiap entri dicocokkan dengan
 * berkas sesi dan konteksnya dibatasi pada jendela antara peringatan sebelumnya
 * di sesi yang sama dan peringatan ini.
 *
 * `readSession(file)` mengembalikan daftar entri sesi.
 */
export async function buildDrafts(warnings, sessionFiles, readSession) {
  const sorted = [...warnings].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );
  const previousBySession = new Map();
  const drafts = [];
  const unmatched = [];

  for (const warning of sorted) {
    const windowStart = previousBySession.get(warning.sessionId) ?? null;
    previousBySession.set(warning.sessionId, warning.timestamp);

    const files = matchSessionFile(sessionFiles, warning.sessionId);
    if (files.length === 0) {
      unmatched.push(warning);
      drafts.push({
        timestamp: warning.timestamp,
        sessionId: warning.sessionId,
        real: null,
        context: {
          sessionMatched: false,
          editedPaths: [],
          commands: [],
          promptPreview: "",
        },
      });
      continue;
    }

    const entries = parseSessionText(await readSession(files[0]));
    const context = extractContext(entries, windowStart, warning.timestamp);
    drafts.push({
      timestamp: warning.timestamp,
      sessionId: warning.sessionId,
      real: null,
      context: { sessionMatched: true, ...context },
    });
  }

  return { drafts, unmatched };
}

function getArg(args, flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const logPath = getArg(
    args,
    "--log",
    path.join(os.homedir(), ".pi", "agent", "task-judge.log"),
  );
  const sessionsDir = getArg(
    args,
    "--sessions-dir",
    path.join(os.homedir(), ".pi", "agent", "sessions"),
  );
  const outputPath = getArg(args, "--output", DEFAULT_OUTPUT);
  const since = getArg(args, "--since", DEFAULT_SINCE);

  const { entries } = parseLog(await readFile(logPath, "utf8"));
  const warnings = entries
    .filter(
      (e) =>
        e.decision === "tidak_terverifikasi" &&
        typeof e.timestamp === "string" &&
        e.timestamp >= since,
    )
    .map((e) => ({ timestamp: e.timestamp, sessionId: e.sessionId }));

  const sessionFiles = await listSessionFiles(sessionsDir);
  const { drafts, unmatched } = await buildDrafts(
    warnings,
    sessionFiles,
    (file) => readFile(file, "utf8"),
  );

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(drafts, null, 2)}\n`, "utf8");

  console.log(`Log: ${logPath}`);
  console.log(`Sejak: ${since}`);
  console.log(`Peringatan diekstrak: ${warnings.length}`);
  console.log(
    `Cocok dengan berkas sesi: ${warnings.length - unmatched.length}`,
  );
  console.log(`Tanpa berkas sesi: ${unmatched.length}`);
  console.log(`Output: ${outputPath}`);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
