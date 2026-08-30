import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { formatElapsed, latestText, type SubagentSnapshot } from "../domain.ts";
import { sanitizeText } from "./transcript.ts";

function previewFor(snap: SubagentSnapshot, maxLength = 180): string {
  const source = snap.errorText ?? snap.report?.summary ?? latestText(snap);
  const preview = sanitizeText(source).replace(/\s+/g, " ").trim();
  if (preview.length <= maxLength) return preview;
  return `${preview.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Build the compact completion message used by the normal subagent path. */
export function buildCompletionNotification(
  snap: SubagentSnapshot,
  theme?: Theme,
  detailCommand = "/subagents",
): string {
  const failed = snap.status === "failed" || snap.report?.outcome === "failed";
  const icon = failed ? "✗" : "✓";
  const coloredIcon = theme
    ? theme.fg(failed ? "error" : "success", icon)
    : icon;
  const state = failed ? "failed" : "completed";
  const preview = previewFor(snap);
  const lines = [
    `${coloredIcon} ${snap.title} ${state} · ${formatElapsed(snap)}`,
    preview ? `  ⎿ ${preview}` : "",
    `  ${detailCommand} untuk membuka detail`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** Notify for every normal settled subagent; quick-ask has its own renderer. */
export function notifySubagentCompletion(
  ui: ExtensionUIContext,
  snap: SubagentSnapshot,
  detailCommand = "/subagents",
): void {
  const failed = snap.status === "failed" || snap.report?.outcome === "failed";
  ui.notify(
    buildCompletionNotification(snap, ui.theme, detailCommand),
    failed ? "error" : "info",
  );
}
