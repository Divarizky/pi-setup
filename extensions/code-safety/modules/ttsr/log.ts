import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ViolationEntry } from "./types.ts";

export const EXCERPT_MAX_LENGTH = 120;
export const NO_EXCERPT_RULES = new Set(["secret-in-write"]);

/**
 * Resolusi direktori agent dari environment variable PI_CODING_AGENT_DIR
 * atau fallback ke ~/.pi/agent.
 */
export function resolveAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (envDir) return envDir;
  return join(homedir(), ".pi", "agent");
}

/**
 * Resolusi path berkas log JSONL.
 */
export function resolveLogPath(agentDir?: string): string {
  return join(agentDir ?? resolveAgentDir(), "ttsr-log.jsonl");
}

/**
 * Sanitasi kutipan cuplikan (excerpt) pelanggaran.
 * Rule secret-in-write DILARANG memuat excerpt (FR-10).
 * Excerpt lain dipotong maksimal 120 karakter.
 */
export function sanitizeExcerpt(
  ruleName: string,
  rawExcerpt?: string,
): string | undefined {
  if (NO_EXCERPT_RULES.has(ruleName)) {
    return undefined;
  }
  if (!rawExcerpt) return undefined;
  if (rawExcerpt.length <= EXCERPT_MAX_LENGTH) return rawExcerpt;
  return rawExcerpt.slice(0, EXCERPT_MAX_LENGTH);
}

/**
 * Menulis satu entri pelanggaran sebagai baris JSON ke berkas log JSONL.
 */
export function appendViolationLog(
  entry: ViolationEntry,
  logPath?: string,
): void {
  const targetPath = logPath ?? resolveLogPath();
  const dir = dirname(targetPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const sanitized: ViolationEntry = {
    ts: typeof entry.ts === "number" ? entry.ts : Date.now(),
    rule: entry.rule,
    action: entry.action,
    scope: entry.scope,
    retry: Boolean(entry.retry),
  };

  const excerpt = sanitizeExcerpt(entry.rule, entry.excerpt);
  if (excerpt !== undefined) {
    sanitized.excerpt = excerpt;
  }

  const line = `${JSON.stringify(sanitized)}\n`;
  appendFileSync(targetPath, line, "utf8");
}

/**
 * Membaca seluruh entri log dari berkas log JSONL.
 * Mengabaikan baris kosong atau baris korup.
 */
export function readViolationLogs(logPath?: string): ViolationEntry[] {
  const targetPath = logPath ?? resolveLogPath();
  if (!existsSync(targetPath)) {
    return [];
  }

  try {
    const raw = readFileSync(targetPath, "utf8");
    const lines = raw.split("\n");
    const entries: ViolationEntry[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as ViolationEntry;
        if (parsed && typeof parsed.rule === "string") {
          entries.push(parsed);
        }
      } catch {
        // Abaikan baris korup demi ketahanan data
      }
    }
    return entries;
  } catch {
    return [];
  }
}

export interface RuleStat {
  rule: string;
  violations: number;
  retries: number;
}

/**
 * Menghitung statistik pelanggaran dan retry koreksi per rule dari log JSONL.
 * Hasil diurutkan dari rule dengan retry terbanyak (paling boros token),
 * lalu pelanggaran terbanyak, kemudian nama rule secara alfabetis (steer-1, FR-11).
 */
export function computeRuleStats(logPath?: string): RuleStat[] {
  const entries = readViolationLogs(logPath);
  const statsMap = new Map<string, { violations: number; retries: number }>();

  for (const entry of entries) {
    let stat = statsMap.get(entry.rule);
    if (!stat) {
      stat = { violations: 0, retries: 0 };
      statsMap.set(entry.rule, stat);
    }
    stat.violations += 1;
    if (entry.retry) {
      stat.retries += 1;
    }
  }

  const list: RuleStat[] = Array.from(statsMap.entries()).map(
    ([rule, data]) => ({
      rule,
      violations: data.violations,
      retries: data.retries,
    }),
  );

  list.sort((a, b) => {
    if (b.retries !== a.retries) return b.retries - a.retries;
    if (b.violations !== a.violations) return b.violations - a.violations;
    return a.rule.localeCompare(b.rule);
  });

  return list;
}
