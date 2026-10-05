export type CompressionMode = "preserve" | "moderate" | "compact";

export const MODERATE_CONTEXT_THRESHOLD = 30;
export const COMPACT_CONTEXT_THRESHOLD = 60;
// Preserve hanya selama context masih kecil secara absolut; di window 1M,
// 30% berarti 300k token yang tetap ditagih penuh tiap request.
export const PRESERVE_MAX_TOKENS = 20_000;

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
