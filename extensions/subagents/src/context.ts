/**
 * context.ts — Extract parent conversation context for subagent inheritance.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const MAX_PARENT_CONTEXT_CHARS = 12000;
export const TRUNCATION_INDICATOR = "...(truncated earlier messages)...";

/** Extract text from a message content block array. */
export function extractText(content: unknown[]): string {
  return content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n");
}

type ContextItem =
  | { type: "message"; text: string }
  | { type: "summary"; text: string };

function formatContext(body: string): string {
  return `# Parent Conversation Context
The following is the conversation history from the parent session that spawned you.
Use this context to understand what has been discussed and decided so far.

${body}

---
# Your Task (below)
`;
}

/**
 * Build a text representation of the parent conversation context.
 * Used when inherit_context is true to give the subagent visibility
 * into what has been discussed/done so far.
 *
 * Truncates older messages if context exceeds maxChars (default 12000),
 * while preserving the latest compaction summary and the most recent messages.
 */
export function buildParentContext(
  ctx: ExtensionContext,
  maxChars: number = MAX_PARENT_CONTEXT_CHARS,
): string {
  const entries = ctx.sessionManager?.getBranch();
  if (!entries || entries.length === 0) return "";

  const items: ContextItem[] = [];

  for (const entry of entries) {
    if (entry.type === "message") {
      const msg = entry.message;
      if (msg.role === "user") {
        const text = typeof msg.content === "string"
          ? msg.content
          : extractText(msg.content);
        if (text.trim()) items.push({ type: "message", text: `[User]: ${text.trim()}` });
      } else if (msg.role === "assistant") {
        const text = extractText(msg.content);
        if (text.trim()) items.push({ type: "message", text: `[Assistant]: ${text.trim()}` });
      }
      // Skip toolResult messages — too verbose for context
    } else if (entry.type === "compaction") {
      // Include compaction summaries — they're already condensed
      if (entry.summary && entry.summary.trim()) {
        items.push({ type: "summary", text: `[Summary]: ${entry.summary.trim()}` });
      }
    }
  }

  if (items.length === 0) return "";

  const fullBody = items.map((item) => item.text).join("\n\n");
  if (fullBody.length <= maxChars) {
    return formatContext(fullBody);
  }

  // Budget exceeded: apply sliding-window truncation.
  // 1. Keep the latest [Summary] compaction entry if present.
  let latestSummary: string | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].type === "summary") {
      latestSummary = items[i].text;
      break;
    }
  }

  if (latestSummary && latestSummary.length >= maxChars) {
    return formatContext(latestSummary.slice(0, maxChars));
  }

  const messageItems = items.filter((item) => item.type === "message");

  // Determine prefix and budget for recent messages:
  // Layout: [Summary (optional)] \n\n [TRUNCATION_INDICATOR] \n\n [Recent messages...]
  let baseLength = 0;
  if (latestSummary) {
    baseLength += latestSummary.length + 2; // for "\n\n"
  }
  baseLength += TRUNCATION_INDICATOR.length;

  let budgetForMessages = maxChars - baseLength;
  if (budgetForMessages > 2) {
    budgetForMessages -= 2; // for "\n\n" between indicator and first message
  } else {
    budgetForMessages = 0;
  }

  const keptMessages: string[] = [];
  let currentMessagesLen = 0;

  for (let i = messageItems.length - 1; i >= 0; i--) {
    const msgText = messageItems[i].text;
    const addedLen = keptMessages.length === 0 ? msgText.length : msgText.length + 2;
    if (currentMessagesLen + addedLen <= budgetForMessages) {
      keptMessages.unshift(msgText);
      currentMessagesLen += addedLen;
    } else {
      if (keptMessages.length === 0 && budgetForMessages > 0) {
        keptMessages.unshift(msgText.slice(0, budgetForMessages));
      }
      break;
    }
  }

  const finalParts: string[] = [];
  if (latestSummary) {
    finalParts.push(latestSummary);
  }
  finalParts.push(TRUNCATION_INDICATOR);
  finalParts.push(...keptMessages);

  let body = finalParts.join("\n\n");
  if (body.length > maxChars) {
    body = body.slice(0, maxChars);
  }

  return formatContext(body);
}
