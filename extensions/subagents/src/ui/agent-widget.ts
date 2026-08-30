import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  formatElapsed,
  isSubagentBooting,
  type SubagentSnapshot,
} from "../domain.ts";
import { formatContextUtilization } from "../format.ts";
import { sanitizeText } from "./transcript.ts";

export interface WidgetQueuedJob {
  readonly id: string;
  readonly title: string;
  readonly status: "queued" | "running" | "done" | "failed" | "blocked";
  readonly createdAt: number;
  readonly mode?: string;
  readonly role?: string;
  readonly leadAgentId?: string;
}

const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;
const SPINNER_INTERVAL_MS = 120;

function spinnerFrame(now: number): string {
  return SPINNER_FRAMES[
    Math.floor(now / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length
  ]!;
}

function statusIcon(snap: SubagentSnapshot, theme: Theme, now: number): string {
  if (snap.restarting || isSubagentBooting(snap) || snap.status === "running") {
    return theme.fg("warning", spinnerFrame(now));
  }
  if (snap.status === "done") return theme.fg("success", "✓");
  return theme.fg("error", "✗");
}

function activeTool(snap: SubagentSnapshot): string | undefined {
  const tool =
    [...snap.liveTools].reverse().find((item) => !item.done) ??
    snap.liveTools.at(-1);
  if (tool) return tool.name;
  if (snap.liveAssistant?.thinking.trim()) return "thinking";
  if (snap.liveAssistant?.text.trim()) return "responding";
  return undefined;
}

function snapshotLine(
  snap: SubagentSnapshot,
  width: number,
  theme: Theme,
  now: number,
): string {
  const state = snap.restarting
    ? "starting"
    : isSubagentBooting(snap)
      ? "booting"
      : snap.status;
  const role =
    snap.meta.role === "lead" ? "lead" : (snap.meta.mode ?? "subagent");
  const activity = activeTool(snap);
  const utilization = formatContextUtilization(snap.usage);
  const details = [
    state,
    activity,
    `${snap.turns} turn${snap.turns === 1 ? "" : "s"}`,
    utilization || undefined,
    formatElapsed(snap),
  ]
    .filter(Boolean)
    .join(" · ");
  const prefix = `${statusIcon(snap, theme, now)} ${role}  `;
  const title = sanitizeText(snap.title).replace(/\s+/g, " ");
  const line = `${prefix}${title} · ${details}`;
  return truncateToWidth(line, width);
}

function queuedLine(job: WidgetQueuedJob, width: number, theme: Theme): string {
  const role = job.role === "lead" ? "lead" : (job.mode ?? "subagent");
  const title = sanitizeText(job.title).replace(/\s+/g, " ");
  const state = job.status === "blocked" ? "blocked" : "queued";
  return truncateToWidth(
    `${theme.fg("dim", "○")} ${role}  ${title} · ${state}`,
    width,
  );
}

/** Build the compact live widget shown above the editor. */
export function buildAgentWidgetLines(
  snapshots: ReadonlyArray<SubagentSnapshot>,
  queued: ReadonlyArray<WidgetQueuedJob> = [],
  width = 120,
  theme: Theme,
  now = Date.now(),
): string[] {
  const visibleSnapshots = snapshots.filter(
    (snap) => snap.status === "running" || snap.restarting === true,
  );
  const snapshotIds = new Set(snapshots.map((snap) => snap.id));
  const visibleQueued = queued.filter(
    (job) =>
      !snapshotIds.has(job.id) &&
      (job.status === "queued" ||
        job.status === "running" ||
        job.status === "blocked"),
  );
  if (visibleSnapshots.length === 0 && visibleQueued.length === 0) return [];

  const entries = [
    ...visibleSnapshots.map((snap) =>
      snapshotLine(snap, Math.max(20, width - 3), theme, now),
    ),
    ...visibleQueued.map((job) =>
      queuedLine(job, Math.max(20, width - 3), theme),
    ),
  ];
  const lines = ["", theme.fg("accent", theme.bold("● Agents"))];
  entries.forEach((entry, index) => {
    lines.push(`${index === entries.length - 1 ? "└─" : "├─"} ${entry}`);
  });
  return lines.map((line) => truncateToWidth(line, width));
}

/** Render the widget through pi's general, terminal-independent UI API. */
export function renderAgentWidget(
  ui: ExtensionUIContext,
  snapshots: ReadonlyArray<SubagentSnapshot>,
  queued: ReadonlyArray<WidgetQueuedJob>,
  theme: Theme = ui.theme,
  width = Math.max(40, Math.min(160, process.stdout.columns ?? 120)),
): void {
  const lines = buildAgentWidgetLines(snapshots, queued, width, theme);
  ui.setWidget("subagents-agent-widget", lines.length > 0 ? lines : undefined, {
    placement: "aboveEditor",
  });
}

export function invalidateAgentWidget(ui: ExtensionUIContext): void {
  ui.setWidget("subagents-agent-widget", undefined, {
    placement: "aboveEditor",
  });
}
