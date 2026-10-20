import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ProviderUsage, UsageLimit } from "./providers.ts";

/**
 * Kuota koneksi Zenith Router (`zenith-router`, gateway lokal port 20120).
 *
 * Sumber data: `GET {ZENITH_URL}/api/quota`. Satu request mengembalikan semua
 * koneksi beserta kuota terakhir yang sudah di-cache Zenith di SQLite-nya, jadi
 * endpoint ini murah: ia tidak memanggil provider upstream dan tidak butuh
 * kredensial (hanya bisa diakses dari loopback).
 *
 * Saat login dashboard Zenith aktif, `/api/quota` menolak request tanpa sesi
 * (401). Kuota lalu dibaca langsung dari database Zenith secara read-only bila
 * lokasinya diketahui lewat env `ZENITH_DB_PATH` atau `zenithDbPath` di
 * `usage-tracker.json` pada agent dir. Query hanya mengambil `$.quota`, jadi
 * token akun tidak pernah keluar dari SQLite.
 *
 * Hasil sukses terakhir disimpan di `cache/zenith-quota.json` supaya dashboard
 * tetap menampilkan angka terakhir saat Zenith sedang tidak berjalan.
 *
 * Sama seperti 9Router, provider yang dipakai di sini adalah provider upstream
 * (`codex`, `antigravity`, ...), bukan id transport `zenith`, karena quota bar
 * mencocokkan model lewat prefix alias (`cx/...`, `ag/...`).
 */

export const ZENITH_PROVIDER_ID = "zenith";
/** ID auth lama; provider-gateway masih membacanya sebagai cadangan. */
export const ZENITH_LEGACY_PROVIDER_ID = "zenroute";

const DEFAULT_BASE_URL = "http://127.0.0.1:20120";
const DEFAULT_MAX_AGE_MS = 60_000;
const STALE_AFTER_MS = 15 * 60_000;
/** Cache hasil sukses terakhir hanya dipakai saat endpoint gagal bila masih sebaru ini. */
const MAX_FALLBACK_AGE_MS = 30 * 60_000;
const CACHE_VERSION = 1;
const CACHE_FILE = "zenith-quota.json";
let cacheWriteSequence = 0;
/**
 * Provider Zenith yang bucket kuotanya per model (key seperti `gemini-4-argon-low`),
 * bukan per jendela waktu. Provider lain tetap memakai bucket terpakai tertinggi.
 */
const MODEL_KEYED_PROVIDERS: ReadonlySet<string> = new Set(["antigravity"]);

export function isZenithProvider(providerId: string): boolean {
  return providerId === ZENITH_PROVIDER_ID || providerId === ZENITH_LEGACY_PROVIDER_ID;
}

/** Base URL Zenith, sejalan dengan provider-gateway. */
export function zenithBaseUrl(): string {
  const configured = process.env.ZENITH_URL?.trim() || process.env.ZENROUTE_URL?.trim();
  return (configured || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export interface ZenithFetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly now?: Date;
  /** Umur maksimum cache sebelum `/api/quota` dipanggil lagi. */
  readonly maxAgeMs?: number;
  readonly cacheDir?: string;
  readonly baseUrl?: string;
  /** Path database Zenith; `null` mematikan pembacaan database. */
  readonly dbPath?: string | null;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function finite(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** ISO string atau epoch detik/milidetik -> epoch milidetik. */
function epochMs(value: unknown): number | undefined {
  const numeric = finite(value);
  if (numeric !== undefined) return numeric < 1e12 ? numeric * 1000 : numeric;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

interface QuotaPoolItem {
  readonly group?: string;
  readonly window?: string;
  readonly label?: string;
  readonly bucketId?: string;
  readonly remainingPercentage?: number;
  readonly resetAt?: string | null;
}

function parsePoolLimit(value: unknown): UsageLimit | undefined {
  const item = asRecord(value) as QuotaPoolItem | undefined;
  if (!item) return undefined;
  const remaining = finite(item.remainingPercentage);
  if (remaining === undefined) return undefined;
  const usedPercent = clampPercent(100 - remaining);
  const resetMs = epochMs(item.resetAt);
  const label = typeof item.label === "string" && item.label.trim()
    ? item.label.trim()
    : typeof item.group === "string" && item.group.trim()
      ? item.group.trim()
      : undefined;
  if (!label) return undefined;
  const key = typeof item.bucketId === "string" && item.bucketId.trim()
    ? item.bucketId.trim()
    : label;

  return {
    label,
    key,
    pool: true,
    usedPercent,
    resetsAt: resetMs !== undefined ? new Date(resetMs) : undefined,
  };
}

/**
 * Satu bar kuota Zenith. Bentuk barisnya sama antar provider:
 * `{ used, total, remainingPercentage, resetAt, displayName }`.
 */
function quotaLimit(value: unknown, label: string): UsageLimit | undefined {
  const quota = asRecord(value);
  if (!quota) return undefined;

  const remaining = finite(quota.remainingPercentage);
  const used = finite(quota.used);
  const total = finite(quota.total);
  const usedPercent = remaining !== undefined
    ? 100 - clampPercent(remaining)
    : used !== undefined && total !== undefined && total > 0
      ? (used / total) * 100
      : undefined;
  if (usedPercent === undefined) return undefined;

  const resetMs = epochMs(quota.resetAt);
  const displayName = typeof quota.displayName === "string" ? quota.displayName.trim() : "";
  return {
    label: displayName || label,
    key: label,
    usedPercent: clampPercent(usedPercent),
    resetsAt: resetMs !== undefined ? new Date(resetMs) : undefined,
  };
}

/**
 * Provider bersaldo (OpenRouter dan sejenisnya) tidak punya `quotas`, hanya
 * nominal. Bentuknya jadi satu baris saldo, bukan bar persentase.
 */
function formatBalance(quota: JsonRecord): string | undefined {
  const unit = typeof quota.unit === "string" ? quota.unit.trim() : "";
  if (unit === "unknown") return undefined;

  const remaining = finite(quota.remaining);
  const limit = finite(quota.limit);
  const usage = finite(quota.usage);
  const currency = unit === "credits_usd" ? "$" : "";
  const suffix = currency || !unit ? "" : ` ${unit}`;
  const amount = (value: number): string => {
    const rounded = Math.round(value * 100) / 100;
    return `${currency}${rounded}${suffix}`;
  };

  if (remaining !== undefined && limit !== undefined) return `${amount(remaining)} / ${amount(limit)}`;
  if (remaining !== undefined && usage !== undefined) return `${amount(remaining)} (terpakai ${amount(usage)})`;
  if (limit !== undefined && usage !== undefined) return `terpakai ${amount(usage)} / ${amount(limit)}`;
  if (remaining !== undefined) return amount(remaining);
  return undefined;
}

function unavailable(period: "today" | "billing"): ProviderUsage["today"] {
  return { period, status: "unavailable", message: "usage token tidak dikirim Zenith" };
}

/** Satu koneksi Zenith -> satu kartu dashboard. Koneksi tanpa data berguna dibuang. */
function toProviderUsage(entry: unknown, now: Date, fromCache: boolean): ProviderUsage | undefined {
  const connection = asRecord(entry);
  if (!connection) return undefined;
  if (connection.is_active === 0 || connection.is_active === false) return undefined;

  const provider = typeof connection.provider === "string" ? connection.provider.trim() : "";
  if (!provider) return undefined;

  const quota = asRecord(connection.quota);
  const pools = Array.isArray(quota?.pools)
    ? quota.pools
      .map(parsePoolLimit)
      .filter((value): value is UsageLimit => value !== undefined)
    : [];

  const rawQuotas = asRecord(quota?.quotas);
  const modelLimits = rawQuotas
    ? Object.entries(rawQuotas)
      .map(([label, value]) => quotaLimit(value, label))
      .filter((value): value is UsageLimit => value !== undefined)
    : [];
  const limits = [...pools, ...modelLimits];
  const balance = quota ? formatBalance(quota) : undefined;
  const error = typeof quota?.error === "string" && quota.error.trim() ? quota.error.trim() : undefined;
  if (limits.length === 0 && !balance && !error) return undefined;

  const plan = typeof quota?.plan === "string" && quota.plan.trim() ? quota.plan.trim() : undefined;
  const updatedMs = epochMs(quota?.updated_at);
  const updatedAt = updatedMs !== undefined ? new Date(updatedMs) : undefined;
  const name = typeof connection.name === "string" ? connection.name.trim() : "";
  const id = connection.id === undefined ? "unknown" : String(connection.id).slice(0, 8);
  // Umur snapshot menentukan stale, bukan asal datanya: kuota yang baru disajikan
  // lewat HTTP tetap bisa tua kalau Zenith belum menyinkronkannya lagi. Tanpa
  // tanggal, hanya hasil cache yang dianggap tidak pasti.
  const stale = updatedAt === undefined
    ? fromCache
    : updatedAt.getTime() > now.getTime() || now.getTime() - updatedAt.getTime() > STALE_AFTER_MS;

  return {
    provider,
    label: `${provider}${name ? ` · ${name}` : ` · koneksi ${id}`}`,
    source: "Zenith quota API",
    origin: "local-router",
    status: limits.length > 0 || balance ? "ok" : "unavailable",
    today: unavailable("today"),
    billing: unavailable("billing"),
    limits: limits.length > 0 ? limits : undefined,
    perModelBuckets: MODEL_KEYED_PROVIDERS.has(provider),
    priority: finite(connection.priority),
    quota: plan,
    balance,
    message: error,
    updatedAt,
    stale,
  };
}

function parsePayload(payload: unknown, now: Date, fromCache: boolean): readonly ProviderUsage[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((entry) => toProviderUsage(entry, now, fromCache))
    .filter((value): value is ProviderUsage => value !== undefined);
}

interface ZenithCacheFile {
  readonly version: 1;
  readonly fetchedAt: number;
  readonly payload: unknown;
}

function readCache(path: string): ZenithCacheFile | undefined {
  try {
    const parsed = asRecord(JSON.parse(readFileSync(path, "utf8")));
    const fetchedAt = finite(parsed?.fetchedAt);
    if (parsed?.version !== CACHE_VERSION || fetchedAt === undefined) return undefined;
    return { version: 1, fetchedAt, payload: parsed.payload };
  } catch {
    return undefined;
  }
}

function writeCache(path: string, value: ZenithCacheFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Nomor urut supaya dua refresh bersamaan tidak memakai file temporary yang sama.
    const temp = `${path}.${process.pid}.${++cacheWriteSequence}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value)}\n`, "utf8");
    renameSync(temp, path);
  } catch {
    // Cache bersifat opsional.
  }
}

/** Lokasi database Zenith dari env atau `usage-tracker.json`; tanpa tebakan path. */
function zenithDbPath(): string | undefined {
  const fromEnv = process.env.ZENITH_DB_PATH?.trim();
  if (fromEnv) return fromEnv;
  try {
    const config = asRecord(JSON.parse(readFileSync(join(getAgentDir(), "usage-tracker.json"), "utf8")));
    const configured = typeof config?.zenithDbPath === "string" ? config.zenithDbPath.trim() : "";
    return configured || undefined;
  } catch {
    return undefined;
  }
}

interface SqliteStatement {
  all: () => unknown[];
}

interface SqliteDatabase {
  prepare: (query: string) => SqliteStatement;
  close: () => void;
}

/**
 * Payload berbentuk sama dengan `/api/quota`, dibaca read-only dari database.
 * Hanya kolom non-rahasia dan `$.quota` yang diambil dari `credentials`.
 */
function readZenithDb(path: string): unknown[] | undefined {
  if (!existsSync(path)) return undefined;
  let database: SqliteDatabase | undefined;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => SqliteDatabase;
    };
    database = new DatabaseSync(path, { readOnly: true });
    const rows = database
      .prepare(
        "SELECT id, name, provider, auth_type, is_active, priority, " +
          "json_extract(credentials, '$.quota') AS quota FROM connections ORDER BY id ASC",
      )
      .all();
    return rows.map((row) => {
      const record = asRecord(row) ?? {};
      let quota: unknown = null;
      if (typeof record.quota === "string") {
        try {
          quota = JSON.parse(record.quota);
        } catch {
          quota = null;
        }
      }
      return { ...record, quota };
    });
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}

/**
 * Kuota semua koneksi Zenith. Tidak pernah melempar: saat endpoint gagal,
 * database Zenith dibaca langsung, lalu hasil sukses terakhir dipakai dengan
 * penanda `stale`.
 */
export async function fetchZenithQuotas(options: ZenithFetchOptions = {}): Promise<readonly ProviderUsage[]> {
  const now = options.now ?? new Date();
  const cachePath = join(options.cacheDir ?? join(getAgentDir(), "cache"), CACHE_FILE);
  const cached = readCache(cachePath);
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  // `fetchedAt` di masa depan (clock skew atau cache rusak) tidak boleh membuat
  // endpoint tidak pernah dipanggil lagi.
  if (cached && cached.fetchedAt <= now.getTime() && now.getTime() - cached.fetchedAt < maxAgeMs) {
    return parsePayload(cached.payload, now, true);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${options.baseUrl ?? zenithBaseUrl()}/api/quota`, {
      headers: { Accept: "application/json" },
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload: unknown = await response.json();
    writeCache(cachePath, { version: 1, fetchedAt: now.getTime(), payload });
    return parsePayload(payload, now, false);
  } catch {
    const dbPath = options.dbPath === undefined ? zenithDbPath() : options.dbPath;
    const fromDb = dbPath ? readZenithDb(dbPath) : undefined;
    if (fromDb) {
      writeCache(cachePath, { version: 1, fetchedAt: now.getTime(), payload: fromDb });
      return parsePayload(fromDb, now, false);
    }
    // Cache yang terlalu tua tidak ditampilkan sebagai kuota aktif.
    const usable = cached && now.getTime() - cached.fetchedAt <= MAX_FALLBACK_AGE_MS;
    return usable ? parsePayload(cached.payload, now, true) : [];
  }
}
