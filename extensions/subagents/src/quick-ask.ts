/** Helpers for the `/quick-ask` side question command. */

import type { SubagentOrigin } from "./domain.ts"

export const QUICK_ASK_TITLE_MAX_LENGTH = 60

export function deriveQuickAskTitle(prompt: string) {
  const firstLine = prompt
    .split("\n")
    .find((line) => line.trim())
    ?.trim()
  const title = firstLine?.replace(/\s+/g, " ") ?? ""
  if (!title) return "quick ask"
  const codePoints = Array.from(title)
  if (codePoints.length <= QUICK_ASK_TITLE_MAX_LENGTH) return title
  return `${codePoints.slice(0, QUICK_ASK_TITLE_MAX_LENGTH - 1).join("")}…`
}

/** Quick-ask asides are visible in the dashboard but hidden from model tools. */
export function isModelVisible(snap: { readonly origin: SubagentOrigin }) {
  return snap.origin === "model"
}
