import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMatcher, type Matcher } from "./matcher.ts";
import { stripViolations } from "./strip.ts";
import type { TtsrDeps, Violation } from "./types.ts";

const MAX_RETRIES_PER_USER_MESSAGE = 2;
const EXCERPT_LIMIT = 120;
const NO_EXCERPT_RULES = new Set(["secret-in-write"]);

interface PendingCorrection {
  rule: string;
  text: string;
}

interface StreamState {
  abortedThisTurn: boolean;
  stripMatches: Record<"text" | "thinking", string[]>;
  pendingCorrection: PendingCorrection | null;
  retriesForUserMessage: number;
}

function scopeOf(event: { assistantMessageEvent: { type: string } }): string | null {
  const type = event.assistantMessageEvent.type;
  if (type === "text_delta") return "text";
  if (type === "thinking_delta") return "thinking";
  return null;
}

function deltaOf(event: { assistantMessageEvent: unknown }): string {
  const ev = event.assistantMessageEvent as { delta?: unknown };
  return typeof ev.delta === "string" ? ev.delta : "";
}

function buildExcerpt(ruleName: string, match: string): string | undefined {
  if (NO_EXCERPT_RULES.has(ruleName)) return undefined;
  return match.slice(0, EXCERPT_LIMIT);
}

function formatCorrection(rule: string, text: string): string {
  return `<system-interrupt reason="rule_violation" rule="${rule}">${text}</system-interrupt>`;
}

function warn(where: string, error: unknown): void {
  console.warn(`[ttsr] ${where} gagal:`, error);
}

export function registerStreamGuard(pi: ExtensionAPI, deps: TtsrDeps): void {
  const state: StreamState = {
    abortedThisTurn: false,
    stripMatches: { text: [], thinking: [] },
    pendingCorrection: null,
    retriesForUserMessage: 0,
  };

  // Satu instance matcher untuk seluruh sesi. Riwayat repeat (completedTurns, lastFiredTurn)
  // harus bertahan lintas giliran agar kebijakan once dan after-gap berfungsi.
  // Rule yang dimatikan lewat isEnabled tetap masuk matcher dan disaring saat pelanggaran
  // diterima, sehingga /ttsr on|off tetap berlaku tanpa membuat ulang matcher.
  // Jika getRules gagal saat registrasi, matcher dibuat ulang dengan rule kosong
  // dan percobaan berikutnya dilakukan saat giliran pertama dimulai.
  let matcher: Matcher | null = null;
  try {
    matcher = createMatcher(deps.getRules());
  } catch (error) {
    warn("registerStreamGuard", error);
  }
  function ensureMatcher(): Matcher {
    if (!matcher) matcher = createMatcher(deps.getRules());
    return matcher;
  }

  function resetTurn(): void {
    ensureMatcher().reset();
    state.abortedThisTurn = false;
    state.stripMatches = { text: [], thinking: [] };
    state.pendingCorrection = null;
  }

  function handleViolation(v: Violation, ctx: ExtensionContext): void {
    const rule = v.rule;
    // retry true bila pelanggaran ini memicu giliran koreksi. Batas retry
    // yang sama dicek ulang di agent_settled, dan counter tidak berubah selama giliran.
    const triggersRetry =
      rule.action === "abort" &&
      !state.abortedThisTurn &&
      state.retriesForUserMessage < MAX_RETRIES_PER_USER_MESSAGE;
    deps.log({
      ts: Date.now(),
      rule: rule.name,
      action: rule.action,
      scope: v.scope,
      retry: triggersRetry,
      excerpt: buildExcerpt(rule.name, v.match),
    });

    if (rule.action === "abort") {
      if (state.abortedThisTurn) return;
      state.abortedThisTurn = true;
      state.pendingCorrection = { rule: rule.name, text: rule.correctionText };
      ctx.abort();
    } else if (rule.action === "strip") {
      if (v.scope === "text" || v.scope === "thinking") {
        state.stripMatches[v.scope].push(v.match);
      }
    }
  }

  pi.on("before_agent_start", (event) => {
    try {
      if (event.messageType === "user") {
        state.retriesForUserMessage = 0;
      }
    } catch (error) {
      warn("before_agent_start", error);
    }
  });

  pi.on("message_start", (event) => {
    try {
      if (event.message.role === "assistant") resetTurn();
    } catch (error) {
      warn("message_start", error);
    }
  });

  pi.on("message_update", (event, ctx) => {
    try {
      const scope = scopeOf(event);
      if (!scope) return;
      const delta = deltaOf(event);
      if (!delta) return;
      const violations = ensureMatcher().feed(scope, delta);
      for (const v of violations) {
        if (!deps.isEnabled(v.rule.name)) continue;
        handleViolation(v, ctx);
      }
    } catch (error) {
      warn("message_update", error);
    }
  });

  function finishAssistantMessage(message: any): { message: any } | undefined {
    if (state.abortedThisTurn) {
      return { message: { ...message, content: [] } };
    }

    const { text: textMatches, thinking: thinkingMatches } = state.stripMatches;
    if (textMatches.length === 0 && thinkingMatches.length === 0) return undefined;

    const content = message.content.map((block: any) => {
      if (block.type === "text" && textMatches.length > 0) {
        return { ...block, text: stripViolations(block.text, textMatches.map((match) => ({ match }))) };
      }
      if (block.type === "thinking" && thinkingMatches.length > 0) {
        return {
          ...block,
          thinking: stripViolations(block.thinking, thinkingMatches.map((match) => ({ match }))),
        };
      }
      return block;
    });
    return { message: { ...message, content } };
  }

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    try {
      ensureMatcher().endTurn();
    } catch (error) {
      warn("message_end endTurn", error);
    }
    try {
      return finishAssistantMessage(event.message);
    } catch (error) {
      warn("message_end", error);
    }
  });

  pi.on("context", (event) => {
    try {
      const filtered = event.messages.filter(
        (m) => !(m.role === "assistant" && m.stopReason === "aborted"),
      );
      if (filtered.length === event.messages.length) return;
      return { messages: filtered };
    } catch (error) {
      warn("context", error);
    }
  });

  pi.on("agent_settled", (_event) => {
    try {
      const correction = state.pendingCorrection;
      if (!correction) return;
      state.pendingCorrection = null;
      if (state.retriesForUserMessage >= MAX_RETRIES_PER_USER_MESSAGE) return;
      state.retriesForUserMessage += 1;
      pi.sendMessage(
        {
          customType: "ttsr",
          content: formatCorrection(correction.rule, correction.text),
          display: false,
          details: { rule: correction.rule },
        },
        { triggerTurn: true },
      );
    } catch (error) {
      warn("agent_settled", error);
    }
  });
}
