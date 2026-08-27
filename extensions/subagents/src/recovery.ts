/** Bounded retry policy for failed subagent jobs. */

import type { SubagentMetrics, SubagentSnapshot } from "./domain.ts";

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
};

export function retryDelay(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
) {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
}

export function canRetry(
  snap: {
    readonly status: SubagentSnapshot["status"];
    readonly metrics: Pick<SubagentMetrics, "restartCount">;
  },
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
) {
  return (
    snap.status === "failed" && snap.metrics.restartCount < policy.maxAttempts
  );
}
