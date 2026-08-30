import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type {
  ProviderPeriodUsage,
  ProviderUsage,
  UsageLimit,
  UsageTotals,
} from "./providers.ts";

export interface NineRouterDailyRow {
  readonly dateKey?: unknown;
  readonly data?: unknown;
}

export interface NineRouterConnectionRow {
  readonly id?: unknown;
  readonly provider?: unknown;
  readonly name?: unknown;
  readonly isActive?: unknown;
  readonly data?: unknown;
}

type JsonRecord = Record<string, unknown>;

type SqliteDatabase = {
  prepare: (query: string) => {
    all: (...params: unknown[]) => Array<Record<string, unknown>>;
  };
  close: () => void;
};

type SqliteConstructor = new (file: string, options?: object) => SqliteDatabase;

const NINEROUTER_PROVIDER = "9router";
const DEFAULT_SOURCE = "9Router lokal";

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cached: 0, total: 0, cost: 0 };
}

function addTotals(target: UsageTotals, value: unknown): UsageTotals {
  const record = asRecord(value);
  if (!record) return target;
  const input = number(
    record.promptTokens ?? record.inputTokens ?? record.input_tokens,
  );
  const output = number(
    record.completionTokens ?? record.outputTokens ?? record.output_tokens,
  );
  const cached = number(
    record.cachedTokens ?? record.cacheReadTokens ?? record.cached_input_tokens,
  );
  return {
    input: target.input + input,
    output: target.output + output,
    cached: target.cached + cached,
    total: target.total + input + output + cached,
    cost: (target.cost ?? 0) + number(record.cost),
  };
}

function parseDailyData(row: NineRouterDailyRow): JsonRecord | undefined {
  if (typeof row.data === "string") {
    try {
      return asRecord(JSON.parse(row.data));
    } catch {
      return undefined;
    }
  }
  return asRecord(row.data);
}

function statusFromConnection(
  rows: readonly NineRouterConnectionRow[],
): string {
  if (rows.length === 0) return "no-auth / passthrough";
  const active = rows.filter(
    (row) => row.isActive !== 0 && row.isActive !== false,
  );
  const unavailable = active.filter((row) => {
    const data = asRecord(
      typeof row.data === "string" ? parseJson(row.data) : row.data,
    );
    return (
      data?.testStatus === "unavailable" ||
      data?.testStatus === "error" ||
      data?.errorCode === 429
    );
  });
  if (unavailable.length > 0) {
    const errorCodes = unavailable
      .map(
        (row) =>
          asRecord(
            typeof row.data === "string" ? parseJson(row.data) : row.data,
          )?.errorCode,
      )
      .filter((code): code is number => typeof code === "number");
    return errorCodes.length > 0
      ? `bermasalah (${[...new Set(errorCodes)].join(", ")})`
      : "bermasalah";
  }
  return active.length > 0 ? `aktif (${active.length} koneksi)` : "nonaktif";
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function period(
  label: "today" | "billing",
  totals: UsageTotals,
): ProviderPeriodUsage {
  return { period: label, status: "ok", totals };
}

export function parseNineRouterUsage(
  dailyRows: readonly NineRouterDailyRow[],
  connectionRows: readonly NineRouterConnectionRow[],
  now = new Date(),
): readonly ProviderUsage[] {
  const todayKey = dateKey(now);
  const billingKey = dateKey(monthStart(now));
  const totalsByProvider = new Map<
    string,
    { today: UsageTotals; billing: UsageTotals }
  >();

  for (const row of dailyRows) {
    if (typeof row.dateKey !== "string") continue;
    const data = parseDailyData(row);
    const byProvider = asRecord(data?.byProvider);
    if (!byProvider || row.dateKey < billingKey || row.dateKey > todayKey)
      continue;
    for (const [provider, value] of Object.entries(byProvider)) {
      const current = totalsByProvider.get(provider) ?? {
        today: emptyTotals(),
        billing: emptyTotals(),
      };
      current.billing = addTotals(current.billing, value);
      if (row.dateKey === todayKey)
        current.today = addTotals(current.today, value);
      totalsByProvider.set(provider, current);
    }
  }

  const connectionsByProvider = new Map<string, NineRouterConnectionRow[]>();
  for (const row of connectionRows) {
    if (typeof row.provider !== "string" || !row.provider.trim()) continue;
    const provider = row.provider.trim();
    const rows = connectionsByProvider.get(provider) ?? [];
    rows.push(row);
    connectionsByProvider.set(provider, rows);
  }

  const providerIds = new Set([
    ...connectionsByProvider.keys(),
    ...totalsByProvider.keys(),
  ]);
  return (
    [...providerIds]
      .filter((provider) => provider !== NINEROUTER_PROVIDER)
      // Provider tanpa quota API hanya ditampilkan jika memang memiliki token
      // usage lokal pada periode yang sedang ditampilkan.
      .filter((provider) => {
        const totals = totalsByProvider.get(provider);
        return Boolean(totals && totals.today.input + totals.today.output > 0);
      })
      .sort()
      .map((provider): ProviderUsage => {
        const totals = totalsByProvider.get(provider) ?? {
          today: emptyTotals(),
          billing: emptyTotals(),
        };
        const connections = connectionsByProvider.get(provider) ?? [];
        return {
          provider,
          source: DEFAULT_SOURCE,
          status: "ok",
          today: period("today", totals.today),
          billing: period("billing", totals.billing),
          quota: statusFromConnection(connections),
          message:
            "Usage token tercatat lokal; sisa kuota upstream tidak disediakan 9Router.",
        };
      })
  );
}

function dataDirCandidates(): readonly string[] {
  const override = process.env.DATA_DIR?.trim();
  if (override) return [override];
  const home = homedir();
  if (process.platform === "win32") {
    return [
      join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "9router"),
    ];
  }
  if (process.platform === "darwin") {
    return [
      join(home, "Library", "Application Support", "9router"),
      join(home, ".9router"),
    ];
  }
  return [
    join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "9router"),
    join(home, ".9router"),
  ];
}

function sqlitePath(dataDir: string): string | undefined {
  const candidates = [
    join(dataDir, "runtime", "node_modules", "better-sqlite3"),
    join(dataDir, "node_modules", "better-sqlite3"),
    join(
      dataDir,
      "resources",
      "app.asar.unpacked",
      "node_modules",
      "better-sqlite3",
    ),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function cliToken(dataDir: string): string {
  const rawMachineId = readFileSync(join(dataDir, "machine-id"), "utf8").trim();
  const cliSecret = readFileSync(
    join(dataDir, "auth", "cli-secret"),
    "utf8",
  ).trim();
  if (!rawMachineId || !cliSecret)
    throw new Error("autentikasi CLI 9Router tidak tersedia");
  return createHash("sha256")
    .update(rawMachineId + "9r-cli-auth" + cliSecret)
    .digest("hex")
    .substring(0, 16);
}

function openDatabase(): { database: SqliteDatabase; dataDir: string } {
  const dataDir = dataDirCandidates().find((candidate) =>
    existsSync(join(candidate, "db", "data.sqlite")),
  );
  if (!dataDir) throw new Error("database 9Router tidak ditemukan");
  const modulePath = sqlitePath(dataDir);
  if (!modulePath) throw new Error("modul database 9Router tidak ditemukan");
  const Database = createRequire(import.meta.url)(
    modulePath,
  ) as SqliteConstructor;
  return {
    database: new Database(join(dataDir, "db", "data.sqlite"), {
      readonly: true,
    }),
    dataDir,
  };
}

function readNineRouterConnections(): {
  rows: NineRouterConnectionRow[];
  dataDir: string;
} {
  const { database, dataDir } = openDatabase();
  try {
    return {
      rows: database
        .prepare(
          "SELECT id, provider, name, isActive, data FROM providerConnections",
        )
        .all(),
      dataDir,
    };
  } finally {
    database.close();
  }
}

function finite(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function quotaLimit(value: unknown, label: string): UsageLimit | undefined {
  const quota = asRecord(value);
  if (!quota) return undefined;
  const explicitRemaining = finite(quota.remainingPercentage);
  const used = finite(quota.used);
  const total = finite(quota.total);
  const usedPercent =
    explicitRemaining !== undefined
      ? 100 - Math.max(0, Math.min(100, explicitRemaining))
      : used !== undefined && total !== undefined && total > 0
        ? (used / total) * 100
        : undefined;
  if (usedPercent === undefined || !Number.isFinite(usedPercent))
    return undefined;
  const resetValue = quota.resetAt;
  const resetNumber = finite(resetValue);
  const resetDate =
    resetNumber !== undefined
      ? new Date(resetNumber < 1e12 ? resetNumber * 1000 : resetNumber)
      : typeof resetValue === "string"
        ? new Date(resetValue)
        : undefined;
  return {
    label: typeof quota.name === "string" ? quota.name : label,
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    resetsAt:
      resetDate && Number.isFinite(resetDate.getTime()) ? resetDate : undefined,
  };
}

function parseNineRouterQuota(
  provider: string,
  connection: NineRouterConnectionRow,
  payload: unknown,
  localUsage: readonly ProviderUsage[],
): ProviderUsage | undefined {
  const root = asRecord(payload);
  const rawQuotas = asRecord(root?.quotas);
  if (!rawQuotas) return undefined;
  const limits = Object.entries(rawQuotas)
    .map(([label, value]) => quotaLimit(value, label))
    .filter((value): value is UsageLimit => value !== undefined);
  if (limits.length === 0) return undefined;

  const local = localUsage.find((entry) => entry.provider === provider);
  const id =
    typeof connection.id === "string" ? connection.id.slice(0, 8) : "unknown";
  const name =
    typeof connection.name === "string" && connection.name.trim()
      ? ` · ${connection.name.trim()}`
      : ` · koneksi ${id}`;
  const plan = typeof root?.plan === "string" ? root.plan : undefined;
  return {
    provider,
    label: `${provider}${name}`,
    source: "9Router quota API",
    status: "ok",
    today: local?.today ?? {
      period: "today",
      status: "unavailable",
      message: "usage lokal tidak tersedia",
    },
    billing: local?.billing ?? {
      period: "billing",
      status: "unavailable",
      message: "usage lokal tidak tersedia",
    },
    limits,
    quota: plan,
    message: typeof root?.message === "string" ? root.message : undefined,
  };
}

export async function fetchNineRouterQuotas(
  localUsage: readonly ProviderUsage[],
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<readonly ProviderUsage[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let connectionInfo: { rows: NineRouterConnectionRow[]; dataDir: string };
  try {
    connectionInfo = readNineRouterConnections();
  } catch {
    return [];
  }

  let token: string;
  try {
    token = cliToken(connectionInfo.dataDir);
  } catch {
    return [];
  }
  const baseUrl =
    process.env.NINEROUTER_URL?.trim() || "http://localhost:20128";
  const activeConnections = connectionInfo.rows.filter(
    (row) =>
      row.isActive !== 0 &&
      row.isActive !== false &&
      typeof row.id === "string" &&
      typeof row.provider === "string",
  );
  const results = await Promise.all(
    activeConnections.map(async (connection) => {
      const provider = String(connection.provider);
      try {
        const response = await fetchImpl(
          `${baseUrl}/api/usage/${encodeURIComponent(String(connection.id))}`,
          {
            headers: { Accept: "application/json", "x-9r-cli-token": token },
            signal: options.signal,
          },
        );
        if (!response.ok) return undefined;
        return parseNineRouterQuota(
          provider,
          connection,
          await response.json(),
          localUsage,
        );
      } catch {
        return undefined;
      }
    }),
  );

  // usageDaily hanya menyimpan agregat per provider. Tampilkan agregat itu
  // sekali saja agar dua koneksi provider yang sama tidak menggandakan angka.
  const seenProviders = new Set<string>();
  return results
    .filter((value): value is ProviderUsage => value !== undefined)
    .map((value) => {
      if (seenProviders.has(value.provider)) {
        return {
          ...value,
          today: {
            period: "today",
            status: "unavailable",
            message: "usage agregat ditampilkan pada koneksi pertama",
          },
          billing: {
            period: "billing",
            status: "unavailable",
            message: "usage agregat ditampilkan pada koneksi pertama",
          },
        };
      }
      seenProviders.add(value.provider);
      return value;
    });
}

export function readNineRouterUsage(
  now = new Date(),
): readonly ProviderUsage[] {
  const dataDir = dataDirCandidates().find((candidate) =>
    existsSync(join(candidate, "db", "data.sqlite")),
  );
  if (!dataDir) throw new Error("database 9Router tidak ditemukan");
  const modulePath = sqlitePath(dataDir);
  if (!modulePath) throw new Error("modul database 9Router tidak ditemukan");

  const Database = createRequire(import.meta.url)(
    modulePath,
  ) as SqliteConstructor;
  const database = new Database(join(dataDir, "db", "data.sqlite"), {
    readonly: true,
  });
  try {
    const dailyRows = database
      .prepare("SELECT dateKey, data FROM usageDaily")
      .all();
    const connectionRows = database
      .prepare("SELECT provider, name, isActive, data FROM providerConnections")
      .all();
    return parseNineRouterUsage(dailyRows, connectionRows, now);
  } finally {
    database.close();
  }
}

export function unavailableNineRouterUsage(message: string): ProviderUsage {
  const unavailable = (label: "today" | "billing"): ProviderPeriodUsage => ({
    period: label,
    status: "unavailable",
    message,
  });
  return {
    provider: NINEROUTER_PROVIDER,
    source: DEFAULT_SOURCE,
    status: "unavailable",
    today: unavailable("today"),
    billing: unavailable("billing"),
    message: `Usage lokal 9Router tidak tersedia: ${message}`,
    quota: "data tidak tersedia",
  };
}
