#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { getRecentSessionFiles, parseJsonlLines, isAssistantTurnWithUsage } from "./classify-cache-breaks.mjs";

/**
 * Model Context Windows lookup table.
 */
export const MODEL_CONTEXT_WINDOWS = {
  "ag/gemini-3.8-flash": 1_000_000,
  "ag/gemini-2.5-flash": 1_000_000,
  "ag/gemini-2.5-pro": 1_000_000,
  "google/gemini-2.0-flash": 1_000_000,
  "cc/claude-sonnet-5-5": 200_000,
  "cc/claude-haiku-5-5": 200_000,
  "cc/claude-opus-5-5": 200_000,
  "anthropic/claude-3-5-sonnet": 200_000,
  "anthropic/claude-3-5-haiku": 200_000,
  "stepfun-ai/step-5-preview": 128_000,
  "nvidia/nemotron-3-ultra-550b-a55b": 128_000,
  "zenith-smart": 128_000,
  "oc/deepseek-v4.1-flash-free": 64_000,
  "deepseek/deepseek-chat": 64_000,
};

export function getModelContextWindow(model) {
  if (!model) return null;
  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];
  if (model.includes("gemini")) return 1_000_000;
  if (model.includes("claude")) return 200_000;
  if (model.includes("deepseek")) return 64_000;
  return 128_000;
}

export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Skenario evaluasi parameter pruning context-manager.
 */
export const SCENARIOS = [
  {
    name: "1. Baseline (Lama: 24k budget, 0.5 watermark)",
    budgetTokens: 24_000,
    watermark: 0.5,
    charThreshold: 8_000,
    lineThreshold: 300,
    looseWindowProtection: false,
  },
  {
    name: "2. Budget 32k, Watermark 0.5",
    budgetTokens: 32_000,
    watermark: 0.5,
    charThreshold: 8_000,
    lineThreshold: 300,
    looseWindowProtection: false,
  },
  {
    name: "3. Budget 32k, Watermark 0.7",
    budgetTokens: 32_000,
    watermark: 0.7,
    charThreshold: 8_000,
    lineThreshold: 300,
    looseWindowProtection: false,
  },
  {
    name: "4. Budget 40k, Watermark 0.5",
    budgetTokens: 40_000,
    watermark: 0.5,
    charThreshold: 8_000,
    lineThreshold: 300,
    looseWindowProtection: false,
  },
  {
    name: "5. Budget 40k, Watermark 0.7",
    budgetTokens: 40_000,
    watermark: 0.7,
    charThreshold: 8_000,
    lineThreshold: 300,
    looseWindowProtection: false,
  },
  {
    name: "6. Budget 32k, Watermark 0.7 + Proteksi Window Longgar (>=500k & <30%)",
    budgetTokens: 32_000,
    watermark: 0.7,
    charThreshold: 8_000,
    lineThreshold: 300,
    looseWindowProtection: true,
  },
  {
    name: "7. Budget 40k, Watermark 0.7 + Proteksi Window Longgar (>=500k & <30%)",
    budgetTokens: 40_000,
    watermark: 0.7,
    charThreshold: 8_000,
    lineThreshold: 300,
    looseWindowProtection: true,
  },
  {
    name: "8. Budget 40k, Watermark 0.5 + Proteksi Window Longgar (>=500k & <30%)",
    budgetTokens: 40_000,
    watermark: 0.5,
    charThreshold: 8_000,
    lineThreshold: 300,
    looseWindowProtection: true,
  },
  {
    name: "9. Budget 32k, Watermark 0.5 + Proteksi Window Longgar (>=500k & <30%)",
    budgetTokens: 32_000,
    watermark: 0.5,
    charThreshold: 8_000,
    lineThreshold: 300,
    looseWindowProtection: true,
  },
  {
    name: "10. Budget 40k, Watermark 0.5 + Char 12k/Line 400 + Proteksi Window Longgar",
    budgetTokens: 40_000,
    watermark: 0.5,
    charThreshold: 12_000,
    lineThreshold: 400,
    looseWindowProtection: true,
  },
  {
    name: "11. Budget 40k, Watermark 0.5 + Char 16k/Line 500 + Proteksi Window Longgar",
    budgetTokens: 40_000,
    watermark: 0.5,
    charThreshold: 16_000,
    lineThreshold: 500,
    looseWindowProtection: true,
  },
];

/**
 * Mengekstrak teks dari pesan toolResult.
 */
function extractToolText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

/**
 * Mensimulasikan satu sesi dengan konfigurasi parameter tertentu.
 *
 * @param {Array<any>} entries
 * @param {typeof SCENARIOS[0]} config
 * @returns {{
 *   pruneEvents: number,
 *   pruneToolCalls: number,
 *   cacheBreaks: number,
 *   retransmittedTokens: number,
 *   tokensSavedInContext: number,
 *   peakLiveTokens: number
 * }}
 */
export function simulateSession(entries, config) {
  const cachedToolResults = new Map(); // toolCallId -> { text, tokens, priority }
  const prunedToolResults = new Set();
  const trackedToolCallIds = []; // urutan kemunculan

  let pruneEvents = 0;
  let pruneToolCalls = 0;
  let cacheBreaks = 0;
  let retransmittedTokens = 0;
  let tokensSavedInContext = 0;
  let peakLiveTokens = 0;

  let prevTurnWasPruned = false;
  let prevPromptTokens = 0;

  for (const item of entries) {
    const entry = item.entry || item;

    // 1. Tool result masuk
    if (entry.type === "message" && entry.message?.role === "toolResult") {
      const tcId = entry.message.toolCallId;
      if (tcId) {
        const raw = extractToolText(entry.message);
        const originalChars = Number(entry.message.details?.contextManager?.originalChars) || raw.length;
        const lineCount = raw.split(/\r?\n/).length;

        // Tentukan apakah diringkas atau disimpan utuh
        const isLarge = originalChars > config.charThreshold || lineCount > config.lineThreshold;
        let storedText = raw;
        if (isLarge) {
          // Output besar diringkas ke ~1900 chars
          storedText = raw.slice(0, 1900);
        }

        // Output < 1500 chars tidak dipangkas / tidak dilacak oleh pruning
        if (storedText.length >= 1500) {
          const tokens = estimateTokens(storedText);
          cachedToolResults.set(tcId, {
            text: storedText,
            tokens,
            priority: 1,
          });
          trackedToolCallIds.push(tcId);
        }
      }
    }

    // 2. Assistant turn (hook 'context' berjalan tepat sebelum turn asisten)
    if (isAssistantTurnWithUsage(entry)) {
      const usage = entry.message.usage;
      const promptTokens = (Number(usage.cacheRead) || 0) + (Number(usage.input) || 0);
      const model = entry.message.model || "";
      const contextWindow = getModelContextWindow(model);
      const contextPercent = contextWindow && promptTokens > 0 ? (promptTokens / contextWindow) * 100 : null;

      // Evaluasi pruning
      // Reverse urutan tool calls (terbaru ke terlama)
      const reversedIds = [...new Set(trackedToolCallIds.filter((id) => !prunedToolResults.has(id)))].reverse();

      const liveTokens = reversedIds.reduce(
        (sum, id) => sum + (cachedToolResults.get(id)?.tokens || 0),
        0,
      );

      if (liveTokens > peakLiveTokens) {
        peakLiveTokens = liveTokens;
      }

      // Hitung budget token
      let effectiveBudget = config.budgetTokens;
      if (contextWindow) {
        // Dibatasi persen context window (20%) bila context window kecil
        effectiveBudget = Math.min(config.budgetTokens, Math.floor((contextWindow * 20) / 100));
      }

      // Proteksi window longgar: jika context window >= 500k dan context usage < 30%, jangan pangkas
      let skipPruning = false;
      if (config.looseWindowProtection && contextWindow && contextWindow >= 500_000) {
        if (contextPercent !== null && contextPercent < 30) {
          skipPruning = true;
        }
      }

      let prunedThisTurn = 0;
      let tokensSavedThisTurn = 0;

      if (!skipPruning && liveTokens > effectiveBudget) {
        const keepLimit = Math.floor(effectiveBudget * config.watermark);
        const preservedIds = new Set();
        let usedTokens = 0;

        for (const id of reversedIds) {
          const itemInfo = cachedToolResults.get(id);
          if (!itemInfo) continue;
          const tokens = itemInfo.tokens;
          const mustKeep = preservedIds.size === 0; // tool terbaru selalu dijaga

          if (mustKeep || usedTokens + tokens <= keepLimit) {
            preservedIds.add(id);
            usedTokens += tokens;
          }
        }

        for (const id of reversedIds) {
          if (!preservedIds.has(id)) {
            const itemInfo = cachedToolResults.get(id);
            prunedToolResults.add(id);
            prunedThisTurn++;
            const saved = (itemInfo?.tokens || 0) - estimateTokens("[context-manager] Output lama dikeluarkan...");
            tokensSavedThisTurn += Math.max(0, saved);
          }
        }
      }

      if (prunedThisTurn > 0) {
        pruneEvents++;
        pruneToolCalls += prunedThisTurn;
        tokensSavedInContext += tokensSavedThisTurn;
        prevTurnWasPruned = true;
      } else {
        // Jika turn sebelumnya melakukan pemangkasan, turn ini mengalami cache break!
        if (prevTurnWasPruned && prevPromptTokens > 5000) {
          cacheBreaks++;
          retransmittedTokens += promptTokens;
        }
        prevTurnWasPruned = false;
      }

      prevPromptTokens = promptTokens;
    }
  }

  return {
    pruneEvents,
    pruneToolCalls,
    cacheBreaks,
    retransmittedTokens,
    tokensSavedInContext,
    peakLiveTokens,
  };
}

/**
 * Menjalankan evaluasi komparatif pada seluruh sesi yang diberikan.
 *
 * @param {string[]} sessionFiles
 * @param {typeof SCENARIOS} [scenarios=SCENARIOS]
 */
export async function runEvaluation(sessionFiles, scenarios = SCENARIOS) {
  // Pre-load semua parsed sessions
  const sessionsData = [];
  for (const file of sessionFiles) {
    try {
      const raw = await readFile(file, "utf8");
      const lines = parseJsonlLines(raw);
      if (lines.length > 0) {
        sessionsData.push({ file, lines });
      }
    } catch {
      // Lewati file yang tidak dapat dibaca
    }
  }

  const results = scenarios.map((scenario) => {
    let totalPruneEvents = 0;
    let totalPruneToolCalls = 0;
    let totalCacheBreaks = 0;
    let totalRetransmittedTokens = 0;
    let totalTokensSavedInContext = 0;
    let maxPeakTokens = 0;

    for (const { lines } of sessionsData) {
      const sim = simulateSession(lines, scenario);
      totalPruneEvents += sim.pruneEvents;
      totalPruneToolCalls += sim.pruneToolCalls;
      totalCacheBreaks += sim.cacheBreaks;
      totalRetransmittedTokens += sim.retransmittedTokens;
      totalTokensSavedInContext += sim.tokensSavedInContext;
      if (sim.peakLiveTokens > maxPeakTokens) {
        maxPeakTokens = sim.peakLiveTokens;
      }
    }

    const netTokenCost = totalRetransmittedTokens - totalTokensSavedInContext;
    const ratio = totalTokensSavedInContext > 0
      ? (totalRetransmittedTokens / totalTokensSavedInContext).toFixed(2)
      : "N/A";

    return {
      scenario: scenario.name,
      pruneEvents: totalPruneEvents,
      pruneToolCalls: totalPruneToolCalls,
      cacheBreaks: totalCacheBreaks,
      retransmittedTokens: totalRetransmittedTokens,
      tokensSavedInContext: totalTokensSavedInContext,
      netTokenCost,
      tradeOffRatio: ratio,
      peakLiveTokens: maxPeakTokens,
    };
  });

  return {
    sessionsAnalyzed: sessionsData.length,
    results,
  };
}

/**
 * Memformat hasil evaluasi menjadi tabel markdown yang informatif.
 */
export function formatEvaluationReport(evalData) {
  const lines = [];
  lines.push(`Total Sesi Dianalisis: ${evalData.sessionsAnalyzed}`);
  lines.push("");
  lines.push("| Skenario | Prune Events | Cache Breaks | Token Retransmisi | Token Disimpan di Context | Net Token Waste | Rasio Rugi (Waste/Saved) | Peak Tool Tokens |");
  lines.push("| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |");

  for (const r of evalData.results) {
    const netFormatted = r.netTokenCost > 0
      ? `+${r.netTokenCost.toLocaleString("id-ID")}`
      : `${r.netTokenCost.toLocaleString("id-ID")}`;
    lines.push(
      `| ${r.scenario} | ${r.pruneEvents} | ${r.cacheBreaks} | ${r.retransmittedTokens.toLocaleString("id-ID")} | ${r.tokensSavedInContext.toLocaleString("id-ID")} | ${netFormatted} | ${r.tradeOffRatio}x | ${r.peakLiveTokens.toLocaleString("id-ID")} |`,
    );
  }

  return lines.join("\n");
}

async function main() {
  const sessionsDir = path.join(os.homedir(), ".pi/agent/sessions");
  const limit = process.argv[2] ? Number.parseInt(process.argv[2], 10) : 40;
  console.log(`Mengambil ${limit} sesi terbaru dari ${sessionsDir}...`);
  const files = await getRecentSessionFiles(sessionsDir, limit);
  console.log(`Menjalankan simulasi terhadap ${files.length} sesi...`);

  const evaluation = await runEvaluation(files, SCENARIOS);
  console.log("\n=== HASIL EVALUASI SIMULASI EMPIRIS AMBANG PRUNING ===\n");
  console.log(formatEvaluationReport(evaluation));
}

if (process.argv[1] && process.argv[1].endsWith("eval-prune-thresholds.mjs")) {
  main().catch((err) => {
    console.error("Gagal menjalankan evaluasi:", err);
    process.exit(1);
  });
}
