#!/usr/bin/env node
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isValidationCommand } from "../extensions/task-judge/judge.ts";

/**
 * Menambang kandidat pola perintah validasi dari sesi Pi nyata
 * yang belum dikenali oleh task-judge.
 *
 * Opsi CLI:
 *   --sessions-dir direktori sesi Pi (default: ~/.pi/agent/sessions/)
 *   --log          path task-judge.log (default: ~/.pi/agent/task-judge.log)
 *   --output       path JSON output (default: stdout)
 *   --since        ISO timestamp batas awal (opsional)
 */

export const READ_ONLY_PREFIXES = [
  "echo",
  "cat",
  "ls",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "head",
  "tail",
  "find",
  "git log",
  "git diff",
  "git status",
  "git show",
  "printf",
];

export const VALIDATION_KEYWORDS = [
  "test",
  "check",
  "lint",
  "verify",
  "spec",
  "assemble",
  "build",
];

/** Mengumpulkan seluruh file .jsonl di bawah direktori secara rekursif. */
export async function listSessionFiles(dir) {
  const out = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out;
}

/** Mencari berkas sesi untuk sessionId (akhiran _<sessionId>.jsonl). */
export function matchSessionFile(files, sessionId) {
  const suffix = `_${sessionId}.jsonl`;
  return files.filter((f) => path.basename(f).endsWith(suffix));
}

/** Parse teks JSONL menjadi array objek, abaikan baris rusak. */
export function parseSessionText(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // baris rusak diabaikan
    }
  }
  return entries;
}

/** Mengecek apakah teks diawali perintah baca-saja. */
export function isReadOnlyCommand(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  for (const prefix of READ_ONLY_PREFIXES) {
    if (
      trimmed === prefix ||
      trimmed.startsWith(`${prefix} `) ||
      trimmed.startsWith(`${prefix}\t`)
    ) {
      return true;
    }
  }
  return false;
}

/** Mengecek apakah sebuah token merupakan path berkas atau argumen unik. */
export function isPathOrUniqueArg(token) {
  if (!token || typeof token !== "string") return true;
  if (token.includes("/") || token.includes("\\")) return true;
  if (token.includes("*")) return true;
  if (token.includes("=")) return true;
  if (token.startsWith('"') || token.startsWith("'")) return true;
  if (
    /\.(m?[jt]sx?|py|go|rs|rb|php|java|kt|scala|cs|cpp|c|h|sh|bash|json|ya?ml|md|txt|html|css|wasm)$/i.test(
      token,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Menghapus blok heredoc (<<EOF ... EOF) dari teks perintah shell
 * agar konten di dalam heredoc tidak disalahartikan sebagai perintah.
 */
export function stripHeredocs(cmd) {
  const lines = cmd.split("\n");
  const result = [];
  let delimiter = null;

  for (const line of lines) {
    if (delimiter) {
      if (line.trim() === delimiter) {
        delimiter = null;
      }
      continue;
    }

    const match = /<<-?\s*['"]?([A-Za-z0-9_-]+)['"]?/.exec(line);
    if (match) {
      delimiter = match[1];
      const before = line.slice(0, match.index).trim();
      if (before) result.push(before);
      continue;
    }

    result.push(line);
  }
  return result.join("\n");
}

/** Memecah perintah shell majemuk menjadi segmen-segmen individual. */
export function splitSegments(cmd) {
  if (typeof cmd !== "string" || !cmd.trim()) return [];

  // Gabungkan baris yang disambung backslash
  const joined = cmd.replace(/\\\r?\n/g, " ");
  const stripped = stripHeredocs(joined);
  const segments = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < stripped.length; i++) {
    const char = stripped[i];
    if (quote) {
      if (char === "\\" && quote === '"' && i + 1 < stripped.length) {
        current += char + stripped[i + 1];
        i++;
        continue;
      }
      if (char === quote) quote = null;
      current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (char === "#") {
      const nextNl = stripped.indexOf("\n", i);
      if (nextNl === -1) break;
      if (current.trim()) segments.push(current.trim());
      current = "";
      i = nextNl;
      continue;
    }

    if (
      (char === "&" && stripped[i + 1] === "&") ||
      (char === "|" && stripped[i + 1] === "|")
    ) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i++;
      continue;
    }

    if (char === "|" || char === ";" || char === "\n" || char === "\r") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/** Membersihkan penugasan environment variable, timeout, dan traversal ./ */
export function cleanCommand(seg) {
  let cleaned = seg.trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+/.test(cleaned)) {
    cleaned = cleaned
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+/, "")
      .trim();
  }
  cleaned = cleaned.replace(/^timeout\s+(?:-\S+\s+)*\d+[smhd]?\s+/, "").trim();
  if (cleaned.startsWith("./") || cleaned.startsWith(".\\")) {
    cleaned = cleaned.slice(2).trim();
  }
  return cleaned;
}

/**
 * Mengekstrak token runner (dua token pertama tanpa path/argumen unik).
 */
export function extractRunner(seg) {
  const cleaned = cleanCommand(seg);
  if (!cleaned) return null;
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let t1 = path.basename(tokens[0]);
  if (!t1) return null;

  // Nama runner harus diawali identifier karakter valid (bukan simbol markdown/tanda kurung)
  if (!/^[a-zA-Z0-9_.]/.test(t1)) return null;

  const t2 = tokens[1];
  if (t2 && !isPathOrUniqueArg(t2) && /^[a-zA-Z0-9_.-]/.test(t2)) {
    return `${t1} ${t2}`;
  }
  return t1;
}

/** Mengecek apakah nama runner mengandung kata kunci validasi. */
export function hasValidationSmell(runner) {
  if (typeof runner !== "string") return false;
  const lower = runner.toLowerCase();

  // Bukan validasi bila kata non-validasi seperti git checkout
  if (lower.includes("checkout")) return false;

  // Abaikan builtin test shell kondisional (mis. "test", "test -z", "test -n")
  if (/^test(\s+-[a-zA-Z]|$)/.test(lower)) return false;

  const words = lower.split(/\s+/);
  return words.some((w) => {
    const cleanWord = w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    return VALIDATION_KEYWORDS.some((k) => cleanWord.includes(k));
  });
}

/**
 * Menambang kandidat pola validasi dari berkas log task-judge dan sesi Pi.
 */
export async function mineValidationCandidates(options = {}) {
  const sessionsDir =
    options.sessionsDir ?? path.join(os.homedir(), ".pi", "agent", "sessions");
  const logPath =
    options.logPath ??
    path.join(os.homedir(), ".pi", "agent", "task-judge.log");
  const since = options.since ?? null;

  let logText = "";
  try {
    logText = await readFile(logPath, "utf8");
  } catch {
    return [];
  }

  const logEntries = parseSessionText(logText);
  const unverified = logEntries.filter(
    (e) =>
      e &&
      e.decision === "tidak_terverifikasi" &&
      e.sessionId &&
      (!since || (typeof e.timestamp === "string" && e.timestamp >= since)),
  );

  if (unverified.length === 0) {
    return [];
  }

  // Petakan timestamp peringatan per session ID
  const sessionWarningTimes = new Map();
  for (const entry of unverified) {
    const list = sessionWarningTimes.get(entry.sessionId) ?? [];
    if (entry.timestamp) list.push(entry.timestamp);
    sessionWarningTimes.set(entry.sessionId, list);
  }

  const sessionFiles = await listSessionFiles(sessionsDir);
  if (sessionFiles.length === 0) {
    return [];
  }

  const candidateMap = new Map();

  for (const [sessionId, warnings] of sessionWarningTimes.entries()) {
    const matchedFiles = matchSessionFile(sessionFiles, sessionId);
    if (matchedFiles.length === 0) continue;

    const minTs = warnings.length > 0 ? warnings.sort()[0] : null;

    let sessionContent = "";
    try {
      sessionContent = await readFile(matchedFiles[0], "utf8");
    } catch {
      continue;
    }

    const entries = parseSessionText(sessionContent);
    const toolResults = new Map();

    for (const r of entries) {
      if (r.type === "message" && r.message?.role === "toolResult") {
        toolResults.set(r.message.toolCallId, r.message);
      }
    }

    for (const r of entries) {
      if (r.type !== "message" || r.message?.role !== "assistant") continue;

      // Ambil perintah setelah titik peringatan tidak_terverifikasi dicatat
      if (minTs && typeof r.timestamp === "string" && r.timestamp < minTs) {
        continue;
      }

      for (const call of r.message.content ?? []) {
        if (!call || call.type !== "toolCall" || call.name !== "bash") {
          continue;
        }

        const res = toolResults.get(call.id);
        const isSuccess = res && res.isError !== true;
        if (!isSuccess) continue;

        const rawCmd = call.arguments?.command;
        if (typeof rawCmd !== "string" || !rawCmd.trim()) continue;

        // Keluarkan hanya perintah yang isValidationCommand saat ini mengembalikan false
        if (isValidationCommand(rawCmd)) continue;

        // Buang bila keseluruhan perintah berawalan baca-saja
        if (isReadOnlyCommand(rawCmd)) continue;

        const segs = splitSegments(rawCmd);
        for (const seg of segs) {
          const cleaned = cleanCommand(seg);
          if (!cleaned || isReadOnlyCommand(cleaned)) continue;
          if (cleaned.startsWith("cd ") || cleaned === "cd") continue;

          const runner = extractRunner(cleaned);
          if (!runner || isReadOnlyCommand(runner)) continue;

          if (hasValidationSmell(runner)) {
            const current = candidateMap.get(runner) ?? {
              count: 0,
              sessions: new Set(),
              examples: [],
            };
            current.count++;
            current.sessions.add(sessionId);
            if (
              current.examples.length < 3 &&
              !current.examples.includes(rawCmd)
            ) {
              current.examples.push(rawCmd);
            }
            candidateMap.set(runner, current);
          }
        }
      }
    }
  }

  const results = [...candidateMap.entries()]
    .map(([runner, data]) => ({
      runner,
      count: data.count,
      sessions: data.sessions.size,
      examples: data.examples,
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (b.sessions !== a.sessions) return b.sessions - a.sessions;
      return a.runner.localeCompare(b.runner);
    });

  return results;
}

function getArg(args, flag, fallback = null) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const sessionsDir = getArg(
    args,
    "--sessions-dir",
    path.join(os.homedir(), ".pi", "agent", "sessions"),
  );
  const logPath = getArg(
    args,
    "--log",
    path.join(os.homedir(), ".pi", "agent", "task-judge.log"),
  );
  const outputPath = getArg(args, "--output", null);
  const since = getArg(args, "--since", null);

  const candidates = await mineValidationCandidates({
    sessionsDir,
    logPath,
    since,
  });

  const jsonStr = `${JSON.stringify(candidates, null, 2)}\n`;

  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, jsonStr, "utf8");
  } else {
    process.stdout.write(jsonStr);
  }
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
