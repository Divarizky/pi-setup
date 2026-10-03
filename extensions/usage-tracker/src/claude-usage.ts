import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { UsageLimit } from "./providers.ts";

/**
 * Usage langganan Claude Pro/Max untuk provider `claude` (provider-gateway).
 *
 * Sumber data:
 * - `/api/oauth/usage`, dipanggil paling sering sekali per `maxAgeMs` untuk semua
 *   instance Pi karena hasilnya disimpan di cache file bersama. Respons 429
 *   menyimpan `retry-after` sebagai backoff.
 * - `rate_limit_event` dari Claude CLI yang ditulis provider-gateway ke
 *   `cache/claude-rate-limit.json` dan dikirim lewat `pi.events`.
 *
 * Skala nilai: endpoint memakai persen 0-100 dan reset ISO string, sedangkan
 * rate_limit_event memakai pecahan 0-1 dan reset dalam detik epoch.
 */

export const CLAUDE_RATE_LIMIT_CHANNEL = "claude:rate-limit";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const ATTEMPT_LOCK_MS = 30_000;
const DEFAULT_RETRY_AFTER_MS = 5 * 60_000;
const MAX_RETRY_AFTER_MS = 6 * 3_600_000;
const ERROR_BACKOFF_MS = 2 * 60_000;

type WindowKey = "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "extra_usage";

const WINDOWS: readonly { key: WindowKey; label: string; seconds?: number }[] = [
  { key: "five_hour", label: "5h session", seconds: 5 * 3600 },
  { key: "seven_day", label: "7d weekly", seconds: 7 * 24 * 3600 },
  { key: "seven_day_opus", label: "7d Opus", seconds: 7 * 24 * 3600 },
  { key: "seven_day_sonnet", label: "7d Sonnet", seconds: 7 * 24 * 3600 },
  { key: "extra_usage", label: "Extra Usage" },
];

export interface WindowReading {
  readonly usedPercent?: number;
  /** Epoch milidetik. */
  readonly resetsAt?: number;
  /** Epoch milidetik saat nilai diamati. */
  readonly observedAt: number;
}

export type WindowReadings = Partial<Record<WindowKey, WindowReading>>;

interface UsageCacheFile {
  version: 1;
  fetchedAt?: number;
  windows?: Partial<Record<WindowKey, { usedPercent: number; resetsAt?: number }>>;
  extraUsageEnabled?: boolean;
  attemptAt?: number;
  backoffUntil?: number;
  lastError?: string;
}

export interface ClaudeUsageSnapshot {
  readonly limits: readonly UsageLimit[];
  readonly quota?: string;
  readonly updatedAt?: Date;
  readonly stale: boolean;
  readonly message?: string;
}

export interface ClaudeUsageOptions {
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly now?: Date;
  /** Umur maksimum cache sebelum endpoint dipanggil lagi. */
  readonly maxAgeMs?: number;
  readonly cacheDir?: string;
  readonly credentialsPath?: string;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function parseIsoMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/** Detik epoch dari CLI; nilai yang sudah milidetik dibiarkan. */
function epochMs(value: unknown): number | undefined {
  const n = finite(value);
  if (n === undefined || n <= 0) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

function defaultCacheDir(): string {
  return join(getAgentDir(), "cache");
}

function defaultCredentialsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  return join(configDir, ".credentials.json");
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value)}\n`, "utf8");
    renameSync(temp, path);
  } catch {
    // Cache bersifat opsional.
  }
}

function readUsageCache(path: string): UsageCacheFile {
  const parsed = asRecord(readJson(path));
  return parsed?.version === 1 ? (parsed as unknown as UsageCacheFile) : { version: 1 };
}

interface ClaudeCredentials {
  readonly accessToken: string;
  readonly expiresAt?: number;
  readonly subscriptionType?: string;
}

function readCredentials(path: string): ClaudeCredentials | undefined {
  const oauth = asRecord(asRecord(readJson(path))?.claudeAiOauth);
  const accessToken = oauth?.accessToken;
  if (typeof accessToken !== "string" || !accessToken) return undefined;
  return {
    accessToken,
    expiresAt: finite(oauth?.expiresAt),
    subscriptionType: typeof oauth?.subscriptionType === "string" ? oauth.subscriptionType : undefined,
  };
}

/** Parse respons `/api/oauth/usage`. `utilization` di sini sudah dalam persen. */
export function parseOAuthUsagePayload(payload: unknown): {
  windows: NonNullable<UsageCacheFile["windows"]>;
  extraUsageEnabled: boolean;
} {
  const data = asRecord(payload);
  const windows: NonNullable<UsageCacheFile["windows"]> = {};
  if (!data) return { windows, extraUsageEnabled: false };

  const rawLimits = Array.isArray(data.limits) ? data.limits.map(asRecord) : [];
  const fromLimits = (group: string): JsonRecord | undefined =>
    rawLimits.find((l) => l?.group === group || String(l?.kind ?? "").startsWith(group));

  for (const { key } of WINDOWS) {
    if (key === "extra_usage") continue;
    const window = asRecord(data[key]);
    const fallback = key === "five_hour" ? fromLimits("session") : key === "seven_day" ? fromLimits("weekly") : undefined;
    const percent = finite(window?.utilization) ?? finite(fallback?.percent);
    if (percent === undefined) continue;
    windows[key] = {
      usedPercent: clampPercent(percent),
      resetsAt: parseIsoMs(window?.resets_at) ?? parseIsoMs(fallback?.resets_at),
    };
  }

  const extra = asRecord(data.extra_usage);
  const extraUsageEnabled = extra?.is_enabled === true;
  const extraPercent = finite(extra?.utilization);
  if (extraUsageEnabled && extraPercent !== undefined) {
    windows.extra_usage = { usedPercent: clampPercent(extraPercent) };
  }
  return { windows, extraUsageEnabled };
}

export function windowsToLimits(windows: NonNullable<UsageCacheFile["windows"]>): UsageLimit[] {
  return WINDOWS.flatMap(({ key, label, seconds }) => {
    const window = windows[key];
    return window
      ? [{
        label,
        usedPercent: window.usedPercent,
        limitWindowSeconds: seconds,
        resetsAt: window.resetsAt !== undefined ? new Date(window.resetsAt) : undefined,
      }]
      : [];
  });
}

/** Parse `rate_limit_info` dari Claude CLI. `utilization` di sini pecahan 0-1. */
export function readingsFromRateLimitInfo(info: unknown, receivedAt: number): WindowReadings {
  const record = asRecord(info);
  const readings: WindowReadings = {};
  if (!record) return readings;

  const unified = asRecord(record.unifiedWindows);
  for (const key of ["five_hour", "seven_day"] as const) {
    const window = asRecord(unified?.[key]);
    const fraction = finite(window?.utilization);
    if (!window || fraction === undefined) continue;
    readings[key] = { usedPercent: clampPercent(fraction * 100), resetsAt: epochMs(window.resetsAt), observedAt: receivedAt };
  }

  const type = record.rateLimitType;
  if (typeof type === "string" && WINDOWS.some((w) => w.key === type) && !readings[type as WindowKey]) {
    const fraction = finite(record.utilization);
    const usedPercent = fraction !== undefined
      ? clampPercent(fraction * 100)
      : record.status === "rejected" ? 100 : undefined;
    const resetsAt = epochMs(record.resetsAt);
    if (usedPercent !== undefined || resetsAt !== undefined) {
      readings[type as WindowKey] = { usedPercent, resetsAt, observedAt: receivedAt };
    }
  }
  return readings;
}

function readRateLimitReadings(path: string): WindowReadings {
  const entries = asRecord(asRecord(readJson(path))?.entries);
  const merged: WindowReadings = {};
  for (const value of Object.values(entries ?? {})) {
    const entry = asRecord(value);
    const receivedAt = finite(entry?.receivedAt);
    if (!entry || receivedAt === undefined) continue;
    const readings = readingsFromRateLimitInfo(entry.info, receivedAt);
    for (const [key, reading] of Object.entries(readings) as [WindowKey, WindowReading][]) {
      const current = merged[key];
      if (!current || reading.observedAt > current.observedAt) merged[key] = reading;
    }
  }
  return merged;
}

function retryAfterMs(response: Response, now: number): number {
  const header = response.headers.get("retry-after")?.trim();
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : new Date(header).getTime() - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : DEFAULT_RETRY_AFTER_MS;
}

function formatClock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function planLabel(subscriptionType: string | undefined, extraUsageEnabled: boolean | undefined): string {
  const plan = subscriptionType
    ? `Claude ${subscriptionType.charAt(0).toUpperCase()}${subscriptionType.slice(1)}`
    : "Claude Pro/Max";
  return extraUsageEnabled ? `${plan} (Extra Usage aktif)` : plan;
}

async function refreshUsageCache(
  cachePath: string,
  cache: UsageCacheFile,
  credentials: ClaudeCredentials,
  now: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<UsageCacheFile> {
  writeJsonAtomic(cachePath, { ...cache, attemptAt: now });
  let next: UsageCacheFile = { ...cache, attemptAt: now };
  try {
    const response = await fetchImpl(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
      signal,
    });
    if (response.status === 429) {
      const backoffUntil = now + retryAfterMs(response, now);
      next = { ...next, backoffUntil, lastError: `rate limited sampai ${formatClock(backoffUntil)}` };
    } else if (!response.ok) {
      next = { ...next, backoffUntil: now + ERROR_BACKOFF_MS, lastError: `HTTP ${response.status}` };
    } else {
      const parsed = parseOAuthUsagePayload(await response.json());
      next = Object.keys(parsed.windows).length > 0
        ? {
          version: 1,
          fetchedAt: now,
          windows: parsed.windows,
          extraUsageEnabled: parsed.extraUsageEnabled,
        }
        : { ...next, backoffUntil: now + ERROR_BACKOFF_MS, lastError: "format respons tidak dikenal" };
    }
  } catch (error) {
    // Abort dari caller tidak dihitung sebagai kegagalan endpoint.
    if (signal?.aborted) return cache;
    next = { ...next, backoffUntil: now + ERROR_BACKOFF_MS, lastError: error instanceof Error ? error.message : String(error) };
  }
  writeJsonAtomic(cachePath, next);
  return next;
}

export async function getClaudeUsage(options: ClaudeUsageOptions = {}): Promise<ClaudeUsageSnapshot> {
  const now = options.now?.getTime() ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const cachePath = join(cacheDir, "claude-usage.json");
  const credentials = readCredentials(options.credentialsPath ?? defaultCredentialsPath());

  let cache = readUsageCache(cachePath);
  let message: string | undefined;
  const due = !cache.fetchedAt || now - cache.fetchedAt >= maxAgeMs;
  const backingOff = (cache.backoffUntil ?? 0) > now;
  const otherInstanceFetching = cache.attemptAt !== undefined &&
    now - cache.attemptAt < ATTEMPT_LOCK_MS &&
    (cache.fetchedAt === undefined || cache.attemptAt > cache.fetchedAt);

  if (!credentials) {
    message = "belum login Claude CLI";
  } else if (credentials.expiresAt !== undefined && credentials.expiresAt <= now) {
    message = "token Claude kedaluwarsa, buka Claude Code untuk refresh";
  } else if (due && !backingOff && !otherInstanceFetching) {
    cache = await refreshUsageCache(cachePath, cache, credentials, now, options.fetchImpl ?? fetch, options.signal);
  }
  if (!message && (cache.backoffUntil ?? 0) > now) message = cache.lastError;

  // Gabungkan snapshot endpoint dengan rate_limit_event yang lebih baru.
  const events = readRateLimitReadings(join(cacheDir, "claude-rate-limit.json"));
  const limits: UsageLimit[] = [];
  let updatedAt: number | undefined;
  for (const { key, label, seconds } of WINDOWS) {
    const base = cache.windows?.[key];
    const event = events[key];
    const eventNewer = event && (cache.fetchedAt === undefined || event.observedAt > cache.fetchedAt);
    const usedPercent = eventNewer && event.usedPercent !== undefined ? event.usedPercent : base?.usedPercent;
    if (usedPercent === undefined) continue;
    let resetsAt = eventNewer && event.resetsAt !== undefined ? event.resetsAt : base?.resetsAt;
    const observedAt = eventNewer ? event.observedAt : cache.fetchedAt!;
    updatedAt = Math.max(updatedAt ?? 0, observedAt);
    // Window yang sudah reset dimulai lagi dari 0%.
    const expired = resetsAt !== undefined && resetsAt <= now;
    if (expired) resetsAt = undefined;
    limits.push({
      label,
      usedPercent: expired ? 0 : usedPercent,
      limitWindowSeconds: seconds,
      resetsAt: resetsAt !== undefined ? new Date(resetsAt) : undefined,
    });
  }

  return {
    limits,
    quota: planLabel(credentials?.subscriptionType, cache.extraUsageEnabled),
    updatedAt: updatedAt !== undefined ? new Date(updatedAt) : undefined,
    stale: updatedAt === undefined || now - updatedAt > maxAgeMs * 2,
    message,
  };
}
