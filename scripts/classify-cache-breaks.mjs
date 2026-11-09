#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Batas TTL cache standar (5 menit dalam milidetik).
 */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Nilai minimum cacheRead turn sebelumnya agar dihitung sebagai cache break.
 */
export const MIN_PREV_CACHE_READ = 5000;

/**
 * Rasio ambang batas penurunan cacheRead (< 0.5 * cacheRead sebelumnya).
 */
export const CACHE_BREAK_RATIO = 0.5;

/**
 * Mengambil timestamp epoch ms dari sebuah entri sesi.
 * Memeriksa top-level timestamp terlebih dahulu, lalu message.timestamp.
 *
 * @param {any} entry
 * @returns {number | null}
 */
export function getEntryTimestamp(entry) {
  if (!entry || typeof entry !== "object") return null;

  if (entry.timestamp !== undefined && entry.timestamp !== null) {
    if (typeof entry.timestamp === "number") return entry.timestamp;
    const parsed = Date.parse(entry.timestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }

  if (
    entry.message?.timestamp !== undefined &&
    entry.message?.timestamp !== null
  ) {
    if (typeof entry.message.timestamp === "number")
      return entry.message.timestamp;
    const parsed = Date.parse(entry.message.timestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }

  return null;
}

/**
 * Memeriksa apakah entri merupakan turn asisten yang memiliki usage.
 *
 * @param {any} entry
 * @returns {boolean}
 */
export function isAssistantTurnWithUsage(entry) {
  return Boolean(
    entry &&
    entry.type === "message" &&
    entry.message?.role === "assistant" &&
    entry.message?.usage &&
    typeof entry.message.usage === "object",
  );
}

/**
 * Memeriksa apakah terjadi cache break antara dua turn asisten berturut-turut.
 * Definisi: cacheRead turn sebelumnya > 5000 dan cacheRead saat ini < 0.5 * cacheRead sebelumnya.
 *
 * @param {any} prevTurn
 * @param {any} currTurn
 * @returns {boolean}
 */
export function isCacheBreak(prevTurn, currTurn) {
  if (
    !isAssistantTurnWithUsage(prevTurn) ||
    !isAssistantTurnWithUsage(currTurn)
  ) {
    return false;
  }

  const prevCacheRead = Number(prevTurn.message.usage.cacheRead) || 0;
  const currCacheRead = Number(currTurn.message.usage.cacheRead) || 0;

  return (
    prevCacheRead > MIN_PREV_CACHE_READ &&
    currCacheRead < CACHE_BREAK_RATIO * prevCacheRead
  );
}

/**
 * Mengklasifikasikan penyebab cache break sesuai urutan prioritas:
 * 1. model-switch: message.model berbeda dari turn sebelumnya.
 * 2. compaction: ada entri bertipe compaction di antara dua turn.
 * 3. prune: ada entri customType context-manager-prune di antara dua turn.
 * 4. idle-gap: selisih timestamp antar turn lebih dari 5 menit (TTL cache).
 * 5. unknown: sisanya.
 *
 * @param {{
 *   prevTurn: any,
 *   currTurn: any,
 *   intermediateEntries?: any[]
 * }} params
 * @returns {"model-switch" | "compaction" | "prune" | "idle-gap" | "unknown"}
 */
export function classifyCacheBreak({
  prevTurn,
  currTurn,
  intermediateEntries = [],
}) {
  const prevModel = prevTurn?.message?.model ?? "";
  const currModel = currTurn?.message?.model ?? "";

  // 1. model-switch
  if (prevModel !== currModel) {
    return "model-switch";
  }

  // 2. compaction
  const hasCompaction = intermediateEntries.some(
    (e) => e && (e.type === "compaction" || e.customType === "compaction"),
  );
  if (hasCompaction) {
    return "compaction";
  }

  // 3. prune
  const hasPrune = intermediateEntries.some(
    (e) =>
      e &&
      (e.customType === "context-manager-prune" ||
        e.type === "context-manager-prune"),
  );
  if (hasPrune) {
    return "prune";
  }

  // 4. idle-gap
  const tPrev = getEntryTimestamp(prevTurn);
  const tCurr = getEntryTimestamp(currTurn);
  if (tPrev !== null && tCurr !== null) {
    const diffMs = tCurr - tPrev;
    if (diffMs > CACHE_TTL_MS) {
      return "idle-gap";
    }
  }

  // 5. unknown
  return "unknown";
}

/**
 * Mem-parse string JSONL menjadi array baris parsed beserta metadata indeks.
 *
 * @param {string} rawContent
 * @returns {Array<{ entry: any, entryIndex: number, line: number }>}
 */
export function parseJsonlLines(rawContent) {
  const lines = rawContent.split("\n");
  const results = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      results.push({
        entry,
        entryIndex: results.length,
        line: i + 1,
      });
    } catch {
      // Abaikan baris rusak
    }
  }

  return results;
}

/**
 * Menganalisis satu sesi untuk mendeteksi dan mengklasifikasikan seluruh cache break.
 *
 * @param {string | Array<{ entry: any, entryIndex?: number, line?: number } | any>} input
 * @param {string} [sessionPath="unknown"]
 * @returns {Array<{
 *   sessionPath: string,
 *   turnIndex: number,
 *   line: number,
 *   label: string,
 *   model: string,
 *   prevModel: string,
 *   prevCacheRead: number,
 *   currCacheRead: number,
 *   input: number,
 *   cacheWrite: number,
 *   retransmittedTokens: number,
 *   timestamp: string | number | null
 * }>}
 */
export function analyzeSession(input, sessionPath = "unknown") {
  const items =
    typeof input === "string"
      ? parseJsonlLines(input)
      : input.map((item, idx) => {
          if (item && typeof item === "object" && "entry" in item) {
            return {
              entry: item.entry,
              entryIndex: item.entryIndex ?? idx,
              line: item.line ?? idx + 1,
            };
          }
          return {
            entry: item,
            entryIndex: idx,
            line: idx + 1,
          };
        });

  const breaks = [];
  let prevAssistantTurn = null;
  let intermediateEntries = [];

  for (const item of items) {
    const { entry, entryIndex, line } = item;

    if (isAssistantTurnWithUsage(entry)) {
      const currAssistantTurn = entry;

      if (
        prevAssistantTurn &&
        isCacheBreak(prevAssistantTurn, currAssistantTurn)
      ) {
        const label = classifyCacheBreak({
          prevTurn: prevAssistantTurn,
          currTurn: currAssistantTurn,
          intermediateEntries,
        });

        const inputTokens = Number(currAssistantTurn.message.usage.input) || 0;
        const cacheWriteTokens =
          Number(currAssistantTurn.message.usage.cacheWrite) || 0;
        const retransmittedTokens = inputTokens + cacheWriteTokens;

        breaks.push({
          sessionPath,
          turnIndex: entryIndex,
          line,
          label,
          model: currAssistantTurn.message.model || "unknown",
          prevModel: prevAssistantTurn.message.model || "unknown",
          prevCacheRead: Number(prevAssistantTurn.message.usage.cacheRead) || 0,
          currCacheRead: Number(currAssistantTurn.message.usage.cacheRead) || 0,
          input: inputTokens,
          cacheWrite: cacheWriteTokens,
          retransmittedTokens,
          timestamp:
            currAssistantTurn.timestamp ||
            currAssistantTurn.message.timestamp ||
            null,
        });
      }

      prevAssistantTurn = currAssistantTurn;
      intermediateEntries = [];
    } else {
      if (prevAssistantTurn) {
        intermediateEntries.push(entry);
      }
    }
  }

  return breaks;
}

/**
 * Mengagregasikan seluruh hasil deteksi cache break menjadi ringkasan statistik.
 *
 * @param {Array<any>} allBreaks
 * @param {number} [sessionsAnalyzed=0]
 * @returns {{
 *   sessionsAnalyzed: number,
 *   totalBreaks: number,
 *   totalRetransmittedTokens: number,
 *   byLabel: Record<string, { count: number, retransmittedTokens: number }>,
 *   byModel: Record<string, { count: number, retransmittedTokens: number, byLabel: Record<string, number> }>,
 *   unknownExamples: Array<any>,
 *   breaks: Array<any>
 * }}
 */
export function summarizeBreaks(allBreaks, sessionsAnalyzed = 0) {
  const canonicalLabels = [
    "model-switch",
    "compaction",
    "prune",
    "idle-gap",
    "unknown",
  ];
  const byLabel = {};
  for (const lbl of canonicalLabels) {
    byLabel[lbl] = { count: 0, retransmittedTokens: 0 };
  }

  const byModel = {};
  let totalRetransmittedTokens = 0;
  const unknownExamples = [];

  for (const b of allBreaks) {
    totalRetransmittedTokens += b.retransmittedTokens;

    if (!byLabel[b.label]) {
      byLabel[b.label] = { count: 0, retransmittedTokens: 0 };
    }
    byLabel[b.label].count += 1;
    byLabel[b.label].retransmittedTokens += b.retransmittedTokens;

    if (!byModel[b.model]) {
      byModel[b.model] = {
        count: 0,
        retransmittedTokens: 0,
        byLabel: {},
      };
    }
    byModel[b.model].count += 1;
    byModel[b.model].retransmittedTokens += b.retransmittedTokens;
    byModel[b.model].byLabel[b.label] =
      (byModel[b.model].byLabel[b.label] || 0) + 1;

    if (b.label === "unknown" && unknownExamples.length < 5) {
      unknownExamples.push({
        sessionPath: b.sessionPath,
        turnIndex: b.turnIndex,
        line: b.line,
        prevModel: b.prevModel,
        model: b.model,
        prevCacheRead: b.prevCacheRead,
        currCacheRead: b.currCacheRead,
        retransmittedTokens: b.retransmittedTokens,
      });
    }
  }

  return {
    sessionsAnalyzed,
    totalBreaks: allBreaks.length,
    totalRetransmittedTokens,
    byLabel,
    byModel,
    unknownExamples,
    breaks: allBreaks,
  };
}

/**
 * Memformat ringkasan statistik ke dalam format teks tabel yang rapi.
 *
 * @param {ReturnType<typeof summarizeBreaks>} summary
 * @returns {string}
 */
export function formatSummaryTable(summary) {
  const lines = [];
  lines.push(
    "--------------------------------------------------------------------------------",
  );
  lines.push(
    "                    RINGKASAN KLASIFIKASI CACHE BREAK                           ",
  );
  lines.push(
    "--------------------------------------------------------------------------------",
  );
  lines.push(`Sesi dianalisis : ${summary.sessionsAnalyzed}`);
  lines.push(`Total break     : ${summary.totalBreaks}`);
  lines.push(
    `Total token baru: ${summary.totalRetransmittedTokens.toLocaleString()} (input + cacheWrite)`,
  );
  lines.push("");

  // Tabel per Label
  lines.push("--- Berdasarkan Penyebab (Label) ---");
  lines.push(
    `${"Penyebab (Label)".padEnd(16)} | ${"Jumlah".padStart(8)} | ${"Porsi".padStart(7)} | ${"Token Dikirim Ulang".padStart(20)}`,
  );
  lines.push("-".repeat(60));

  const labels = Object.keys(summary.byLabel);
  for (const label of labels) {
    const item = summary.byLabel[label];
    const pct =
      summary.totalBreaks > 0
        ? ((item.count / summary.totalBreaks) * 100).toFixed(1)
        : "0.0";
    lines.push(
      `${label.padEnd(16)} | ${String(item.count).padStart(8)} | ${(pct + "%").padStart(7)} | ${item.retransmittedTokens.toLocaleString().padStart(20)}`,
    );
  }
  lines.push("-".repeat(60));
  lines.push(
    `${"Total".padEnd(16)} | ${String(summary.totalBreaks).padStart(8)} | ${"100.0%".padStart(7)} | ${summary.totalRetransmittedTokens.toLocaleString().padStart(20)}`,
  );
  lines.push("");

  // Tabel per Model
  lines.push("--- Berdasarkan Model ---");
  lines.push(
    `${"Model".padEnd(32)} | ${"Breaks".padStart(8)} | ${"Token Dikirim Ulang".padStart(20)} | Rincian Penyebab`,
  );
  lines.push("-".repeat(95));

  const models = Object.keys(summary.byModel).sort(
    (a, b) => summary.byModel[b].count - summary.byModel[a].count,
  );

  if (models.length === 0) {
    lines.push("Tidak ada cache break terdeteksi pada model mana pun.");
  } else {
    for (const m of models) {
      const item = summary.byModel[m];
      const details = Object.entries(item.byLabel)
        .map(([lbl, cnt]) => `${lbl}: ${cnt}`)
        .join(", ");
      lines.push(
        `${m.padEnd(32)} | ${String(item.count).padStart(8)} | ${item.retransmittedTokens.toLocaleString().padStart(20)} | ${details}`,
      );
    }
  }
  lines.push("");

  // Contoh Unknown
  lines.push("--- Contoh Kasus 'unknown' (Maksimal 5) ---");
  if (summary.unknownExamples.length === 0) {
    lines.push("Tidak ada kasus 'unknown' yang ditemukan.");
  } else {
    summary.unknownExamples.forEach((ex, idx) => {
      lines.push(`${idx + 1}. Sesi        : ${ex.sessionPath}`);
      lines.push(
        `   Indeks Turn : ${ex.turnIndex} (baris ${ex.line}, model: ${ex.model}, prevModel: ${ex.prevModel})`,
      );
      lines.push(
        `   CacheRead   : ${ex.prevCacheRead.toLocaleString()} -> ${ex.currCacheRead.toLocaleString()}`,
      );
      lines.push(
        `   Kirim Ulang : ${ex.retransmittedTokens.toLocaleString()} token`,
      );
    });
  }
  lines.push(
    "--------------------------------------------------------------------------------",
  );

  return lines.join("\n");
}

/**
 * Mencari seluruh file .jsonl di dalam direktori secara rekursif.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function findJsonlFiles(dir) {
  const results = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await findJsonlFiles(fullPath);
        results.push(...nested);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(fullPath);
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      // Abaikan izin akses atau direktori yang hilang
    }
  }
  return results;
}

/**
 * Mendapatkan file sesi terurut berdasarkan waktu perubahan terbaru (mtime) terbanyak N.
 *
 * @param {string} sessionsDir
 * @param {number} [limit=40]
 * @returns {Promise<string[]>}
 */
export async function getRecentSessionFiles(sessionsDir, limit = 40) {
  const allFiles = await findJsonlFiles(sessionsDir);
  const filesWithStats = [];

  for (const file of allFiles) {
    try {
      const fileStat = await stat(file);
      filesWithStats.push({
        path: file,
        mtime: fileStat.mtimeMs,
      });
    } catch {
      // Lewati jika file tidak dapat diakses
    }
  }

  // Urutkan dari yang paling baru
  filesWithStats.sort((a, b) => b.mtime - a.mtime);

  if (limit > 0 && limit < filesWithStats.length) {
    return filesWithStats.slice(0, limit).map((f) => f.path);
  }

  return filesWithStats.map((f) => f.path);
}

/**
 * Parsing argumen CLI sederhana.
 *
 * @param {string[]} args
 */
export function parseCliArgs(args) {
  let isJson = false;
  let lastCount = 40;
  let customDir = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      isJson = true;
    } else if (arg === "--last") {
      const val = args[i + 1];
      if (val === "all") {
        lastCount = 0;
      } else {
        const parsed = parseInt(val, 10);
        if (!Number.isNaN(parsed)) {
          lastCount = parsed;
        }
      }
      i++;
    } else if (arg.startsWith("--last=")) {
      const val = arg.slice(7);
      if (val === "all") {
        lastCount = 0;
      } else {
        const parsed = parseInt(val, 10);
        if (!Number.isNaN(parsed)) {
          lastCount = parsed;
        }
      }
    } else if (arg === "--dir") {
      customDir = args[i + 1];
      i++;
    } else if (arg.startsWith("--dir=")) {
      customDir = arg.slice(6);
    } else if (!arg.startsWith("-") && !customDir) {
      customDir = arg;
    }
  }

  return { isJson, lastCount, customDir };
}

/**
 * Fungsi utama eksekusi CLI.
 */
export async function main() {
  const { isJson, lastCount, customDir } = parseCliArgs(process.argv.slice(2));

  const sessionsDir = customDir
    ? path.resolve(process.cwd(), customDir)
    : path.join(os.homedir(), ".pi", "agent", "sessions");

  const sessionFiles = await getRecentSessionFiles(sessionsDir, lastCount);

  const allBreaks = [];

  for (const filePath of sessionFiles) {
    try {
      const content = await readFile(filePath, "utf8");
      const sessionBreaks = analyzeSession(content, filePath);
      allBreaks.push(...sessionBreaks);
    } catch {
      // Lewati file yang gagal dibaca
    }
  }

  const summary = summarizeBreaks(allBreaks, sessionFiles.length);

  if (isJson) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    process.stdout.write(formatSummaryTable(summary) + "\n");
  }
}

// Jalankan jika dieksekusi langsung
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err?.message || err}\n`);
    process.exit(1);
  });
}
