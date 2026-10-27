#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Menghasilkan JSON representasi kanonik (kunci objek terurut alfabetis).
 */
export function canonicalJson(val) {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(val).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(val[k])}`).join(",")}}`;
}

/**
 * Menghasilkan hash ringkas 8 karakter untuk identitas argumen tanpa membuka rahasia.
 */
export function hashString(str) {
  return createHash("sha256").update(str).digest("hex").slice(0, 8);
}

/**
 * Menemukan seluruh file .jsonl secara rekursif di bawah direktori tertentu.
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
      // Abaikan direktori yang tidak dapat diakses atau teruskan
    }
  }
  return results.sort();
}

/**
 * Mem-parse satu file sesi JSONL dan mengekstrak metrik serta 3 pola kegagalan.
 */
export function parseSessionContent(rawContent, filePath = "unknown") {
  const lines = rawContent.split("\n");
  let lineCount = 0;
  let skippedLines = 0;
  let messageCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let toolErrorCount = 0;
  let bashExitErrorCount = 0;

  const messages = [];
  const allToolCalls = [];
  const allToolResults = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    lineCount++;

    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      skippedLines++;
      continue;
    }

    if (record.type === "message" && record.message) {
      messageCount++;
      const role = record.message.role;
      const content = Array.isArray(record.message.content)
        ? record.message.content
        : [];

      const parsedMsg = {
        id: record.id || `line-${lineCount}`,
        role,
        content,
        toolCalls: [],
        text: "",
        toolResult: null,
      };

      if (role === "assistant") {
        const textParts = [];
        for (const item of content) {
          if (item?.type === "toolCall") {
            toolCallCount++;
            let args = item.arguments;
            if (typeof args === "string") {
              try {
                args = JSON.parse(args);
              } catch {
                // pertahankan string jika parse gagal
              }
            }
            const canonArgs = canonicalJson(args);
            const argHash = hashString(canonArgs);
            const tcEntry = {
              name: item.name || "unknown",
              canonArgs,
              argHash,
              signature: `${item.name || "unknown"}:::${canonArgs}`,
            };
            parsedMsg.toolCalls.push(tcEntry);
            allToolCalls.push(tcEntry);
          } else if (item?.type === "text" && typeof item.text === "string") {
            textParts.push(item.text);
          }
        }
        parsedMsg.text = textParts.join("");
      } else if (role === "toolResult") {
        toolResultCount++;
        const toolName = record.message.toolName || "unknown";
        const isError = Boolean(record.message.isError);
        if (isError) toolErrorCount++;

        let isBashExit = false;
        if (toolName === "bash" && isError) {
          const resText = Array.isArray(content)
            ? content.map((c) => c?.text || "").join(" ")
            : String(content || "");
          if (/Command exited with code \d+/.test(resText)) {
            isBashExit = true;
            bashExitErrorCount++;
          }
        }

        const trEntry = {
          toolName,
          isError,
          isBashExit,
        };
        parsedMsg.toolResult = trEntry;
        allToolResults.push(trEntry);
      }

      messages.push(parsedMsg);
    }
  }

  // 1. Pola 1: Loop tool identik berturut-turut tanpa toolCall lain di antaranya
  const loopStreaks = [];
  let currentLoopKey = null;
  let currentLoopTool = null;
  let currentLoopHash = null;
  let currentLoopLen = 0;

  for (const tc of allToolCalls) {
    if (tc.signature === currentLoopKey) {
      currentLoopLen++;
    } else {
      if (currentLoopLen >= 3) {
        loopStreaks.push({
          toolName: currentLoopTool,
          argHash: currentLoopHash,
          length: currentLoopLen,
        });
      }
      currentLoopKey = tc.signature;
      currentLoopTool = tc.name;
      currentLoopHash = tc.argHash;
      currentLoopLen = 1;
    }
  }
  if (currentLoopLen >= 3) {
    loopStreaks.push({
      toolName: currentLoopTool,
      argHash: currentLoopHash,
      length: currentLoopLen,
    });
  }

  // 2. Pola 2: Berhenti kosong
  // giliran assistant terakhir sebelum sesi atau run berhenti tidak berisi toolCall
  // dan teksnya kosong atau hanya spasi, padahal pesan sebelumnya adalah toolResult.
  const emptyStops = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const isRunStop =
        i === messages.length - 1 || messages[i + 1].role === "user";
      if (isRunStop) {
        const hasNoToolCall = msg.toolCalls.length === 0;
        const isEmptyText = msg.text.trim() === "";
        const isPrevToolResult = i > 0 && messages[i - 1].role === "toolResult";
        if (hasNoToolCall && isEmptyText && isPrevToolResult) {
          emptyStops.push({
            id: msg.id,
            filePath,
          });
        }
      }
    }
  }

  // 3. Pola 3: Error tool beruntun (toolResult dengan isError true)
  // Total beruntun dan per tool beruntun
  const totalErrorStreaks = [];
  let curTotalErrLen = 0;

  for (const tr of allToolResults) {
    if (tr.isError) {
      curTotalErrLen++;
    } else {
      if (curTotalErrLen >= 3) {
        totalErrorStreaks.push(curTotalErrLen);
      }
      curTotalErrLen = 0;
    }
  }
  if (curTotalErrLen >= 3) {
    totalErrorStreaks.push(curTotalErrLen);
  }

  // Per-tool streaks: streak beruntun langsung di mana tool yang sama gagal N kali berturut-turut
  const sameToolErrorStreaks = [];
  let curSameTool = null;
  let curSameToolLen = 0;

  for (const tr of allToolResults) {
    if (tr.isError) {
      if (tr.toolName === curSameTool) {
        curSameToolLen++;
      } else {
        if (curSameTool && curSameToolLen >= 3) {
          sameToolErrorStreaks.push({
            toolName: curSameTool,
            length: curSameToolLen,
          });
        }
        curSameTool = tr.toolName;
        curSameToolLen = 1;
      }
    } else {
      if (curSameTool && curSameToolLen >= 3) {
        sameToolErrorStreaks.push({
          toolName: curSameTool,
          length: curSameToolLen,
        });
      }
      curSameTool = null;
      curSameToolLen = 0;
    }
  }
  if (curSameTool && curSameToolLen >= 3) {
    sameToolErrorStreaks.push({
      toolName: curSameTool,
      length: curSameToolLen,
    });
  }

  return {
    lineCount,
    skippedLines,
    messageCount,
    toolCallCount,
    toolResultCount,
    toolErrorCount,
    bashExitErrorCount,
    loopStreaks,
    emptyStops,
    totalErrorStreaks,
    sameToolErrorStreaks,
  };
}

/**
 * Melakukan audit terhadap seluruh file sesi di direktori yang diberikan.
 */
export async function auditDirectory(sessionsDir) {
  const filePaths = await findJsonlFiles(sessionsDir);
  const totalFiles = filePaths.length;

  let totalLines = 0;
  let totalSkippedLines = 0;
  let totalMessages = 0;
  let totalToolCalls = 0;
  let totalToolResults = 0;
  let totalToolErrors = 0;
  let totalBashExitErrors = 0;

  // Pola 1: Loop tool identik per ambang
  const loopIncidents = { 3: 0, 4: 0, 5: 0 };
  const loopAffectedSessions = {
    3: new Set(),
    4: new Set(),
    5: new Set(),
  };
  const loopToolBreakdown = {};

  // Pola 2: Berhenti kosong
  let emptyStopIncidents = 0;
  const emptyStopAffectedSessions = new Set();
  const sampleEmptyStopIds = [];

  // Pola 3: Error beruntun total per ambang
  const totalErrIncidents = { 3: 0, 4: 0, 5: 0 };
  const totalErrAffectedSessions = {
    3: new Set(),
    4: new Set(),
    5: new Set(),
  };

  // Pola 3: Error beruntun per tool per ambang
  const perToolErrIncidents = {}; // toolName -> { 3, 4, 5 }
  const perToolErrAffectedSessions = {}; // toolName -> { 3: Set, 4: Set, 5: Set }

  for (let fileIdx = 0; fileIdx < totalFiles; fileIdx++) {
    const filePath = filePaths[fileIdx];
    let content = "";
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      totalSkippedLines++;
      continue;
    }

    const sessionData = parseSessionContent(content, path.basename(filePath));

    totalLines += sessionData.lineCount;
    totalSkippedLines += sessionData.skippedLines;
    totalMessages += sessionData.messageCount;
    totalToolCalls += sessionData.toolCallCount;
    totalToolResults += sessionData.toolResultCount;
    totalToolErrors += sessionData.toolErrorCount;
    totalBashExitErrors += sessionData.bashExitErrorCount;

    // Evaluasi Pola 1
    for (const streak of sessionData.loopStreaks) {
      const toolKey = `${streak.toolName} (arg:${streak.argHash})`;
      if (!loopToolBreakdown[toolKey]) {
        loopToolBreakdown[toolKey] = {
          toolName: streak.toolName,
          argHash: streak.argHash,
          maxStreak: 0,
          countN3: 0,
        };
      }
      loopToolBreakdown[toolKey].countN3++;
      if (streak.length > loopToolBreakdown[toolKey].maxStreak) {
        loopToolBreakdown[toolKey].maxStreak = streak.length;
      }

      for (const n of [3, 4, 5]) {
        if (streak.length >= n) {
          loopIncidents[n]++;
          loopAffectedSessions[n].add(fileIdx);
        }
      }
    }

    // Evaluasi Pola 2
    for (const es of sessionData.emptyStops) {
      emptyStopIncidents++;
      emptyStopAffectedSessions.add(fileIdx);
      if (sampleEmptyStopIds.length < 15) {
        sampleEmptyStopIds.push(es.id);
      }
    }

    // Evaluasi Pola 3 Total
    for (const len of sessionData.totalErrorStreaks) {
      for (const n of [3, 4, 5]) {
        if (len >= n) {
          totalErrIncidents[n]++;
          totalErrAffectedSessions[n].add(fileIdx);
        }
      }
    }

    // Evaluasi Pola 3 Per Tool
    for (const item of sessionData.sameToolErrorStreaks) {
      const t = item.toolName;
      if (!perToolErrIncidents[t]) {
        perToolErrIncidents[t] = { 3: 0, 4: 0, 5: 0 };
        perToolErrAffectedSessions[t] = {
          3: new Set(),
          4: new Set(),
          5: new Set(),
        };
      }
      for (const n of [3, 4, 5]) {
        if (item.length >= n) {
          perToolErrIncidents[t][n]++;
          perToolErrAffectedSessions[t][n].add(fileIdx);
        }
      }
    }
  }

  function pct(count) {
    if (totalFiles === 0) return 0;
    return Number(((count / totalFiles) * 100).toFixed(1));
  }

  const perToolFormatted = {};
  for (const [t, counts] of Object.entries(perToolErrIncidents)) {
    perToolFormatted[t] = {
      3: {
        incidents: counts[3],
        affectedSessions: perToolErrAffectedSessions[t][3].size,
        affectedPercent: pct(perToolErrAffectedSessions[t][3].size),
      },
      4: {
        incidents: counts[4],
        affectedSessions: perToolErrAffectedSessions[t][4].size,
        affectedPercent: pct(perToolErrAffectedSessions[t][4].size),
      },
      5: {
        incidents: counts[5],
        affectedSessions: perToolErrAffectedSessions[t][5].size,
        affectedPercent: pct(perToolErrAffectedSessions[t][5].size),
      },
    };
  }

  return {
    summary: {
      sessionsDirectory: sessionsDir,
      totalFiles,
      totalLines,
      skippedLines: totalSkippedLines,
      totalMessages,
      totalToolCalls,
      totalToolResults,
      totalToolErrors,
      totalBashExitErrors,
    },
    patterns: {
      identicalLoops: {
        3: {
          incidents: loopIncidents[3],
          affectedSessions: loopAffectedSessions[3].size,
          affectedPercent: pct(loopAffectedSessions[3].size),
        },
        4: {
          incidents: loopIncidents[4],
          affectedSessions: loopAffectedSessions[4].size,
          affectedPercent: pct(loopAffectedSessions[4].size),
        },
        5: {
          incidents: loopIncidents[5],
          affectedSessions: loopAffectedSessions[5].size,
          affectedPercent: pct(loopAffectedSessions[5].size),
        },
        frequentLoops: Object.values(loopToolBreakdown)
          .sort((a, b) => b.countN3 - a.countN3)
          .slice(0, 5),
      },
      emptyStops: {
        incidents: emptyStopIncidents,
        affectedSessions: emptyStopAffectedSessions.size,
        affectedPercent: pct(emptyStopAffectedSessions.size),
        sampleIds: sampleEmptyStopIds,
      },
      consecutiveErrors: {
        total: {
          3: {
            incidents: totalErrIncidents[3],
            affectedSessions: totalErrAffectedSessions[3].size,
            affectedPercent: pct(totalErrAffectedSessions[3].size),
          },
          4: {
            incidents: totalErrIncidents[4],
            affectedSessions: totalErrAffectedSessions[4].size,
            affectedPercent: pct(totalErrAffectedSessions[4].size),
          },
          5: {
            incidents: totalErrIncidents[5],
            affectedSessions: totalErrAffectedSessions[5].size,
            affectedPercent: pct(totalErrAffectedSessions[5].size),
          },
        },
        perTool: perToolFormatted,
      },
    },
  };
}

/**
 * Memformat hasil audit ke dalam representasi teks tabular ramah terminal.
 */
export function formatTextReport(data) {
  const s = data.summary;
  const p = data.patterns;

  const lines = [];
  lines.push(
    "================================================================================",
  );
  lines.push(
    "                         AUDIT SESI PI FAILURE-RECOVERY (F-02)                  ",
  );
  lines.push(
    "================================================================================",
  );
  lines.push(`Direktori sesi   : ${s.sessionsDirectory}`);
  lines.push(`Jumlah file sesi : ${s.totalFiles}`);
  lines.push(
    `Jumlah baris     : ${s.totalLines} (baris dilewati: ${s.skippedLines})`,
  );
  lines.push(`Jumlah pesan     : ${s.totalMessages}`);
  lines.push(`Jumlah toolCall  : ${s.totalToolCalls}`);
  lines.push(
    `Jumlah toolResult: ${s.totalToolResults} (error: ${s.totalToolErrors}, bash exit error: ${s.totalBashExitErrors})`,
  );
  lines.push("");

  lines.push(
    "--------------------------------------------------------------------------------",
  );
  lines.push(
    "POLA 1: LOOP TOOL IDENTIK (Argumen Identik Tanpa ToolCall Lain di Antaranya)",
  );
  lines.push(
    "--------------------------------------------------------------------------------",
  );
  lines.push("Ambang (N) | Kejadian | Sesi Terdampak | % Sesi Terdampak");
  lines.push("-----------+----------+----------------+-----------------");
  for (const n of [3, 4, 5]) {
    const item = p.identicalLoops[n];
    const amb = `N=${n}`.padEnd(10);
    const kej = String(item.incidents).padStart(8);
    const ses = String(item.affectedSessions).padStart(14);
    const pct = `${item.affectedPercent}%`.padStart(15);
    lines.push(`${amb} | ${kej} | ${ses} | ${pct}`);
  }
  if (p.identicalLoops.frequentLoops.length > 0) {
    lines.push("");
    lines.push("Tool paling sering loop (ringkasan hash argumen):");
    for (const loop of p.identicalLoops.frequentLoops) {
      lines.push(
        `  - Tool: ${loop.toolName}, ArgHash: ${loop.argHash}, Muncul: ${loop.countN3}x (Streak maks: ${loop.maxStreak})`,
      );
    }
  }
  lines.push("");

  lines.push(
    "--------------------------------------------------------------------------------",
  );
  lines.push(
    "POLA 2: BERHENTI KOSONG (Assistant Akhir Kosong Setelah ToolResult)",
  );
  lines.push(
    "--------------------------------------------------------------------------------",
  );
  lines.push(`Jumlah kejadian : ${p.emptyStops.incidents}`);
  lines.push(
    `Sesi terdampak  : ${p.emptyStops.affectedSessions} (${p.emptyStops.affectedPercent}%)`,
  );
  lines.push(
    `Contoh ID baris : ${p.emptyStops.sampleIds.slice(0, 10).join(", ") || "-"}`,
  );
  lines.push("");

  lines.push(
    "--------------------------------------------------------------------------------",
  );
  lines.push("POLA 3: ERROR TOOL BERUNTUN (ToolResult isError=true)");
  lines.push(
    "--------------------------------------------------------------------------------",
  );
  lines.push("A. Total Error Beruntun (Semua Tool):");
  lines.push("Ambang (N) | Kejadian | Sesi Terdampak | % Sesi Terdampak");
  lines.push("-----------+----------+----------------+-----------------");
  for (const n of [3, 4, 5]) {
    const item = p.consecutiveErrors.total[n];
    const amb = `N=${n}`.padEnd(10);
    const kej = String(item.incidents).padStart(8);
    const ses = String(item.affectedSessions).padStart(14);
    const pct = `${item.affectedPercent}%`.padStart(15);
    lines.push(`${amb} | ${kej} | ${ses} | ${pct}`);
  }

  lines.push("");
  lines.push("B. Error Beruntun Per Tool (Tool yang Sama Gagal Beruntun):");
  lines.push(
    "Nama Tool        | N=3 Kejadian (Sesi) | N=4 Kejadian (Sesi) | N=5 Kejadian (Sesi)",
  );
  lines.push(
    "-----------------+---------------------+---------------------+--------------------",
  );
  const toolNames = Object.keys(p.consecutiveErrors.perTool).sort();
  if (toolNames.length === 0) {
    lines.push("Tidak ada error beruntun per tool (N>=3)");
  } else {
    for (const tool of toolNames) {
      const dataTool = p.consecutiveErrors.perTool[tool];
      const tCol = tool.padEnd(16);
      const c3 =
        `${dataTool[3].incidents} (${dataTool[3].affectedSessions})`.padStart(
          19,
        );
      const c4 =
        `${dataTool[4].incidents} (${dataTool[4].affectedSessions})`.padStart(
          19,
        );
      const c5 =
        `${dataTool[5].incidents} (${dataTool[5].affectedSessions})`.padStart(
          19,
        );
      lines.push(`${tCol} | ${c3} | ${c4} | ${c5}`);
    }
  }
  lines.push(
    "================================================================================",
  );
  lines.push(
    "Catatan privasi: isi argumen perintah dan konten tool tidak dicetak ke output.",
  );

  return lines.join("\n");
}

/**
 * Entry point CLI.
 */
export async function main() {
  const args = process.argv.slice(2);
  let sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--dir" && i + 1 < args.length) {
      sessionsDir = path.resolve(process.cwd(), args[++i]);
    } else if (arg.startsWith("--dir=")) {
      sessionsDir = path.resolve(process.cwd(), arg.slice(6));
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Penggunaan: node scripts/audit-sessions.mjs [opsi]

Opsi:
  --dir <path>  Direktori sesi JSONL (default: ~/.pi/agent/sessions)
  --json        Keluarkan output dalam format JSON ke stdout
  --help, -h    Tampilkan bantuan ini
`);
      process.exit(0);
    }
  }

  try {
    const reportData = await auditDirectory(sessionsDir);
    if (jsonOutput) {
      console.log(JSON.stringify(reportData, null, 2));
    } else {
      console.log(formatTextReport(reportData));
    }
  } catch (error) {
    console.error(`Audit gagal: ${error.message}`);
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  await main();
}
