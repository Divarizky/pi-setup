/** Bounded retry for transient durable filesystem writes. */

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 50;
const DEFAULT_MAX_DELAY_MS = 500;

export interface DurableWriteOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withDurableWrite<T>(
  operation: () => Promise<T>,
  options: DurableWriteOptions = {},
): Promise<T> {
  const attempts = Math.max(
    1,
    Math.trunc(options.attempts ?? DEFAULT_ATTEMPTS),
  );
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = Math.max(
    baseDelayMs,
    options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
  );
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
      await delay(Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}
