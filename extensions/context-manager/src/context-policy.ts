export type CompressionMode = "preserve" | "moderate" | "compact";

export const MODERATE_CONTEXT_THRESHOLD = 30;
export const COMPACT_CONTEXT_THRESHOLD = 60;
// Preserve hanya selama context masih kecil secara absolut; di window 1M,
// 30% berarti 300k token yang tetap ditagih penuh tiap request.
export const PRESERVE_MAX_TOKENS = 20_000;
// Model dengan context window >= 500k token (mis. Gemini 1M) tergolong besar/longgar.
export const LARGE_CONTEXT_WINDOW_THRESHOLD = 500_000;

/**
 * Memeriksa apakah context window model tergolong sangat besar/longgar dan
 * penggunaannya masih di bawah ambang batas moderat (<30%).
 * Pada kondisi ini, pemangkasan prefix ditunda agar prompt cache tidak rusak.
 */
export function isLooseContextWindow(
  contextWindow?: number | null,
  percent?: number | null,
): boolean {
  if (!contextWindow || contextWindow < LARGE_CONTEXT_WINDOW_THRESHOLD) {
    return false;
  }
  return percent === null || percent === undefined || percent < MODERATE_CONTEXT_THRESHOLD;
}

/**
 * Menghitung batas simpan token (keepLimit) untuk pemangkasan output tool lama.
 * - Mengembalikan Infinity jika pemangkasan tidak perlu dilakukan (mis. context window longgar
 *   atau token aktif masih dalam batas budget).
 * - Mengembalikan batas pangkas (Math.floor(budgetTokens * watermark)) jika budget terlampaui.
 * - Fail-safe mengikat: model dengan context window kecil atau tidak diketahui tetap dipangkas
 *   secara ketat sesuai budgetTokens.
 */
export function calculatePruneKeepLimit(
  liveTokens: number,
  budgetTokens: number,
  contextWindow?: number | null,
  percent?: number | null,
  watermark: number = 0.5,
): number {
  if (isLooseContextWindow(contextWindow, percent)) {
    return Number.POSITIVE_INFINITY;
  }
  return liveTokens > budgetTokens
    ? Math.floor(budgetTokens * watermark)
    : Number.POSITIVE_INFINITY;
}

export function selectCompressionMode(
  percent: number | null | undefined,
  tokens?: number | null,
): CompressionMode {
  const smallEnough = tokens === null || tokens === undefined || tokens < PRESERVE_MAX_TOKENS;
  if (percent !== null && percent !== undefined && percent < MODERATE_CONTEXT_THRESHOLD && smallEnough) {
    return "preserve";
  }
  if (percent !== null && percent !== undefined && percent > COMPACT_CONTEXT_THRESHOLD) {
    return "compact";
  }
  return "moderate";
}

export function formatContextPercent(percent: number | null | undefined): string {
  return percent === null || percent === undefined
    ? "tidak diketahui"
    : `${percent.toFixed(0)}%`;
}
