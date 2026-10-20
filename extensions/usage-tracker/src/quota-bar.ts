import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ProviderUsage, UsageLimit } from "./providers.ts";

export interface QuotaModelRef {
  readonly provider: string;
  readonly id: string;
}

export interface MatchedQuota {
  readonly usage: ProviderUsage;
  readonly limit: UsageLimit;
}

function headerValue(
  headers: Readonly<Record<string, string>>,
  ...names: string[]
): string | undefined {
  const normalized = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  for (const name of names) {
    const value = normalized.get(name.toLowerCase());
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
}

function headerNumber(
  headers: Readonly<Record<string, string>>,
  ...names: string[]
): number | undefined {
  const value = Number(headerValue(headers, ...names));
  return Number.isFinite(value) ? value : undefined;
}

function parseResetDuration(value: string | undefined, now: Date): Date | undefined {
  if (!value) return undefined;
  const matches = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi)];
  if (matches.length === 0) return undefined;

  const milliseconds = matches.reduce((total, match) => {
    const amount = Number(match[1]);
    const unit = match[2]?.toLowerCase();
    const multiplier = unit === "ms"
      ? 1
      : unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
    return total + amount * multiplier;
  }, 0);
  return Number.isFinite(milliseconds) ? new Date(now.getTime() + milliseconds) : undefined;
}

/**
 * Read the common token rate-limit headers used by OpenAI-compatible APIs.
 * Providers without both a token limit and remaining value are ignored.
 */
export function parseStandardQuotaHeaders(
  provider: string,
  headers: Readonly<Record<string, string>>,
  now = new Date(),
): MatchedQuota | undefined {
  const limit = headerNumber(
    headers,
    "x-ratelimit-limit-tokens",
    "ratelimit-limit-tokens",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-input-tokens-limit",
  );
  const remaining = headerNumber(
    headers,
    "x-ratelimit-remaining-tokens",
    "ratelimit-remaining-tokens",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-input-tokens-remaining",
  );
  if (limit === undefined || limit <= 0 || remaining === undefined) return undefined;

  const boundedRemaining = Math.max(0, Math.min(limit, remaining));
  const usedPercent = ((limit - boundedRemaining) / limit) * 100;
  const limitEntry: UsageLimit = {
    label: "token window",
    usedPercent,
    resetsAt: parseResetDuration(
      headerValue(
        headers,
        "x-ratelimit-reset-tokens",
        "ratelimit-reset-tokens",
        "anthropic-ratelimit-tokens-reset",
        "anthropic-ratelimit-input-tokens-reset",
      ),
      now,
    ),
  };
  const unavailable = (period: "today" | "billing") => ({
    period,
    status: "unavailable" as const,
    message: "response header quota",
  });
  const usage: ProviderUsage = {
    provider,
    source: "response headers",
    status: "ok",
    today: unavailable("today"),
    billing: unavailable("billing"),
    limits: [limitEntry],
  };
  return { usage, limit: limitEntry };
}

/**
 * Alias prefix model router -> provider upstream yang dipakai sumber kuota.
 * 9Router memakai aliasnya sendiri; Zenith memakai alias pertama dari
 * registry-nya (`zenith-router/src/providers/registry/*.js`), mis.
 * `cx/gpt-6.1-sol` -> provider `codex`.
 */
const ROUTER_PREFIX_ALIASES: Record<string, Record<string, string>> = {
  "9router": {
    ag: "antigravity",
    oc: "opencode",
    ollama: "ollama",
    openrouter: "openrouter",
    gemini: "gemini",
  },
  zenith: {
    ag: "antigravity",
    bzl: "bazaarlink",
    cc: "claude",
    cf: "cloudflare-ai",
    cl: "cline",
    cmc: "commandcode",
    copilot: "github",
    cx: "codex",
    fb: "freebuff",
    gh: "github",
    kc: "kilocode",
    kr: "kiro",
    l7: "llm7",
    mis: "mistral",
    mistralai: "mistral",
    nv: "nvidia",
    ol: "ollama",
    "ollama-cloud": "ollama",
    or: "openrouter",
    ovh: "ovhcloud",
    tg: "together",
    xkr: "xkiro",
    zai: "glm",
  },
};

/** ID transport router -> kunci tabel alias; id auth lama dinormalkan. */
const ROUTER_TRANSPORT_ALIASES: Record<string, string> = {
  "9router": "9router",
  zenith: "zenith",
  zenroute: "zenith",
};

/**
 * Resolve a provider-level quota name for the active Pi model. Router model ids
 * are prefixed with the upstream alias, e.g. `ag/claude-sonnet-4-6` (9Router)
 * atau `cx/gpt-6.1-sol` (Zenith).
 */
export function quotaProviderId(model: QuotaModelRef): string {
  const transport = ROUTER_TRANSPORT_ALIASES[model.provider];
  if (!transport) return model.provider;
  const separator = model.id.indexOf("/");
  if (separator <= 0) return model.provider;
  const prefix = model.id.slice(0, separator).toLowerCase();
  return ROUTER_PREFIX_ALIASES[transport]?.[prefix] ?? prefix;
}

function normalizeModelName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * For router connections like Antigravity where quota limits are keyed per
 * model (e.g. `claude-sonnet-4-6`), prioritize the matching model limit.
 */
export function findMatchingLimit(
  model: QuotaModelRef,
  usage: ProviderUsage,
): UsageLimit | undefined {
  if (!usage.limits || usage.limits.length === 0) return undefined;

  const modelBare = model.id.includes("/")
    ? model.id.slice(model.id.indexOf("/") + 1)
    : model.id;
  const normBare = normalizeModelName(modelBare);

  // Exact or normalized match
  const exactMatch = usage.limits.find(
    (l) => l.label === modelBare || normalizeModelName(l.label) === normBare,
  );
  if (exactMatch) return exactMatch;

  // Substring match
  const subMatch = usage.limits.find((l) => {
    const normLimit = normalizeModelName(l.label);
    return normLimit.length > 3 && (normBare.includes(normLimit) || normLimit.includes(normBare));
  });
  if (subMatch) return subMatch;

  // Provider-specific group matching
  if (usage.provider === "antigravity") {
    if (normBare.includes("gemini")) {
      const geminiLimit = usage.limits.find((l) => l.label.toLowerCase().includes("gemini 5h"))
        || usage.limits.find((l) => l.label.toLowerCase().includes("gemini"));
      if (geminiLimit) return geminiLimit;
    }
    if (normBare.includes("claude") || normBare.includes("gpt")) {
      const thirdPartyLimit = usage.limits.find((l) => l.label.toLowerCase().includes("claude/gpt 5h"))
        || usage.limits.find((l) => l.label.toLowerCase().includes("claude"));
      if (thirdPartyLimit) return thirdPartyLimit;
    }
  }

  if (usage.provider === "anthropic" || usage.provider === "claude") {
    const sessionLimit = usage.limits.find((l) => l.label.toLowerCase().includes("5h"));
    if (sessionLimit) return sessionLimit;
  }

  // Fallback to highest/primary limit
  return primaryQuotaLimit(usage);
}

function bareModelId(id: string): string {
  return id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
}

/**
 * Segmen tier yang teramati pada bucket Zenith (`gemini-4-argon-low`,
 * `gemini-3.5-flash-extra-low`, `gemini-3-flash-agent`). Suffix hanya diterima
 * jika semua segmennya ada di sini. Tanpa daftar ini, `gemini-3.8-flash` ikut
 * menangkap `gemini-3.8-flash-lite-high`, yang merupakan model lain.
 * Tier baru yang belum ada di sini tidak menghasilkan bar, tetapi tetap tampil
 * di dashboard. Tambahkan segmennya di sini setelah dipastikan.
 */
const TIER_TOKENS: ReadonlySet<string> = new Set(["extra", "low", "medium", "high", "thinking", "agent"]);

/**
 * Peringkat kecocokan bucket per model; angka lebih kecil lebih spesifik.
 * 0: key sama dengan id model (`gemini-4-argon`).
 * 1: key berupa id model dengan suffix tier yang dikenali (`gemini-4-argon-low`).
 * Label tampilan sengaja tidak dipakai: satu key bisa punya nama yang tidak
 * sesuai dengan model induknya.
 */
function bucketRank(model: QuotaModelRef, limit: UsageLimit): number | undefined {
  if (!limit.key) return undefined;
  const bare = bareModelId(model.id).toLowerCase();
  const key = limit.key.toLowerCase();
  if (key === bare) return 0;
  if (!key.startsWith(`${bare}-`)) return undefined;
  const tokens = key.slice(bare.length + 1).split("-");
  return tokens.every((token) => TIER_TOKENS.has(token)) ? 1 : undefined;
}

/** Segmen grup pool Antigravity (5h dan mingguan) */
function antigravityPoolMatch(modelBare: string, limit: UsageLimit): boolean {
  const normLabel = limit.label.toLowerCase();
  const isArgon = /argon/i.test(modelBare);
  if (isArgon) {
    return normLabel.includes("argon");
  }
  if (/^gemini/i.test(modelBare)) {
    return normLabel.includes("gemini") && !normLabel.includes("argon");
  }
  if (/^(claude|gpt)/i.test(modelBare)) {
    return normLabel.includes("claude") || normLabel.includes("gpt") || normLabel.includes("3p");
  }
  return false;
}

/** Hit bucket atau pool milik satu akun, dengan peringkat kecocokannya. */
interface ModelHit extends MatchedQuota {
  readonly rank: number;
}

/** Pool grup 5 jam (rank 2) atau mingguan (rank 3). */
function poolRank(limit: UsageLimit): number {
  const is5h = /5\s*h|5\s*jam/i.test(limit.label) || limit.key?.includes("5h");
  return is5h ? 2 : 3;
}

/**
 * Pool grup yang habis dan reset-nya belum lewat. Sama seperti
 * `isAntigravityPoolExhausted` di Zenith: pool dengan reset yang sudah lewat
 * tidak dihitung habis.
 */
function isPoolExhausted(hit: ModelHit, now: Date): boolean {
  const resetsAt = hit.limit.resetsAt;
  return (
    hit.rank >= 2 &&
    hit.limit.usedPercent >= 100 &&
    resetsAt !== undefined &&
    resetsAt.getTime() > now.getTime()
  );
}

/** Pilih hit yang lebih ketat; pada angka sama, bucket spesifik model menang. */
function tighterHit(a: ModelHit, b: ModelHit): ModelHit {
  if (a.limit.usedPercent !== b.limit.usedPercent) {
    return a.limit.usedPercent > b.limit.usedPercent ? a : b;
  }
  return a.rank <= b.rank ? a : b;
}

/**
 * Bucket per model (mis. Zenith untuk antigravity). Akun diurutkan menurut
 * prioritas Zenith, lalu akun pertama yang pool grupnya belum habis dipakai,
 * sama seperti router memilih koneksi. Bar menampilkan batas paling ketat pada
 * akun itu. Bila semua akun habis, ditampilkan pool habis dari akun prioritas
 * tertinggi.
 */
function findModelBucket(
  model: QuotaModelRef,
  usages: readonly ProviderUsage[],
  now: Date,
): MatchedQuota | undefined {
  const bare = bareModelId(model.id).toLowerCase();
  const accounts: Array<{ readonly usage: ProviderUsage; readonly hits: ModelHit[] }> = [];

  for (const usage of usages) {
    const hits: ModelHit[] = [];
    for (const limit of usage.limits ?? []) {
      const rank = bucketRank(model, limit);
      if (rank !== undefined) {
        hits.push({ usage, limit, rank });
      } else if (usage.provider === "antigravity" && limit.pool === true && antigravityPoolMatch(bare, limit)) {
        hits.push({ usage, limit, rank: poolRank(limit) });
      }
    }
    if (hits.length > 0) accounts.push({ usage, hits });
  }

  // Array.prototype.sort stabil, jadi akun tanpa prioritas mempertahankan urutan asal.
  const ordered = [...accounts].sort(
    (a, b) =>
      (a.usage.priority ?? Number.MAX_SAFE_INTEGER) - (b.usage.priority ?? Number.MAX_SAFE_INTEGER),
  );
  const first = ordered[0];
  if (!first) return undefined;

  const usable = ordered.find((account) => !account.hits.some((hit) => isPoolExhausted(hit, now)));
  if (usable) {
    const best = usable.hits.reduce(tighterHit);
    return { usage: best.usage, limit: best.limit };
  }

  const blocked = first.hits.find((hit) => isPoolExhausted(hit, now)) ?? first.hits[0];
  return blocked ? { usage: blocked.usage, limit: blocked.limit } : undefined;
}

export function findQuotaForModel(
  model: QuotaModelRef,
  usages: readonly ProviderUsage[],
  now = new Date(),
): MatchedQuota | undefined {
  const provider = quotaProviderId(model);
  const candidates = usages.filter(
    (usage) => usage.provider.toLowerCase() === provider.toLowerCase() && Boolean(usage.limits?.length),
  );

  const modelKeyed = candidates.filter((usage) => usage.perModelBuckets);
  if (modelKeyed.length > 0) return findModelBucket(model, modelKeyed, now);

  for (const candidate of candidates) {
    const limit = findMatchingLimit(model, candidate);
    if (limit) return { usage: candidate, limit };
  }

  return undefined;
}

/** Akhiran tingkat berpikir pada nama tampilan, mis. `(Low)`, `(Extra Low)`, `(Thinking)`. */
const TIER_LABEL_SUFFIX = /\s*\(\s*(?:extra\s*low|extra\s*high|minimal|low|medium|high|thinking)\s*\)\s*$/i;

/**
 * Gabungkan bucket per tingkat berpikir menjadi satu baris per keluarga model
 * (mis. `Gemini 4 Argon (Low|Medium|High)` -> `Gemini 4 Argon`). Hanya untuk
 * tampilan: `limits` asli tetap dipakai pencocokan quota rail yang butuh key
 * per runtime. Tingkat dalam satu keluarga berbagi pool yang sama sehingga
 * persentasenya identik; bila berbeda, diambil yang paling longgar (sisa
 * terbanyak) agar baris menjawab "masih bisa dipakai atau tidak". Keluarga
 * dengan satu anggota dan limit tanpa akhiran tingkat (pool 5 jam/mingguan)
 * dibiarkan apa adanya.
 */
export function groupTierLimits(limits: readonly UsageLimit[]): readonly UsageLimit[] {
  const groups = new Map<string, UsageLimit[]>();
  const order: Array<string | UsageLimit> = [];
  for (const limit of limits) {
    const family = TIER_LABEL_SUFFIX.test(limit.label) ? limit.label.replace(TIER_LABEL_SUFFIX, "").trim() : undefined;
    if (!family) {
      order.push(limit);
      continue;
    }
    const members = groups.get(family);
    if (members) members.push(limit);
    else {
      groups.set(family, [limit]);
      order.push(family);
    }
  }

  return order.map((entry) => {
    if (typeof entry !== "string") return entry;
    const members = groups.get(entry) ?? [];
    if (members.length < 2) return members[0] as UsageLimit;
    const best = members.reduce((a, b) => (b.usedPercent < a.usedPercent ? b : a));
    const resets = members.map((m) => m.resetsAt).filter((d): d is Date => d !== undefined);
    const earliest = resets.length ? new Date(Math.min(...resets.map((d) => d.getTime()))) : undefined;
    return { label: entry, key: best.key, usedPercent: best.usedPercent, resetsAt: earliest };
  });
}

/** Select the most-used window so a single compact bar is conservative. */
export function primaryQuotaLimit(
  usage: ProviderUsage,
): UsageLimit | undefined {
  return usage.limits?.reduce<UsageLimit | undefined>(
    (selected, limit) =>
      !selected || limit.usedPercent > selected.usedPercent ? limit : selected,
    undefined,
  );
}

function formatReset(resetAt: Date | undefined, now: Date): string | undefined {
  if (!resetAt || !Number.isFinite(resetAt.getTime())) return undefined;
  const remainingMs = resetAt.getTime() - now.getTime();
  if (remainingMs <= 0) return "0m";

  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  return `${minutes}m`;
}

/** Umur snapshot kuota, mis. `2h 5m`. Dipakai quota bar dan baris dashboard. */
export function quotaAge(since: Date | undefined, now: Date): string | undefined {
  if (!since || !Number.isFinite(since.getTime())) return undefined;
  const minutes = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h${minutes % 60 > 0 ? ` ${minutes % 60}m` : ""}`;
  return `${minutes}m`;
}

/**
 * Render a quota rail directly below Pi's editor separator, followed by a
 * closing rule that keeps the built-in footer visually separate.
 *
 * The top rule is intentionally omitted so it merges with the editor's own
 * bottom separator while idle.
 */
export function renderQuotaBar(
  _model: QuotaModelRef,
  matched: MatchedQuota,
  width: number,
  theme: Theme,
  now = new Date(),
  borderColor: (text: string) => string = (text) => theme.fg("borderMuted", text),
): string[] {
  const safeWidth = Math.max(1, width);
  // Use the provider returned by the quota source. For a router this is the
  // upstream provider (e.g. antigravity), not the transport name ("9router").
  const providerLabel = matched.usage.provider;
  const usedPercent = Math.max(0, Math.min(100, matched.limit.usedPercent));
  const percent = `${usedPercent.toFixed(0)}% used`;
  const reset = formatReset(matched.limit.resetsAt, now);
  const base = reset ? `${percent} · reset ${reset}` : percent;
  const age = matched.usage.stale ? quotaAge(matched.usage.updatedAt, now) : undefined;
  const suffix = age ? `${base} · stale ${age}` : base;

  // Fill every column between the provider and the quota information.
  const divider = borderColor("│");
  const overhead = visibleWidth(providerLabel) + visibleWidth(suffix) + 6;
  const barWidth = Math.max(1, safeWidth - overhead);
  const usedWidth = Math.round((usedPercent / 100) * barWidth);
  const bar = usedWidth <= 0
    ? "─".repeat(barWidth)
    : usedWidth >= barWidth
      ? "━".repeat(barWidth)
      : `${"━".repeat(usedWidth - 1)}╸${"─".repeat(barWidth - usedWidth)}`;

  const content = [
    theme.fg("text", providerLabel),
    " ",
    divider,
    " ",
    theme.fg("text", bar),
    " ",
    divider,
    " ",
    theme.fg("text", suffix),
  ].join("");

  const rule = borderColor("─".repeat(safeWidth));

  return [
    truncateToWidth(content, safeWidth),
    rule,
  ];
}
