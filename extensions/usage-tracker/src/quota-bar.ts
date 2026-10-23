import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ProviderUsage, ServedAccount, UsageLimit } from "./providers.ts";

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
    antigravity: "antigravity",
    oc: "opencode",
    opencode: "opencode",
    ollama: "ollama",
    openrouter: "openrouter",
    gemini: "gemini",
    claude: "claude",
    cc: "claude",
    anthropic: "claude",
    codex: "codex",
    cx: "codex",
    github: "github",
    copilot: "github",
    gh: "github",
  },
  zenith: {
    ag: "antigravity",
    antigravity: "antigravity",
    bzl: "bazaarlink",
    bazaarlink: "bazaarlink",
    cc: "claude",
    claude: "claude",
    anthropic: "claude",
    cf: "cloudflare-ai",
    "cloudflare-ai": "cloudflare-ai",
    cl: "cline",
    cline: "cline",
    cmc: "commandcode",
    commandcode: "commandcode",
    copilot: "github",
    cx: "codex",
    codex: "codex",
    fb: "freebuff",
    freebuff: "freebuff",
    gh: "github",
    github: "github",
    kc: "kilocode",
    kilocode: "kilocode",
    kr: "kiro",
    kiro: "kiro",
    l7: "llm7",
    llm7: "llm7",
    mis: "mistral",
    mistral: "mistral",
    mistralai: "mistral",
    nv: "nvidia",
    nvidia: "nvidia",
    ol: "ollama",
    ollama: "ollama",
    "ollama-cloud": "ollama",
    or: "openrouter",
    openrouter: "openrouter",
    ovh: "ovhcloud",
    ovhcloud: "ovhcloud",
    tg: "together",
    together: "together",
    xkr: "xkiro",
    xkiro: "xkiro",
    zai: "glm",
    glm: "glm",
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

export function bareModelId(id: string): string {
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
 * Router mengunci satu model per akun saat rate limit. Pencocokannya persis
 * seperti di Zenith: lock disimpan dan dicek dengan string model yang diminta,
 * bukan keluarga atau tier-nya. Lock `gemini-3.8-flash-high` tidak menutupi
 * `gemini-3.8-flash`, dan sebaliknya.
 */
function isAccountLockedForModel(usage: ProviderUsage, bareModel: string, now: Date): boolean {
  return (usage.lockedModels ?? []).some(
    (lock) => lock.lockedUntil > now.getTime() && lock.model.toLowerCase() === bareModel,
  );
}

/**
 * Sisa kuota model dari inventory router. Inventory menyimpan tier yang
 * dipakai akun itu sendiri, jadi nilainya bisa lebih tajam daripada
 * persentase agregat pada `quotas`.
 */
function inventoryRemaining(
  usage: ProviderUsage,
  bareModel: string,
): { readonly remaining: number; readonly resetsAt?: number } | undefined {
  const entries = usage.modelInventory;
  if (!entries || entries.length === 0) return undefined;
  const candidates = entries.filter((entry) => {
    const model = entry.model.toLowerCase();
    return model === bareModel || model.startsWith(`${bareModel}-`) || bareModel.startsWith(`${model}-`);
  });
  if (candidates.length === 0) return undefined;
  // Sisa kuota terkecil adalah yang paling menentukan: tier yang dipakai
  // request adalah tier dengan sisa terkecil.
  let best: (typeof candidates)[number] | undefined;
  for (const candidate of candidates) {
    if (candidate.remaining === undefined) continue;
    if (!best || best.remaining === undefined || candidate.remaining < best.remaining) {
      best = candidate;
    }
  }
  if (!best || best.remaining === undefined) return undefined;
  return { remaining: best.remaining, resetsAt: best.resetsAt };
}

/**
 * Limit (baik pool maupun bucket model) yang habis dan reset-nya belum lewat.
 * Bila resetsAt tidak ada (mis. kredit 0 habis), limit dianggap habis.
 * Sama seperti router Zenith: limit dengan reset yang sudah lewat tidak
 * dihitung habis karena akan segera diisi ulang / sinkronisasi berikutnya.
 */
function isLimitExhausted(limit: UsageLimit, now: Date): boolean {
  if (limit.usedPercent < 100) return false;
  if (!limit.resetsAt) return true;
  return limit.resetsAt.getTime() > now.getTime();
}

function isHitExhausted(hit: ModelHit, now: Date, usage?: ProviderUsage, bareModel?: string): boolean {
  // Inventory router adalah sumber yang lebih tepat: di sana sisa kuota model
  // dihitung per tier yang benar-benar dipakai, bukan per agregat keluarga.
  if (usage && bareModel && hit.rank <= 1) {
    const inventory = inventoryRemaining(usage, bareModel);
    if (inventory && inventory.remaining === 0) {
      if (inventory.resetsAt === undefined) return true;
      return inventory.resetsAt > now.getTime();
    }
  }
  return isLimitExhausted(hit.limit, now);
}

/**
 * Akun umum (non-modelKeyed) dianggap habis bila statusnya unavailable
 * atau memiliki jendela kuota yang sedang exhausted.
 */
function isAccountExhaustedGeneral(usage: ProviderUsage, now: Date): boolean {
  if (usage.status === "unavailable") return true;
  const limits = usage.limits ?? [];
  return limits.some((limit) => isLimitExhausted(limit, now));
}

/**
 * Akun dianggap habis untuk model ini jika:
 * 1. Pool grup modelnya (5h atau mingguan) habis.
 * 2. ATAU akun memiliki bucket model dan seluruh bucket model yang cocok sudah habis.
 */
function isAccountExhausted(
  hits: readonly ModelHit[],
  now: Date,
  usage?: ProviderUsage,
  bareModel?: string,
): boolean {
  if (hits.some((hit) => hit.rank >= 2 && isHitExhausted(hit, now, usage, bareModel))) return true;
  const modelHits = hits.filter((hit) => hit.rank <= 1);
  if (modelHits.length > 0 && modelHits.every((hit) => isHitExhausted(hit, now, usage, bareModel))) return true;
  return false;
}

/** Pilih hit yang lebih ketat; pada angka sama, bucket spesifik model menang. */
function tighterHit(a: ModelHit, b: ModelHit): ModelHit {
  if (a.limit.usedPercent !== b.limit.usedPercent) {
    return a.limit.usedPercent > b.limit.usedPercent ? a : b;
  }
  return a.rank <= b.rank ? a : b;
}

/** Akun yang sedang cooldown setelah error berulang tidak dipilih router. */
function isAccountCoolingDown(usage: ProviderUsage, now: Date): boolean {
  return usage.cooldownUntil !== undefined && usage.cooldownUntil > now.getTime();
}

/**
 * Akun yang boleh dipilih router untuk model ini: tidak terkunci untuk model
 * tersebut, tidak sedang cooldown, dan tidak ditandai habis oleh router.
 */
function isAccountRoutable(usage: ProviderUsage, bareModel: string, now: Date): boolean {
  return (
    !isAccountLockedForModel(usage, bareModel, now) &&
    !isAccountCoolingDown(usage, now) &&
    usage.isExhausted !== true
  );
}

/**
 * Hit bucket dan pool milik satu akun untuk model ini. Mengembalikan undefined
 * bila akun tidak melayani model ini.
 */
function collectAccountHits(usage: ProviderUsage, model: QuotaModelRef, bareModel: string): ModelHit[] | undefined {
  const limits = usage.limits ?? [];
  const hits: ModelHit[] = [];
  for (const limit of limits) {
    const rank = bucketRank(model, limit);
    if (rank !== undefined) {
      hits.push({ usage, limit, rank });
    } else if (usage.provider === "antigravity" && limit.pool === true && antigravityPoolMatch(bareModel, limit)) {
      hits.push({ usage, limit, rank: poolRank(limit) });
    }
  }
  // Akun yang memiliki data bucket model wajib punya bucket yang cocok dengan model ini.
  const hasModelBuckets = limits.some((limit) => !limit.pool);
  if (hasModelBuckets && !hits.some((hit) => hit.rank <= 1)) return undefined;
  return hits.length > 0 ? hits : undefined;
}

/** Urutan router: priority terkecil lebih dulu, lalu id koneksi terkecil. */
function compareRouterOrder(a: ProviderUsage, b: ProviderUsage): number {
  const byPriority = (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER);
  if (byPriority !== 0) return byPriority;
  return (a.connectionId ?? Number.MAX_SAFE_INTEGER) - (b.connectionId ?? Number.MAX_SAFE_INTEGER);
}

/** Batas paling ketat yang belum habis pada satu akun. */
function strictestHit(hits: readonly ModelHit[], now: Date, usage: ProviderUsage, bareModel: string): MatchedQuota {
  const open = hits.filter((hit) => !isHitExhausted(hit, now, usage, bareModel));
  const pool = open.length > 0 ? open : hits;
  const best = pool.reduce(tighterHit);
  return { usage, limit: best.limit };
}

/** Akun yang melayani request terakhir, dicocokkan lewat id koneksi atau nama akun. */
function findServedUsage(served: ServedAccount, usages: readonly ProviderUsage[]): ProviderUsage | undefined {
  if (served.connectionId !== undefined) {
    return usages.find((usage) => usage.connectionId === served.connectionId);
  }
  return usages.find((usage) => usage.accountName !== undefined && usage.accountName === served.accountName);
}

/**
 * Bucket per model (mis. Zenith untuk antigravity). Akun yang melayani request
 * terakhir (`served`) ditampilkan selama masih bisa dipilih router. Jika tidak,
 * akun dipilih dengan urutan router: priority lalu id, melewati akun yang
 * terkunci, cooldown, atau habis. Bar menampilkan batas paling ketat pada akun
 * itu. Bila semua akun habis, ditampilkan limit habis dari akun prioritas tertinggi.
 */
export function findModelBucket(
  model: QuotaModelRef,
  usages: readonly ProviderUsage[],
  now: Date,
  served?: ServedAccount,
): MatchedQuota | undefined {
  const bare = bareModelId(model.id).toLowerCase();

  const servedUsage = served ? findServedUsage(served, usages) : undefined;
  if (servedUsage && isAccountRoutable(servedUsage, bare, now)) {
    const hits = collectAccountHits(servedUsage, model, bare);
    if (hits && !isAccountExhausted(hits, now, servedUsage, bare)) {
      return strictestHit(hits, now, servedUsage, bare);
    }
  }

  const candidates = usages.flatMap((usage) => {
    const hits = collectAccountHits(usage, model, bare);
    return hits ? [{ usage, hits }] : [];
  });
  const byRouter = [...candidates].sort((a, b) => compareRouterOrder(a.usage, b.usage));
  // Jika tidak ada akun yang bisa dipilih, tampilkan akun prioritas tertinggi
  // supaya limit yang menghentikan request tetap terlihat.
  const routable = byRouter.filter((candidate) => isAccountRoutable(candidate.usage, bare, now));
  const ordered = routable.length > 0 ? routable : byRouter;
  const first = ordered[0];
  if (!first) return undefined;

  const usable = ordered.find((candidate) => !isAccountExhausted(candidate.hits, now, candidate.usage, bare));
  if (usable) return strictestHit(usable.hits, now, usable.usage, bare);

  const blocked = first.hits.find((hit) => isHitExhausted(hit, now, first.usage, bare)) ?? first.hits[0];
  return blocked ? { usage: blocked.usage, limit: blocked.limit } : undefined;
}

export function findQuotaForModel(
  model: QuotaModelRef,
  usages: readonly ProviderUsage[],
  now = new Date(),
  served?: ServedAccount,
): MatchedQuota | undefined {
  const provider = quotaProviderId(model).toLowerCase();
  const candidates = usages.filter((usage) => {
    const p = usage.provider.toLowerCase();
    const match =
      p === provider ||
      (provider === "claude" && p === "anthropic") ||
      (provider === "anthropic" && p === "claude");
    return match && Boolean(usage.limits?.length);
  });

  const modelKeyed = candidates.filter((usage) => usage.perModelBuckets);
  if (modelKeyed.length > 0) return findModelBucket(model, modelKeyed, now, served);

  // Urutkan seluruh akun kandidat menurut priority router (angka lebih kecil = prioritas lebih tinggi).
  // Akun tanpa prioritas diletakkan di akhir dengan mempertahankan urutan asal.
  const ordered = [...candidates].sort(
    (a, b) =>
      (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER),
  );

  // 1. Pilih akun pertama dengan prioritas tertinggi yang sehat (belum exhausted)
  // dan memiliki limit yang cocok untuk model ini.
  for (const candidate of ordered) {
    const limit = findMatchingLimit(model, candidate);
    if (!limit) continue;

    if (!isAccountExhaustedGeneral(candidate, now)) {
      return { usage: candidate, limit };
    }
  }

  // 2. Jika seluruh akun exhausted, pilih akun prioritas tertinggi yang memiliki limit cocok,
  // dan utamakan menampilkan limit yang memblokir (exhausted) pada akun tersebut.
  for (const candidate of ordered) {
    const limit = findMatchingLimit(model, candidate);
    if (!limit) continue;

    const blockedLimit = (candidate.limits ?? []).find((l) => isLimitExhausted(l, now)) ?? limit;
    return { usage: candidate, limit: blockedLimit };
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

function compactLimitLabel(label: string): string {
  return label
    .replace(/^Claude and GPT models/i, "Claude/GPT")
    .replace(/^Gemini Models/i, "Gemini")
    .replace(/^Gemini 4 Argon/i, "Argon")
    .trim();
}

function compactAccountLabel(label: string): string {
  return label.replace(/@[\w.-]+/g, "");
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
  const usedPercent = Math.max(0, Math.min(100, matched.limit.usedPercent));
  const percent = `${usedPercent.toFixed(0)}% used`;
  const reset = formatReset(matched.limit.resetsAt, now);
  const base = reset ? `${percent} · reset ${reset}` : percent;
  const age = matched.usage.stale ? quotaAge(matched.usage.updatedAt, now) : undefined;
  const suffix = age ? `${base} · stale ${age}` : base;

  const accountFull = matched.usage.label?.trim() || matched.usage.provider;
  const limitFull = matched.limit.label?.trim();

  // Susun label kiri (akun) dan kanan (limit + status pemakaian) bertingkat
  // sesuai lebar terminal agar progress rail tetap memiliki ruang visual.
  let leftLabel = accountFull;
  let rightSuffix = limitFull ? `${limitFull} · ${suffix}` : suffix;

  const minBarWidth = 8;
  const calcOverhead = (left: string, right: string) => visibleWidth(left) + visibleWidth(right) + 6;

  if (calcOverhead(leftLabel, rightSuffix) + minBarWidth > safeWidth) {
    const accountCompact = compactAccountLabel(accountFull);
    const limitCompact = limitFull ? compactLimitLabel(limitFull) : undefined;
    const rightCompact = limitCompact ? `${limitCompact} · ${suffix}` : suffix;

    if (calcOverhead(accountCompact, rightCompact) + minBarWidth <= safeWidth) {
      leftLabel = accountCompact;
      rightSuffix = rightCompact;
    } else if (calcOverhead(accountCompact, suffix) + minBarWidth <= safeWidth) {
      leftLabel = accountCompact;
      rightSuffix = suffix;
    } else if (calcOverhead(matched.usage.provider, suffix) + minBarWidth <= safeWidth) {
      leftLabel = matched.usage.provider;
      rightSuffix = suffix;
    } else {
      leftLabel = matched.usage.provider;
      rightSuffix = percent;
    }
  }

  // Fill every column between the provider and the quota information.
  const divider = borderColor("│");
  const overhead = visibleWidth(leftLabel) + visibleWidth(rightSuffix) + 6;
  const barWidth = Math.max(1, safeWidth - overhead);
  const usedWidth = Math.round((usedPercent / 100) * barWidth);
  const bar = usedWidth <= 0
    ? "─".repeat(barWidth)
    : usedWidth >= barWidth
      ? "━".repeat(barWidth)
      : `${"━".repeat(usedWidth - 1)}╸${"─".repeat(barWidth - usedWidth)}`;

  const content = [
    theme.fg("text", leftLabel),
    " ",
    divider,
    " ",
    theme.fg("text", bar),
    " ",
    divider,
    " ",
    theme.fg("text", rightSuffix),
  ].join("");

  const rule = borderColor("─".repeat(safeWidth));

  return [
    truncateToWidth(content, safeWidth),
    rule,
  ];
}
