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

function parseResetDuration(
  value: string | undefined,
  now: Date,
): Date | undefined {
  if (!value) return undefined;
  const matches = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi)];
  if (matches.length === 0) return undefined;

  const milliseconds = matches.reduce((total, match) => {
    const amount = Number(match[1]);
    const unit = match[2]?.toLowerCase();
    const multiplier =
      unit === "ms"
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
  return Number.isFinite(milliseconds)
    ? new Date(now.getTime() + milliseconds)
    : undefined;
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
  );
  const remaining = headerNumber(
    headers,
    "x-ratelimit-remaining-tokens",
    "ratelimit-remaining-tokens",
  );
  if (limit === undefined || limit <= 0 || remaining === undefined)
    return undefined;

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

const PREFIX_PROVIDER_ALIASES: Record<string, string> = {
  ag: "antigravity",
  oc: "opencode",
  ollama: "ollama",
  openrouter: "openrouter",
  gemini: "gemini",
};

/**
 * Resolve a provider-level quota name for the active Pi model.
 * 9Router model ids are prefixed with the upstream alias, e.g.
 * `ag/claude-sonnet-4-6` or `ollama/gpt-oss:120b`.
 */
export function quotaProviderId(model: QuotaModelRef): string {
  if (model.provider !== "9router") return model.provider;
  const separator = model.id.indexOf("/");
  if (separator <= 0) return model.provider;
  const prefix = model.id.slice(0, separator).toLowerCase();
  return PREFIX_PROVIDER_ALIASES[prefix] ?? prefix;
}

function normalizeModelName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * For 9Router connections like Antigravity where quota limits are keyed per
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
    return (
      normLimit.length > 3 &&
      (normBare.includes(normLimit) || normLimit.includes(normBare))
    );
  });
  if (subMatch) return subMatch;

  // Fallback to highest/primary limit
  return primaryQuotaLimit(usage);
}

export function findQuotaForModel(
  model: QuotaModelRef,
  usages: readonly ProviderUsage[],
): MatchedQuota | undefined {
  const provider = quotaProviderId(model);
  const candidates = usages.filter(
    (usage) =>
      usage.provider.toLowerCase() === provider.toLowerCase() &&
      Boolean(usage.limits?.length),
  );

  for (const candidate of candidates) {
    const limit = findMatchingLimit(model, candidate);
    if (limit) return { usage: candidate, limit };
  }

  return undefined;
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

/**
 * Render a quota rail directly below Pi's editor separator, followed by a
 * closing rule that keeps the built-in footer visually separate.
 */
export function renderQuotaBar(
  _model: QuotaModelRef,
  matched: MatchedQuota,
  width: number,
  theme: Theme,
  now = new Date(),
  borderColor: (text: string) => string = (text) =>
    theme.fg("borderMuted", text),
): string[] {
  const safeWidth = Math.max(1, width);
  // Use the provider returned by the quota source. For 9Router this is the
  // upstream provider (e.g. antigravity), not the transport name "9router".
  const providerLabel = matched.usage.provider;
  const usedPercent = Math.max(0, Math.min(100, matched.limit.usedPercent));
  const percent = `${usedPercent.toFixed(0)}% used`;
  const reset = formatReset(matched.limit.resetsAt, now);
  const suffix = reset ? `${percent} · reset ${reset}` : percent;

  // Fill every column between the provider and the quota information.
  const divider = borderColor("│");
  const overhead = visibleWidth(providerLabel) + visibleWidth(suffix) + 6;
  const barWidth = Math.max(1, safeWidth - overhead);
  const usedWidth = Math.round((usedPercent / 100) * barWidth);
  const bar =
    usedWidth <= 0
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

  return [truncateToWidth(content, safeWidth), rule];
}
