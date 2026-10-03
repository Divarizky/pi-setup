import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REFRESH_INTERVAL_MS = 1_000;
/** Elapsed time is only shown once the turn has run this long. */
const SHOW_TIMER_AFTER_MS = 3_000;
/** Expected output of estimation; keep in sync with tests. */
export const CHARS_PER_TOKEN = 4;

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

type ContentBlock = {
  type?: unknown;
  text?: unknown;
  thinking?: { text?: unknown };
  thinkingSignature?: { body?: unknown };
};

export type StreamMessageLike = {
  content?: unknown;
  usage?: { output?: unknown };
};

/** Visible text/thinking length per content index; sparse for other blocks. */
export function textBlockLengths(message: StreamMessageLike): number[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const lengths: number[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index] as ContentBlock;
    if (block?.type === "text" && typeof block.text === "string") {
      lengths[index] = block.text.length;
    } else if (
      block?.type === "thinking" &&
      typeof block.thinking?.text === "string"
    ) {
      lengths[index] = block.thinking.text.length;
    } else if (
      block?.type === "thinking" &&
      typeof block.thinkingSignature?.body === "string"
    ) {
      lengths[index] = block.thinkingSignature.body.length;
    }
  }
  return lengths;
}

export function outputUsage(message: StreamMessageLike): number {
  const value = Number(message?.usage?.output);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function estimateTokens(charCount: number): number {
  return Math.max(0, Math.round(charCount / CHARS_PER_TOKEN));
}

export function buildWorkingMessage(
  tokens: number,
  elapsedMs: number,
): string {
  const parts: string[] = [];
  if (tokens > 0) parts.push(`↓ ${formatCount(tokens)} tokens`);
  if (elapsedMs >= SHOW_TIMER_AFTER_MS) {
    parts.push(formatDuration(elapsedMs));
  }
  return parts.length > 0 ? `Working... (${parts.join(" · ")})` : "";
}

type WorkingUi = {
  setWorkingMessage(message?: string): void;
};

/**
 * Extend Pi's working row while preserving its built-in spinner:
 * `Working... (↓ 1,234 tokens · 12s)`.
 *
 * Live tokens use a chars/4 estimate, then switch to provider
 * `usage.output` whenever the stream exposes an actual count.
 */
export function installWorkingMessage(pi: ExtensionAPI): void {
  let turnActive = false;
  let turnStartTime = 0;
  let responseLength = 0;
  let responseTextBlockLengths: number[] = [];
  let providerOutputTokens = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let lastMessage: string | null = null;
  let activeCtx: { ui: WorkingUi | undefined; hasUI: boolean } | null = null;

  const tokenCount = (): number =>
    providerOutputTokens || estimateTokens(responseLength);

  const setTextBlockLength = (index: number, length: number): void => {
    const previous = responseTextBlockLengths[index] ?? 0;
    responseTextBlockLengths[index] = Math.max(0, length);
    responseLength = Math.max(
      0,
      responseLength + responseTextBlockLengths[index]! - previous,
    );
  };

  const resetResponseTracking = (message?: StreamMessageLike): void => {
    responseTextBlockLengths = message ? textBlockLengths(message) : [];
    responseLength = responseTextBlockLengths.reduce(
      (sum, length) => sum + length,
      0,
    );
    providerOutputTokens = message ? outputUsage(message) : 0;
  };

  const updateProviderUsage = (message: StreamMessageLike): void => {
    const output = outputUsage(message);
    if (output > 0) providerOutputTokens = output;
  };

  const workingUiAvailable = (): boolean => {
    try {
      return activeCtx?.hasUI === true;
    } catch {
      // Stale ctx after session replace/reload; stop driving the footer.
      turnActive = false;
      activeCtx = null;
      stopRefreshLoop();
      return false;
    }
  };

  const restoreDefaultWorkingMessage = (): void => {
    lastMessage = null;
    if (!workingUiAvailable()) return;
    try {
      activeCtx?.ui?.setWorkingMessage();
    } catch {
      // Noop when the TUI is unavailable.
    }
  };

  const syncWorkingMessage = (force = false): void => {
    if (!workingUiAvailable()) return;
    const next = buildWorkingMessage(tokenCount(), Date.now() - turnStartTime);
    if (!next) {
      if (force) restoreDefaultWorkingMessage();
      return;
    }
    if (!force && next === lastMessage) return;
    lastMessage = next;
    try {
      activeCtx?.ui?.setWorkingMessage(next);
    } catch {
      // Noop when the TUI is unavailable.
    }
  };

  const scheduleRefreshTick = (): void => {
    if (!turnActive || refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      try {
        syncWorkingMessage();
      } catch {
        // Timer exceptions become uncaughtException and kill Pi; stop instead.
        turnActive = false;
        return;
      }
      scheduleRefreshTick();
    }, REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
  };

  function stopRefreshLoop(): void {
    if (!refreshTimer) return;
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  const clearDisplay = (): void => {
    stopRefreshLoop();
    turnStartTime = 0;
    resetResponseTracking();
    restoreDefaultWorkingMessage();
  };

  pi.on("turn_start", async (_event, ctx) => {
    turnActive = true;
    activeCtx = ctx;
    turnStartTime = Date.now();
    resetResponseTracking();
    syncWorkingMessage(true);
    scheduleRefreshTick();
  });

  pi.on("message_update", async (event, ctx) => {
    activeCtx = ctx;
    const evt = event?.assistantMessageEvent as
      | {
          type?: string;
          contentIndex?: number;
          delta?: unknown;
          content?: unknown;
          partial?: StreamMessageLike;
          message?: StreamMessageLike;
          error?: unknown;
        }
      | undefined;
    if (!evt) return;

    if (evt.type === "start") {
      resetResponseTracking(evt.partial);
    } else if (evt.type === "thinking_start" || evt.type === "text_start") {
      setTextBlockLength(evt.contentIndex ?? 0, 0);
      if (evt.partial) updateProviderUsage(evt.partial);
    } else if (evt.type === "thinking_delta" || evt.type === "text_delta") {
      const add = typeof evt.delta === "string" ? evt.delta.length : 0;
      const index = evt.contentIndex ?? 0;
      setTextBlockLength(
        index,
        (responseTextBlockLengths[index] ?? 0) + add,
      );
      if (evt.partial) updateProviderUsage(evt.partial);
    } else if (evt.type === "text_end") {
      setTextBlockLength(
        evt.contentIndex ?? 0,
        typeof evt.content === "string" ? evt.content.length : 0,
      );
      if (evt.partial) updateProviderUsage(evt.partial);
    } else if (evt.type === "done") {
      resetResponseTracking(evt.message);
    } else if (evt.type === "error") {
      resetResponseTracking();
    } else if (evt.partial) {
      updateProviderUsage(evt.partial);
    }

    syncWorkingMessage();
    scheduleRefreshTick();
  });

  pi.on("turn_end", async (_event, ctx) => {
    turnActive = false;
    activeCtx = ctx;
    stopRefreshLoop();
    resetResponseTracking();
    // No completion message: return immediately to Pi's default idle state.
    restoreDefaultWorkingMessage();
  });

  pi.on("agent_end", async () => {
    turnActive = false;
    clearDisplay();
  });

  pi.on("session_shutdown", async () => {
    turnActive = false;
    clearDisplay();
    activeCtx = null;
  });
}
