/**
 * Logika murni detektor failure-recovery. Tidak mengakses runtime Pi,
 * sehingga seluruh keputusan dapat diuji langsung.
 */

export interface FailureState {
  lastSignature: string | null;
  sameCallStreak: number;
  errorStreak: number;
  continuationCount: number;
}

export interface FailureConfig {
  loop: { enabled: boolean; threshold: number };
  emptyStop: { enabled: boolean; maxRetries: number };
  consecutiveErrors: { enabled: boolean; threshold: number };
}

export const DEFAULT_CONFIG: FailureConfig = {
  loop: { enabled: true, threshold: 5 },
  emptyStop: { enabled: true, maxRetries: 3 },
  consecutiveErrors: { enabled: true, threshold: 3 },
};

export function createFailureState(): FailureState {
  return {
    lastSignature: null,
    sameCallStreak: 0,
    errorStreak: 0,
    continuationCount: 0,
  };
}

/** JSON dengan kunci objek terurut, agar argumen identik menghasilkan string sama. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Mencatat satu pemanggilan tool. Mengembalikan true bila panggilan ini
 * harus diblokir karena identik dengan panggilan sebelumnya sebanyak threshold kali berturut-turut.
 */
export function registerToolCall(
  state: FailureState,
  toolName: string,
  input: unknown,
  threshold: number,
): boolean {
  const signature = `${toolName}:::${canonicalJson(input)}`;
  if (signature === state.lastSignature) {
    state.sameCallStreak += 1;
  } else {
    state.lastSignature = signature;
    state.sameCallStreak = 1;
  }
  return state.sameCallStreak >= threshold;
}

/**
 * Mencatat hasil tool. Mengembalikan true bila error sudah beruntun
 * sebanyak threshold kali dan hasil ini perlu dianotasi.
 */
export function registerToolResult(
  state: FailureState,
  isError: boolean,
  threshold: number,
): boolean {
  state.errorStreak = isError ? state.errorStreak + 1 : 0;
  return isError && state.errorStreak >= threshold;
}

/**
 * Berhenti kosong: pesan asisten terakhir tanpa toolCall dan tanpa teks,
 * stopReason "stop", dan tepat didahului toolResult.
 */
export function isEmptyStop(messages: readonly unknown[]): boolean {
  if (messages.length < 2) return false;
  const last = asRecord(messages[messages.length - 1]);
  const previous = asRecord(messages[messages.length - 2]);
  if (!last || !previous) return false;
  if (last.role !== "assistant" || previous.role !== "toolResult") return false;
  if (last.stopReason !== "stop") return false;

  const content = Array.isArray(last.content) ? last.content : [];
  const hasToolCall = content.some(
    (item) => asRecord(item)?.type === "toolCall",
  );
  if (hasToolCall) return false;

  const text = content
    .map((item) => {
      const record = asRecord(item);
      return record?.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .join("");
  return text.trim() === "";
}

/** Mengklaim satu continuation; menolak bila sudah mencapai batas maxRetries dalam satu run. */
export function claimContinuation(state: FailureState, maxRetries: number): boolean {
  if (state.continuationCount >= maxRetries) return false;
  state.continuationCount += 1;
  return true;
}

export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}

/**
 * Menormalkan konfigurasi mentah. Nilai tidak valid kembali ke default
 * (fail-open: detektor tetap aktif dengan ambang default).
 */
export function parseConfig(raw: unknown): FailureConfig {
  const root = asRecord(raw) ?? {};
  const loop = asRecord(root.loop);
  const emptyStop = asRecord(root.emptyStop);
  const consecutiveErrors = asRecord(root.consecutiveErrors);

  return {
    loop: {
      enabled: readBoolean(loop?.enabled, DEFAULT_CONFIG.loop.enabled),
      threshold: readThreshold(loop?.threshold, DEFAULT_CONFIG.loop.threshold),
    },
    emptyStop: {
      enabled: readBoolean(emptyStop?.enabled, DEFAULT_CONFIG.emptyStop.enabled),
      maxRetries: readThreshold(
        emptyStop?.maxRetries,
        DEFAULT_CONFIG.emptyStop.maxRetries,
      ),
    },
    consecutiveErrors: {
      enabled: readBoolean(
        consecutiveErrors?.enabled,
        DEFAULT_CONFIG.consecutiveErrors.enabled,
      ),
      threshold: readThreshold(
        consecutiveErrors?.threshold,
        DEFAULT_CONFIG.consecutiveErrors.threshold,
      ),
    },
  };
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readThreshold(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 2
    ? value
    : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
