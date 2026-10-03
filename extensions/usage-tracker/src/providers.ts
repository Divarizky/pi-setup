import type { AuthResult } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getClaudeUsage, parseOAuthUsagePayload, windowsToLimits } from "./claude-usage.ts";

export type ProviderId = string;
export type UsageStatus = "ok" | "unavailable";

export interface UsagePeriod {
  readonly label: "today" | "billing";
  readonly from: Date;
  readonly to: Date;
}

export interface UsageTotals {
  readonly input: number;
  readonly output: number;
  readonly cached: number;
  readonly total: number;
  readonly cost?: number;
}

export interface ProviderPeriodUsage {
  readonly period: UsagePeriod["label"];
  readonly status: UsageStatus;
  readonly totals?: UsageTotals;
  readonly message?: string;
}

export interface UsageLimit {
  readonly label: string;
  readonly usedPercent: number;
  readonly limitWindowSeconds?: number;
  readonly resetsAt?: Date;
}

export interface ProviderUsage {
  readonly provider: ProviderId;
  readonly label?: string;
  readonly source?: string;
  readonly status: UsageStatus;
  readonly today: ProviderPeriodUsage;
  readonly billing: ProviderPeriodUsage;
  readonly limits?: readonly UsageLimit[];
  readonly quota?: string;
  readonly balance?: string;
  readonly message?: string;
  /** Waktu data limit terakhir diamati. */
  readonly updatedAt?: Date;
  /** Data limit berasal dari cache yang sudah lewat masa segarnya. */
  readonly stale?: boolean;
}

export interface UsageFetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: Date;
  readonly signal?: AbortSignal;
  /** Umur maksimum cache usage Claude sebelum endpoint dipanggil lagi. */
  readonly maxAgeMs?: number;
}

type JsonRecord = Record<string, unknown>;

const PROVIDER_NAMES: Record<ProviderId, string> = {
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  anthropic: "Anthropic",
  claude: "Claude Pro/Max",
  antigravity: "Google Antigravity",
  google: "Google Gemini",
};

export function providerName(provider: ProviderId): string {
  return PROVIDER_NAMES[provider as keyof typeof PROVIDER_NAMES] ?? provider;
}

export function createUsagePeriods(now = new Date()): readonly UsagePeriod[] {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const billingStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now);
  return [
    { label: "today", from: todayStart, to: end },
    { label: "billing", from: billingStart, to: end },
  ];
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null
    ? (value as JsonRecord)
    : undefined;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sumField(records: readonly JsonRecord[], ...keys: string[]): number {
  return records.reduce(
    (total, record) =>
      total + keys.reduce((subtotal, key) => subtotal + number(record[key]), 0),
    0,
  );
}

function resultRecords(payload: unknown): JsonRecord[] {
  const root = asRecord(payload);
  if (!root) return [];
  const buckets = Array.isArray(root.data) ? root.data : [];
  const results: JsonRecord[] = [];
  for (const bucket of buckets) {
    const bucketRecord = asRecord(bucket);
    if (!bucketRecord) continue;
    const bucketResults = Array.isArray(bucketRecord.results)
      ? bucketRecord.results
      : [bucketRecord];
    for (const result of bucketResults) {
      const record = asRecord(result);
      if (record) results.push(record);
    }
  }
  return results;
}

function parseTokenTotals(payload: unknown, provider: ProviderId): UsageTotals {
  const records = resultRecords(payload);
  const input = provider === "anthropic"
    ? sumField(records, "uncached_input_tokens", "input_tokens")
    : sumField(records, "input_tokens");
  const output = sumField(records, "output_tokens");
  const cached = provider === "anthropic"
    ? sumField(records, "cache_read_input_tokens", "cache_creation_input_tokens")
    : sumField(records, "input_cached_tokens", "cached_input_tokens");

  return { input, output, cached, total: input + output + cached };
}

function parseCost(payload: unknown): number | undefined {
  const records = resultRecords(payload);
  let found = false;
  const total = records.reduce((sum, record) => {
    const amount = asRecord(record.amount);
    const value = amount?.value ?? record.value;
    if (typeof value !== "number" || !Number.isFinite(value)) return sum;
    found = true;
    return sum + value;
  }, 0);
  return found ? total : undefined;
}

function authHeaders(provider: ProviderId, auth: AuthResult): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(auth.auth.headers ?? {})) {
    if (typeof value === "string") headers[key] = value;
  }

  if (provider === "anthropic") {
    headers["anthropic-version"] ??= "2023-06-01";
    if (auth.auth.apiKey && !headers["x-api-key"] && !headers.authorization) {
      headers["x-api-key"] = auth.auth.apiKey;
    }
  } else if (auth.auth.apiKey && !headers.authorization) {
    headers.authorization = `Bearer ${auth.auth.apiKey}`;
  }

  return headers;
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(url, { headers, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function query(params: Record<string, string | number>): string {
  return new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)]),
  ).toString();
}

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

async function fetchOpenAI(
  auth: AuthResult,
  period: UsagePeriod,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ProviderPeriodUsage> {
  const common = query({
    start_time: seconds(period.from),
    end_time: seconds(period.to),
    bucket_width: "1d",
    limit: 31,
  });
  const headers = authHeaders("openai", auth);
  const [usageResult, costResult] = await Promise.allSettled([
    getJson(`https://api.openai.com/v1/organization/usage/completions?${common}`, headers, fetchImpl, signal),
    getJson(`https://api.openai.com/v1/organization/costs?${common}`, headers, fetchImpl, signal),
  ]);
  const usage = usageResult.status === "fulfilled" ? usageResult.value : undefined;
  const cost = costResult.status === "fulfilled" ? costResult.value : undefined;
  if (!usage && !cost) return { period: period.label, status: "unavailable", message: "data tidak tersedia" };

  const totals = parseTokenTotals(usage, "openai");
  const parsedCost = parseCost(cost);
  return {
    period: period.label,
    status: "ok",
    totals: parsedCost === undefined ? totals : { ...totals, cost: parsedCost },
    message: cost ? undefined : "usage tersedia, biaya tidak tersedia",
  };
}

async function fetchAnthropic(
  auth: AuthResult,
  period: UsagePeriod,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ProviderPeriodUsage> {
  const common = query({
    starting_at: period.from.toISOString(),
    ending_at: period.to.toISOString(),
    bucket_width: "1d",
    limit: 31,
  });
  const headers = authHeaders("anthropic", auth);
  const [usageResult, costResult] = await Promise.allSettled([
    getJson(`https://api.anthropic.com/v1/organizations/usage_report/messages?${common}`, headers, fetchImpl, signal),
    getJson(`https://api.anthropic.com/v1/organizations/cost_report?${common}`, headers, fetchImpl, signal),
  ]);
  const usage = usageResult.status === "fulfilled" ? usageResult.value : undefined;
  const cost = costResult.status === "fulfilled" ? costResult.value : undefined;
  if (!usage && !cost) return { period: period.label, status: "unavailable", message: "data tidak tersedia" };

  const totals = parseTokenTotals(usage, "anthropic");
  const parsedCost = parseCost(cost);
  return {
    period: period.label,
    status: "ok",
    totals: parsedCost === undefined ? totals : { ...totals, cost: parsedCost },
    message: cost ? undefined : "usage tersedia, biaya tidak tersedia",
  };
}

function decodeJwtPayload(token: string): JsonRecord | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    return asRecord(JSON.parse(atob(padded)));
  } catch {
    return undefined;
  }
}

function codexAccountId(auth: AuthResult): string | undefined {
  const configured = Object.entries(auth.auth.headers ?? {}).find(
    ([key, value]) => key.toLowerCase() === "chatgpt-account-id" && typeof value === "string",
  )?.[1];
  if (typeof configured === "string" && configured.length > 0) return configured;

  const token = auth.auth.apiKey;
  if (!token) return undefined;
  const payload = decodeJwtPayload(token);
  const authClaim = asRecord(payload?.["https://api.openai.com/auth"]);
  return typeof authClaim?.chatgpt_account_id === "string"
    ? authClaim.chatgpt_account_id
    : undefined;
}

function formatWindowLabel(secondsValue: number | undefined): string {
  if (!secondsValue || secondsValue <= 0) return "Usage window";
  const minutes = Math.round(secondsValue / 60);
  if (minutes % (60 * 24 * 7) === 0) return `${minutes / (60 * 24 * 7)} hari`;
  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)} hari`;
  if (minutes % 60 === 0) return `${minutes / 60} jam`;
  return `${minutes} menit`;
}

function parseCodexLimits(payload: unknown): UsageLimit[] {
  const root = asRecord(payload);
  if (!root) return [];

  const limits: UsageLimit[] = [];
  const addWindow = (value: unknown, fallbackLabel: string): void => {
    const window = asRecord(value);
    const usedPercent = window ? finiteNumber(window.used_percent) : undefined;
    if (usedPercent === undefined || usedPercent < 0 || usedPercent > 100) return;
    const limitWindowSeconds = finiteNumber(window?.limit_window_seconds);
    const resetValue = finiteNumber(window?.reset_at) ?? 0;
    limits.push({
      label: limitWindowSeconds ? formatWindowLabel(limitWindowSeconds) : fallbackLabel,
      usedPercent,
      limitWindowSeconds,
      resetsAt: resetValue > 0 ? new Date(resetValue * 1000) : undefined,
    });
  };

  const addWindows = (value: unknown, fallbackLabel: string): void => {
    const record = asRecord(value);
    if (!record) return;
    if (record.used_percent !== undefined) {
      addWindow(record, fallbackLabel);
      return;
    }
    for (const [key, nested] of Object.entries(record)) {
      addWindow(nested, key.replaceAll("_", " "));
    }
  };

  addWindows(root.rate_limit, "session");
  addWindows(root.additional_rate_limits, "additional");
  return limits;
}

async function fetchCodex(
  auth: AuthResult,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ limits: readonly UsageLimit[]; quota?: string }> {
  const token = auth.auth.apiKey;
  const accountId = codexAccountId(auth);
  if (!token || !accountId) throw new Error("Codex OAuth metadata tidak tersedia");

  const headers = authHeaders("openai-codex", auth);
  headers["chatgpt-account-id"] = accountId;
  headers.originator ??= "pi";
  const payload = await getJson(
    "https://chatgpt.com/backend-api/wham/usage",
    headers,
    fetchImpl,
    signal,
  );
  const limits = parseCodexLimits(payload);
  if (limits.length === 0) throw new Error("Codex usage window tidak tersedia");
  const planType = asRecord(payload)?.plan_type;
  return { limits, quota: typeof planType === "string" ? planType : undefined };
}

function extractBearerToken(auth: AuthResult): string | undefined {
  if (auth.auth.apiKey) {
    try {
      const parsed = JSON.parse(auth.auth.apiKey) as Record<string, unknown>;
      if (typeof parsed?.token === "string" && parsed.token) return parsed.token;
    } catch {
      // bukan JSON
    }
    return auth.auth.apiKey;
  }
  const authHeader = auth.auth.headers?.authorization || auth.auth.headers?.Authorization;
  if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  return undefined;
}

function extractAntigravityToken(auth: AuthResult): { token: string; projectId?: string } | undefined {
  if (auth.auth.apiKey) {
    try {
      const parsed = JSON.parse(auth.auth.apiKey) as Record<string, unknown>;
      if (typeof parsed?.token === "string" && parsed.token) {
        return {
          token: parsed.token,
          projectId: typeof parsed.projectId === "string" ? parsed.projectId : undefined,
        };
      }
    } catch {
      return { token: auth.auth.apiKey };
    }
  }
  const bearer = extractBearerToken(auth);
  if (bearer) return { token: bearer };
  return undefined;
}

function fallbackAuth(provider: ProviderId): AuthResult | undefined {
  try {
    const authFile = join(homedir(), ".pi", "agent", "auth.json");
    if (!existsSync(authFile)) return undefined;
    const authData = JSON.parse(readFileSync(authFile, "utf8")) as Record<string, unknown>;
    const entry = asRecord(authData[provider]);
    if (!entry) return undefined;

    if (provider === "antigravity" && typeof entry.access === "string") {
      return {
        auth: {
          apiKey: JSON.stringify({
            token: entry.access,
            projectId: entry.projectId,
          }),
        },
        source: "auth.json (oauth)",
      };
    }

    if (provider === "anthropic" && typeof entry.access === "string") {
      return {
        auth: {
          apiKey: entry.access,
          headers: {
            authorization: `Bearer ${entry.access}`,
          },
        },
        source: "auth.json (oauth)",
      };
    }
  } catch {
    // abaikan jika file tidak terbaca
  }
  return undefined;
}

async function fetchAntigravity(
  auth: AuthResult,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ limits: readonly UsageLimit[]; quota?: string }> {
  const creds = extractAntigravityToken(auth);
  if (!creds?.token) throw new Error("Kredensial Antigravity tidak tersedia");

  const headers = {
    Authorization: `Bearer ${creds.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent":
      "antigravity/cli/1.2.4 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)",
  };

  const limits: UsageLimit[] = [];
  let planName: string | undefined;

  // 1. Ambil quota summary pools (Gemini & Claude/GPT)
  try {
    const summaryRes = await fetchImpl(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      {
        method: "POST",
        headers,
        body: JSON.stringify({}),
        signal,
      },
    );
    if (summaryRes.ok) {
      const summaryData = asRecord(await summaryRes.json());
      const groups = Array.isArray(summaryData?.groups) ? summaryData.groups : [];
      for (const group of groups) {
        const groupRecord = asRecord(group);
        if (!groupRecord) continue;
        const groupName = String(groupRecord.displayName || "Quota");
        const buckets = Array.isArray(groupRecord.buckets) ? groupRecord.buckets : [];
        for (const bucket of buckets) {
          const b = asRecord(bucket);
          if (!b) continue;
          const remainingFraction = finiteNumber(b.remainingFraction);
          if (remainingFraction === undefined) continue;
          const usedPercent = Math.max(0, Math.min(100, Math.round((1 - remainingFraction) * 100)));
          const resetTime = typeof b.resetTime === "string" ? new Date(b.resetTime) : undefined;
          const window = typeof b.window === "string" ? b.window : "";
          const bucketName = String(b.displayName || "");

          let label = "";
          const isGemini = groupName.toLowerCase().includes("gemini");
          const prefix = isGemini ? "Gemini" : "Claude/GPT";
          if (window === "5h" || bucketName.toLowerCase().includes("five hour")) {
            label = `${prefix} 5h`;
          } else if (window === "weekly" || bucketName.toLowerCase().includes("weekly")) {
            label = `${prefix} weekly`;
          } else {
            label = `${prefix} ${bucketName || window}`;
          }

          limits.push({
            label,
            usedPercent,
            resetsAt: resetTime && Number.isFinite(resetTime.getTime()) ? resetTime : undefined,
          });
        }
      }
    }
  } catch {
    // lanjut ke fallback berikutnya
  }

  // 2. Ambil tier/plan dari loadCodeAssist
  try {
    const assistRes = await fetchImpl(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
        }),
        signal,
      },
    );
    if (assistRes.ok) {
      const assistData = asRecord(await assistRes.json());
      const paidTier = asRecord(assistData?.paidTier);
      const currentTier = asRecord(assistData?.currentTier);
      planName = (typeof paidTier?.name === "string" && paidTier.name)
        ? paidTier.name
        : (typeof currentTier?.name === "string" && currentTier.name)
          ? currentTier.name
          : undefined;
    }
  } catch {
    // abaikan jika gagal
  }

  // 3. Fallback: jika retrieveUserQuotaSummary tidak ada, coba fetchAvailableModels
  if (limits.length === 0 && creds.projectId) {
    try {
      const modelsRes = await fetchImpl(
        "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ project: creds.projectId }),
          signal,
        },
      );
      if (modelsRes.ok) {
        const modelsData = asRecord(await modelsRes.json());
        const models = asRecord(modelsData?.models) || {};
        for (const [modelId, info] of Object.entries(models)) {
          const m = asRecord(info);
          if (!m || m.isInternal || modelId.startsWith("chat_") || modelId.startsWith("tab_")) continue;
          const qi = asRecord(m.quotaInfo);
          if (!qi) continue;
          const remainingFraction = finiteNumber(qi.remainingFraction);
          if (remainingFraction === undefined) continue;
          const usedPercent = Math.max(0, Math.min(100, Math.round((1 - remainingFraction) * 100)));
          const resetTime = typeof qi.resetTime === "string" ? new Date(qi.resetTime) : undefined;
          limits.push({
            label: typeof m.displayName === "string" ? m.displayName : modelId,
            usedPercent,
            resetsAt: resetTime && Number.isFinite(resetTime.getTime()) ? resetTime : undefined,
          });
        }
      }
    } catch {
      // abaikan jika gagal
    }
  }

  if (limits.length === 0) {
    throw new Error("Antigravity usage window tidak tersedia");
  }

  return { limits, quota: planName ?? "Google Antigravity" };
}

async function fetchAnthropicOAuth(
  token: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ limits: readonly UsageLimit[]; quota?: string }> {
  const headers = {
    Authorization: `Bearer ${token}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
    Accept: "application/json",
  };
  const payload = await getJson(
    "https://api.anthropic.com/api/oauth/usage",
    headers,
    fetchImpl,
    signal,
  );
  const { windows, extraUsageEnabled } = parseOAuthUsagePayload(payload);
  const limits = windowsToLimits(windows);
  if (limits.length === 0) throw new Error("Anthropic OAuth usage window tidak tersedia");
  return { limits, quota: extraUsageEnabled ? "Claude Pro / Team (Extra Usage aktif)" : "Claude Pro / Team" };
}

export async function fetchProviderUsage(
  provider: ProviderId,
  getAuth: () => Promise<AuthResult | undefined>,
  options: UsageFetchOptions = {},
): Promise<ProviderUsage> {
  const periods = createUsagePeriods(options.now);
  const unavailablePeriod = (period: UsagePeriod, message: string): ProviderPeriodUsage => ({
    period: period.label,
    status: "unavailable",
    message,
  });

  // Provider "claude" (provider-gateway) memakai placeholder apiKey; token asli
  // dibaca dari Claude CLI dan hasilnya di-cache bersama antar instance Pi.
  if (provider === "claude") {
    const claude = await getClaudeUsage({ fetchImpl: options.fetchImpl, signal: options.signal, now: options.now, maxAgeMs: options.maxAgeMs });
    const lastSeen = claude.stale && claude.updatedAt
      ? `data terakhir ${claude.updatedAt.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`
      : undefined;
    const message = [claude.message, claude.limits.length ? lastSeen : "data tidak tersedia"]
      .filter(Boolean)
      .join(" · ") || undefined;
    return {
      provider,
      source: "Claude CLI (oauth)",
      status: claude.limits.length ? "ok" : "unavailable",
      today: unavailablePeriod(periods[0], "session usage"),
      billing: unavailablePeriod(periods[1], "session usage"),
      limits: claude.limits,
      quota: claude.quota,
      message,
      updatedAt: claude.updatedAt,
      stale: claude.stale,
    };
  }

  let auth: AuthResult | undefined;
  try {
    auth ??= await getAuth();
  } catch {
    auth = undefined;
  }
  if (!auth) {
    auth = fallbackAuth(provider);
  }
  if (!auth) {
    return {
      provider,
      status: "unavailable",
      today: unavailablePeriod(periods[0], "belum login"),
      billing: unavailablePeriod(periods[1], "belum login"),
      message: "data tidak tersedia",
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  if (provider === "openai-codex") {
    try {
      const codex = await fetchCodex(auth, fetchImpl, options.signal);
      return {
        provider,
        source: auth.source,
        status: "ok",
        today: unavailablePeriod(periods[0], "session usage"),
        billing: unavailablePeriod(periods[1], "session usage"),
        limits: codex.limits,
        quota: codex.quota,
      };
    } catch {
      return {
        provider,
        source: auth.source,
        status: "unavailable",
        today: unavailablePeriod(periods[0], "data tidak tersedia"),
        billing: unavailablePeriod(periods[1], "data tidak tersedia"),
        message: "data tidak tersedia",
      };
    }
  }

  if (provider === "anthropic") {
    const bearer = extractBearerToken(auth);
    if (bearer && (auth.source?.toLowerCase().includes("oauth") || auth.auth.headers?.authorization || !auth.auth.apiKey?.startsWith("sk-ant-"))) {
      try {
        const anthropic = await fetchAnthropicOAuth(bearer, fetchImpl, options.signal);
        return {
          provider,
          source: auth.source ?? "OAuth",
          status: "ok",
          today: unavailablePeriod(periods[0], "session usage"),
          billing: unavailablePeriod(periods[1], "session usage"),
          limits: anthropic.limits,
          quota: anthropic.quota,
        };
      } catch {
        // Token OAuth tidak punya akses ke report API; jangan fallback ke sana.
        return {
          provider,
          source: auth.source ?? "OAuth",
          status: "unavailable",
          today: unavailablePeriod(periods[0], "data tidak tersedia"),
          billing: unavailablePeriod(periods[1], "data tidak tersedia"),
          message: "data tidak tersedia",
        };
      }
    }

    const [today, billing] = await Promise.all(
      periods.map((period) => fetchAnthropic(auth!, period, fetchImpl, options.signal).catch(() => unavailablePeriod(period, "data tidak tersedia"))),
    );
    return {
      provider,
      source: auth.source,
      status: today.status === "ok" || billing.status === "ok" ? "ok" : "unavailable",
      today,
      billing,
      message: today.status === "ok" || billing.status === "ok" ? undefined : "data tidak tersedia",
    };
  }

  if (provider === "antigravity") {
    try {
      const antigravity = await fetchAntigravity(auth, fetchImpl, options.signal);
      return {
        provider,
        source: auth.source ?? "OAuth",
        status: "ok",
        today: unavailablePeriod(periods[0], "session usage"),
        billing: unavailablePeriod(periods[1], "session usage"),
        limits: antigravity.limits,
        quota: antigravity.quota,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "data tidak tersedia";
      return {
        provider,
        source: auth.source,
        status: "unavailable",
        today: unavailablePeriod(periods[0], msg),
        billing: unavailablePeriod(periods[1], msg),
        message: msg,
      };
    }
  }

  if (provider !== "openai") {
    return {
      provider,
      source: auth.source,
      status: "unavailable",
      today: unavailablePeriod(periods[0], "session usage belum didukung untuk provider ini"),
      billing: unavailablePeriod(periods[1], "session usage belum didukung untuk provider ini"),
      message: "data tidak tersedia",
    };
  }

  const [today, billing] = await Promise.all(
    periods.map((period) => fetchOpenAI(auth!, period, fetchImpl, options.signal).catch(() => unavailablePeriod(period, "data tidak tersedia"))),
  );
  return {
    provider,
    source: auth.source,
    status: today.status === "ok" || billing.status === "ok" ? "ok" : "unavailable",
    today,
    billing,
    message: today.status === "ok" || billing.status === "ok" ? undefined : "data tidak tersedia",
  };
}
