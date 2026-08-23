import type { AuthResult } from "@earendil-works/pi-ai";

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
  readonly source?: string;
  readonly status: UsageStatus;
  readonly today: ProviderPeriodUsage;
  readonly billing: ProviderPeriodUsage;
  readonly limits?: readonly UsageLimit[];
  readonly quota?: string;
  readonly balance?: string;
  readonly message?: string;
}

export interface UsageFetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: Date;
  readonly signal?: AbortSignal;
}

type JsonRecord = Record<string, unknown>;

const PROVIDER_NAMES: Record<ProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
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

  let auth: AuthResult | undefined;
  try {
    auth = await getAuth();
  } catch {
    auth = undefined;
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

  if (provider !== "openai" && provider !== "anthropic") {
    return {
      provider,
      source: auth.source,
      status: "unavailable",
      today: unavailablePeriod(periods[0], "session usage belum didukung untuk provider ini"),
      billing: unavailablePeriod(periods[1], "session usage belum didukung untuk provider ini"),
      message: "data tidak tersedia",
    };
  }

  const fetchPeriod = provider === "openai" ? fetchOpenAI : fetchAnthropic;
  const [today, billing] = await Promise.all(
    periods.map((period) => fetchPeriod(auth!, period, fetchImpl, options.signal).catch(() => unavailablePeriod(period, "data tidak tersedia"))),
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
