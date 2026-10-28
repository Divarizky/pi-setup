#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Menghitung false positive rate task-judge dari log keputusan.
 *
 * Input:
 *   --log    path task-judge.log (default: ~/.pi/agent/task-judge.log)
 *   --labels path file JSON label manual: [{ "timestamp": "...", "real": true|false }]
 *            real=true  -> run memang belum terverifikasi (peringatan benar)
 *            real=false -> peringatan palsu
 *   --since  ISO timestamp; hanya run sesudah waktu ini (default: 2026-10-28T08:45:00Z,
 *            setelah perbaikan detektor)
 *
 * Ambang enforce ditetapkan owner sebelum data dihitung; skrip hanya melaporkan angka.
 */

export const DEFAULT_SINCE = "2026-10-28T08:45:00.000Z";

export function parseLog(text) {
  const entries = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      skipped++;
    }
  }
  return { entries, skipped };
}

/** Hanya run yang dinilai (bukan dikecualikan) dan sesudah waktu `since`. */
export function selectEvaluated(entries, since = DEFAULT_SINCE) {
  return entries.filter(
    (e) =>
      typeof e.timestamp === "string" &&
      e.timestamp >= since &&
      (e.decision === "terverifikasi" || e.decision === "tidak_terverifikasi"),
  );
}

/**
 * Mencocokkan label manual ke entri log lewat timestamp.
 * Entri tanpa label dihitung sebagai belum dilabeli, bukan benar atau salah.
 */
export function computeStats(evaluated, labels = []) {
  const labelByTs = new Map(labels.map((l) => [l.timestamp, l.real]));
  let warnings = 0;
  let labeled = 0;
  let falsePositives = 0;
  let truePositives = 0;

  for (const entry of evaluated) {
    if (entry.decision !== "tidak_terverifikasi") continue;
    warnings++;
    if (!labelByTs.has(entry.timestamp)) continue;
    labeled++;
    if (labelByTs.get(entry.timestamp) === false) falsePositives++;
    else truePositives++;
  }

  const fpRate = labeled === 0 ? null : falsePositives / labeled;
  return {
    evaluatedRuns: evaluated.length,
    warnings,
    labeled,
    unlabeled: warnings - labeled,
    truePositives,
    falsePositives,
    fpRate,
  };
}

function formatPercent(value) {
  return value === null ? "belum ada label" : `${(value * 100).toFixed(1)}%`;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const logPath = get(
    "--log",
    path.join(os.homedir(), ".pi", "agent", "task-judge.log"),
  );
  const labelsPath = get("--labels", null);
  const since = get("--since", DEFAULT_SINCE);

  const { entries, skipped } = parseLog(await readFile(logPath, "utf8"));
  const labels = labelsPath
    ? JSON.parse(await readFile(labelsPath, "utf8"))
    : [];
  const stats = computeStats(selectEvaluated(entries, since), labels);

  console.log(`Log: ${logPath}`);
  console.log(`Sejak: ${since}`);
  console.log(`Baris dilewati (tidak valid JSON): ${skipped}`);
  console.log(`Run dinilai: ${stats.evaluatedRuns}`);
  console.log(`Peringatan (tidak_terverifikasi): ${stats.warnings}`);
  console.log(`Sudah dilabeli: ${stats.labeled}, belum: ${stats.unlabeled}`);
  console.log(`Benar: ${stats.truePositives}, palsu: ${stats.falsePositives}`);
  console.log(`False positive rate: ${formatPercent(stats.fpRate)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
