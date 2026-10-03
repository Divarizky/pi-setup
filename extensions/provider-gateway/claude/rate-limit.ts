// Teruskan rate_limit_event dari Claude CLI ke extension lain (usage-tracker).
// Event dikirim lewat pi.events untuk instance yang sama dan disimpan ke cache
// file agar instance Pi lain ikut membaca. Isi rate_limit_info disimpan apa
// adanya; parsing (pecahan 0-1, reset dalam detik epoch) dilakukan pembaca.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CLAUDE_RATE_LIMIT_CHANNEL = "claude:rate-limit";

type RateLimitEntry = { receivedAt: number; info: Record<string, unknown> };
type RateLimitFile = { version: 1; entries: Record<string, RateLimitEntry> };

export function claudeRateLimitFile(): string {
  return join(getAgentDir(), "cache", "claude-rate-limit.json");
}

function readEntries(path: string): Record<string, RateLimitEntry> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RateLimitFile>;
    return parsed.version === 1 && parsed.entries && typeof parsed.entries === "object"
      ? parsed.entries
      : {};
  } catch {
    return {};
  }
}

/** Simpan per rateLimitType supaya event five_hour tidak menimpa seven_day. */
function persist(entry: RateLimitEntry): void {
  const path = claudeRateLimitFile();
  const type = typeof entry.info.rateLimitType === "string" ? entry.info.rateLimitType : "unknown";
  const file: RateLimitFile = { version: 1, entries: { ...readEntries(path), [type]: entry } };
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file)}\n`, "utf8");
  renameSync(temp, path);
}

export function publishClaudeRateLimit(pi: ExtensionAPI | null, info: unknown): void {
  if (typeof info !== "object" || info === null) return;
  const entry: RateLimitEntry = { receivedAt: Date.now(), info: info as Record<string, unknown> };
  try {
    persist(entry);
  } catch {
    // Cache gagal ditulis; event in-process tetap dikirim.
  }
  try {
    pi?.events.emit(CLAUDE_RATE_LIMIT_CHANNEL, entry);
  } catch {
    // Listener yang error tidak boleh mengganggu stream.
  }
}
