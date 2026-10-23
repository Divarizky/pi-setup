import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ModelInventoryEntry, ModelLock, ProviderUsage, ServedAccount, UsageLimit } from "./providers.ts";

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
const MODEL_KEYED_PROVIDERS: ReadonlySet<string> = new Set(["antigravity", "kiro", "xkiro"]);

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
    connectionId: finite(connection.id),
    accountName: name || undefined,
    cooldownUntil: finite(connection.routing_cooldown_until),
    isExhausted: quota?.is_exhausted === true || (finite(quota?.remaining) ?? 1) <= 0,
    quota: plan,
    balance,
    message: error,
    updatedAt,
    stale,
    lockedModels: parseRoutingLocks(connection.routing_locks),
    modelInventory: parseRoutingInventory(connection.routing_inventory),
  };
}

/** Lock per model dari router, dinormalkan ke bentuk usage tracker. */
function parseRoutingLocks(value: unknown): ModelLock[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const locks: ModelLock[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const model = typeof record?.model === "string" ? record.model.trim() : "";
    const lockedUntil = finite(record?.locked_until);
    if (!model || lockedUntil === undefined) continue;
    locks.push({ model, lockedUntil });
  }
  return locks.length > 0 ? locks : undefined;
}

/** Sisa kuota per model dari inventory router. */
function parseRoutingInventory(value: unknown): ModelInventoryEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: ModelInventoryEntry[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const model = typeof record?.model_id === "string" ? record.model_id.trim() : "";
    if (!model) continue;
    entries.push({
      model,
      remaining: finite(record?.quota_remaining),
      resetsAt: finite(record?.quota_reset_at),
    });
  }
  return entries.length > 0 ? entries : undefined;
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
  all: (...params: unknown[]) => unknown[];
}

interface SqliteDatabase {
  prepare: (query: string) => SqliteStatement;
  close: () => void;
}

/**
 * Data routing router yang tidak ada di `/api/quota`: lock per model, sisa kuota
 * per model dari inventory, dan cooldown akun. Ketiganya menentukan akun mana
 * yang benar-benar melayani request, jadi quota bar harus ikut memperhitungkannya.
 */
interface ZenithRoutingData {
  /** connection_id -> daftar model yang dikunci. */
  readonly locks: ReadonlyMap<number, ReadonlyArray<{ model: string; locked_until: number }>>;
  /** connection_id -> sisa kuota per model. */
  readonly inventory: ReadonlyMap<number, ReadonlyArray<{ model_id: string; quota_remaining?: number; quota_reset_at?: number }>>;
  /** connection_id -> batas akhir cooldown akun. */
  readonly cooldowns: ReadonlyMap<number, number>;
}

const EMPTY_ROUTING: ZenithRoutingData = { locks: new Map(), inventory: new Map(), cooldowns: new Map() };

/**
 * Baca tabel routing router. Tabel bisa belum ada di instalasi lama, jadi
 * kegagalan per tabel tidak menggagalkan seluruh pembacaan.
 */
function readZenithRoutingData(database: SqliteDatabase): ZenithRoutingData {
  const locks = new Map<number, Array<{ model: string; locked_until: number }>>();
  const inventory = new Map<number, Array<{ model_id: string; quota_remaining?: number; quota_reset_at?: number }>>();
  const cooldowns = new Map<number, number>();

  const readTable = (query: string): unknown[] => {
    try {
      return database.prepare(query).all();
    } catch {
      return [];
    }
  };

  for (const row of readTable("SELECT connection_id, model, locked_until FROM connection_model_locks")) {
    const record = asRecord(row);
    const connectionId = finite(record?.connection_id);
    const model = typeof record?.model === "string" ? record.model.trim() : "";
    const lockedUntil = finite(record?.locked_until);
    if (connectionId === undefined || !model || lockedUntil === undefined) continue;
    const bucket = locks.get(connectionId) ?? [];
    bucket.push({ model, locked_until: lockedUntil });
    locks.set(connectionId, bucket);
  }

  for (const row of readTable(
    "SELECT connection_id, model_id, quota_remaining, quota_reset_at FROM antigravity_account_models",
  )) {
    const record = asRecord(row);
    const connectionId = finite(record?.connection_id);
    const model = typeof record?.model_id === "string" ? record.model_id.trim() : "";
    if (connectionId === undefined || !model) continue;
    const bucket = inventory.get(connectionId) ?? [];
    bucket.push({
      model_id: model,
      quota_remaining: finite(record?.quota_remaining),
      quota_reset_at: finite(record?.quota_reset_at),
    });
    inventory.set(connectionId, bucket);
  }

  for (const row of readTable("SELECT id, cooldown_until FROM connections WHERE cooldown_until > 0")) {
    const record = asRecord(row);
    const connectionId = finite(record?.id);
    const cooldownUntil = finite(record?.cooldown_until);
    if (connectionId === undefined || cooldownUntil === undefined) continue;
    cooldowns.set(connectionId, cooldownUntil);
  }

  return { locks, inventory, cooldowns };
}

/**
 * Payload berbentuk sama dengan `/api/quota`, dibaca read-only dari database.
 * Hanya kolom non-rahasia dan `$.quota` yang diambil dari `credentials`.
 */
function readZenithDb(path: string): unknown[] | undefined {
  const opened = openZenithDb(path);
  if (!opened) return undefined;
  const { database, routing } = opened;
  try {
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
      const id = finite(record.id);
      return {
        ...record,
        quota,
        routing_locks: id === undefined ? undefined : routing.locks.get(id),
        routing_inventory: id === undefined ? undefined : routing.inventory.get(id),
        routing_cooldown_until: id === undefined ? undefined : routing.cooldowns.get(id),
      };
    });
  } catch {
    return undefined;
  } finally {
    database.close();
  }
}

/** Buka database Zenith dan baca data routing-nya dalam satu kali akses. */
function openDatabase(path: string): SqliteDatabase | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => SqliteDatabase;
    };
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return undefined;
  }
}

function openZenithDb(path: string): { database: SqliteDatabase; routing: ZenithRoutingData } | undefined {
  const database = openDatabase(path);
  if (!database) return undefined;
  return { database, routing: readZenithRoutingData(database) };
}

/**
 * Nama akun dari header `X-Zenith-Account`, yaitu nama koneksi yang melayani
 * request. Header dicocokkan tanpa membedakan huruf besar-kecil.
 */
export function servedAccountFromHeaders(
  headers: Readonly<Record<string, string>>,
  now: Date,
): ServedAccount | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === "x-zenith-account");
  const accountName = entry?.[1]?.trim();
  if (!accountName) return undefined;
  return { accountName, observedAt: now.getTime() };
}

/**
 * Koneksi yang melayani request terakhir untuk provider dan model ini, dari
 * `usage_history`. `model` berbentuk bare (tanpa prefix router), sama seperti
 * yang tercatat di database.
 */
export function readLastServedAccount(
  provider: string,
  model: string,
  dbPath?: string,
): ServedAccount | undefined {
  const path = dbPath === undefined ? zenithDbPath() : dbPath;
  if (!path) return undefined;
  const database = openDatabase(path);
  if (!database) return undefined;
  try {
    const rows = database
      .prepare(
        "SELECT connection_id, timestamp FROM usage_history " +
          "WHERE provider = ? AND model = ? AND connection_id IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .all(provider, model);
    const record = asRecord(rows[0]);
    const connectionId = finite(record?.connection_id);
    const observedAt = finite(record?.timestamp);
    if (connectionId === undefined || observedAt === undefined) return undefined;
    return { connectionId, observedAt };
  } catch {
    return undefined;
  } finally {
    database.close();
  }
}

/**
 * Data routing untuk payload dari `/api/quota`. Endpoint itu tidak mengirim
 * lock, inventory, maupun cooldown, jadi keduanya digabung di sini.
 */
function readZenithRouting(path: string | undefined): ZenithRoutingData {
  if (!path) return EMPTY_ROUTING;
  const opened = openZenithDb(path);
  if (!opened) return EMPTY_ROUTING;
  try {
    return opened.routing;
  } finally {
    opened.database.close();
  }
}

/** Gabungkan data routing ke payload `/api/quota` yang sudahdinormalkan. */
function applyRouting(
  payload: readonly unknown[],
  routing: ZenithRoutingData,
): readonly unknown[] {
  if (routing.locks.size === 0 && routing.inventory.size === 0 && routing.cooldowns.size === 0) {
    return payload;
  }
  return payload.map((entry) => {
    const record = asRecord(entry);
    const id = record ? finite(record.id) : undefined;
    if (!record || id === undefined) return entry;
    const locks = routing.locks.get(id);
    const inventory = routing.inventory.get(id);
    const cooldownUntil = routing.cooldowns.get(id);
    if (!locks && !inventory && cooldownUntil === undefined) return entry;
    return {
      ...record,
      routing_locks: locks,
      routing_inventory: inventory,
      routing_cooldown_until: cooldownUntil,
    };
  });
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
  const dbPath = options.dbPath === undefined ? zenithDbPath() : options.dbPath;
  try {
    const response = await fetchImpl(`${options.baseUrl ?? zenithBaseUrl()}/api/quota`, {
      headers: { Accept: "application/json" },
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload: unknown = await response.json();
    // Endpoint ini tidak mengirim lock, inventory, maupun cooldown, jadi datanya
    // diambil dari database Zenith yang sama.
    const routed = applyRouting(Array.isArray(payload) ? payload : [], readZenithRouting(dbPath ?? undefined));
    writeCache(cachePath, { version: 1, fetchedAt: now.getTime(), payload: routed });
    return parsePayload(routed, now, false);
  } catch {
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
