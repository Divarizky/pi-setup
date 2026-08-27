export type CompressionMode = "preserve" | "moderate" | "compact";

export const MODERATE_CONTEXT_THRESHOLD = 30;
export const COMPACT_CONTEXT_THRESHOLD = 60;

export function selectCompressionMode(
  percent: number | null | undefined,
): CompressionMode {
  if (
    percent !== null &&
    percent !== undefined &&
    percent < MODERATE_CONTEXT_THRESHOLD
  ) {
    return "preserve";
  }
  if (
    percent !== null &&
    percent !== undefined &&
    percent > COMPACT_CONTEXT_THRESHOLD
  ) {
    return "compact";
  }
  return "moderate";
}

export function formatContextPercent(
  percent: number | null | undefined,
): string {
  return percent === null || percent === undefined
    ? "tidak diketahui"
    : `${percent.toFixed(0)}%`;
}
