/**
 * Composer state classification for Orca terminals.
 *
 * A connected terminal is not proof it can accept input: popups, stale
 * banners, or an agent that exited to a shell all look "connected". The
 * classifier is fail-closed — `unknown` never justifies typing into a
 * terminal. Shape catalogue mirrors firstmate's shared composer rules.
 */

export type ComposerVerdict = "empty" | "pending" | "unknown";

/** Extract display lines from an untrusted Orca terminal read payload. */
export function linesFromRead(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (record.terminal && typeof record.terminal === "object") {
    return linesFromRead(record.terminal);
  }
  const rows = record.lines ?? record.tail;
  if (Array.isArray(rows)) {
    return rows
      .map((row) => {
        if (typeof row === "string") return row;
        if (!row || typeof row !== "object") return "";
        const item = row as Record<string, unknown>;
        return typeof item.text === "string"
          ? item.text
          : typeof item.content === "string"
            ? item.content
            : "";
      })
      .filter(Boolean);
  }
  for (const key of ["text", "output", "content"]) {
    if (typeof record[key] === "string") {
      const text = record[key] as string;
      return text.length > 0 ? text.split(/\r?\n/) : [];
    }
  }
  return [];
}

/** Classify the bottom-most composer shape from a bounded tail read. */
export function classifyComposer(tail: ReadonlyArray<string>): ComposerVerdict {
  const rows = tail
    .map((row) => row.replace(/\s+$/, ""))
    .filter((row) => row.trim().length > 0);
  if (rows.length === 0) return "unknown";

  // Bordered composer box (Pi/codex TUI): content lives between │ borders.
  const boxRows = rows.filter((row) => row.includes("│"));
  if (boxRows.length > 0) {
    const inner = boxRows
      .map((row) => row.replace(/[│╭╮╰╯─]/g, "").trim())
      .filter((text) => text.length > 0);
    const promptRow = inner.find((text) => /^[❯>]/.test(text));
    // A bordered box without a prompt row is a banner or popup body, never a composer.
    if (promptRow === undefined) return "unknown";
    return promptRow.slice(1).trim().length > 0 ? "pending" : "empty";
  }

  // Borderless prompt row (claude-style): scan bottom-up past horizontal
  // rules so a stale banner above can never outrank the live composer.
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index].trim();
    if (/^[-─=_]+$/.test(row)) continue;
    if (/^[❯>]\s*$/.test(row)) return "empty";
    if (/^[❯>]\s+\S/.test(row)) return "pending";
    return "unknown";
  }
  return "unknown";
}

export interface ComposerGateIO {
  /** Bounded tail read of the live terminal (small limit, no cursor). */
  readTail(limit: number): Promise<unknown>;
  type(text: string): Promise<void>;
  submit(): Promise<void>;
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Type once, then drive the verify-and-retry-Enter loop: pending means the
 * Enter did not land yet (popup placeholder fill), empty means submitted,
 * unknown refuses to blind-submit.
 */
// ponytail: attempts are time-boxed, not event-driven — swap for an Orca
// composer-cleared signal when the CLI exposes one.
export async function typeAndSubmit(
  io: ComposerGateIO,
  text: string,
  options: { readonly attempts?: number; readonly delayMs?: number } = {},
): Promise<"submitted" | "pending-composer" | "unknown-composer"> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const delayMs = Math.max(0, options.delayMs ?? 200);
  await io.type(text);
  let submitted = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await delay(delayMs);
    const verdict = classifyComposer(linesFromRead(await io.readTail(12)));
    if (verdict === "pending") {
      await io.submit();
      submitted = true;
      continue;
    }
    if (verdict === "empty") return "submitted";
    return "unknown-composer";
  }
  return submitted ? "pending-composer" : "unknown-composer";
}
