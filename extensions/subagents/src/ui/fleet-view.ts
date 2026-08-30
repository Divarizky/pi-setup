import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  formatElapsed,
  isSubagentBooting,
  type SubagentSnapshot,
} from "../domain.ts";
import { sanitizeText } from "./transcript.ts";
import type { WidgetQueuedJob } from "./agent-widget.ts";

export type FleetStatus =
  "queued" | "running" | "done" | "failed" | "blocked" | "starting" | "booting";

export interface FleetItem {
  readonly id: string;
  readonly title: string;
  readonly status: FleetStatus;
  readonly createdAt: number;
  readonly settledAt?: number;
  readonly role?: string;
  readonly mode?: string;
  readonly leadAgentId?: string;
  readonly snapshot?: SubagentSnapshot;
}

const STATUS_PRIORITY: Record<FleetStatus, number> = {
  running: 0,
  starting: 1,
  booting: 1,
  queued: 2,
  blocked: 2,
  done: 3,
  failed: 4,
};

function itemFromSnapshot(snap: SubagentSnapshot): FleetItem {
  const status: FleetStatus = snap.restarting
    ? "starting"
    : isSubagentBooting(snap)
      ? "booting"
      : snap.status;
  return {
    id: snap.id,
    title: snap.title,
    status,
    createdAt: snap.createdAt,
    settledAt: snap.settledAt,
    role: snap.meta.role,
    mode: snap.meta.mode,
    leadAgentId: snap.meta.leadAgentId,
    snapshot: snap,
  };
}

function itemFromQueued(job: WidgetQueuedJob): FleetItem {
  return {
    id: job.id,
    title: job.title,
    status: job.status,
    createdAt: job.createdAt,
    role: job.role,
    mode: job.mode,
    leadAgentId: job.leadAgentId,
  };
}

function statusLabel(item: FleetItem): string {
  switch (item.status) {
    case "running":
      return "running";
    case "starting":
      return "starting";
    case "booting":
      return "booting";
    case "queued":
      return "queued";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    case "failed":
      return "failed";
  }
}

function statusGlyph(item: FleetItem, theme: Theme): string {
  switch (item.status) {
    case "running":
    case "starting":
    case "booting":
      return theme.fg("warning", "⠹");
    case "done":
      return theme.fg("success", "✓");
    case "failed":
      return theme.fg("error", "✗");
    case "queued":
    case "blocked":
      return theme.fg("dim", "○");
  }
}

function itemDetails(item: FleetItem): string {
  const snap = item.snapshot;
  const activity =
    snap?.liveTools.at(-1)?.name ??
    (snap?.liveAssistant?.thinking.trim() ? "thinking" : undefined);
  return [statusLabel(item), activity, snap ? formatElapsed(snap) : undefined]
    .filter(Boolean)
    .join(" · ");
}

function compareItems(left: FleetItem, right: FleetItem): number {
  return (
    STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status] ||
    left.createdAt - right.createdAt ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Build the persistent FleetView below the editor. The caller owns the
 * session-scoped `hasBuildLead` flag; this function never enables the view for
 * a scout lead or for a standalone build worker.
 */
export function buildFleetViewLines(
  snapshots: ReadonlyArray<SubagentSnapshot>,
  queued: ReadonlyArray<WidgetQueuedJob> = [],
  hasBuildLead = false,
  width = 120,
  theme: Theme,
): string[] {
  if (!hasBuildLead) return [];

  const byId = new Map<string, FleetItem>();
  for (const snap of snapshots) byId.set(snap.id, itemFromSnapshot(snap));
  for (const job of queued)
    if (!byId.has(job.id)) byId.set(job.id, itemFromQueued(job));

  const all = [...byId.values()];
  const leadIds = all
    .filter((item) => item.role === "lead" && item.mode === "build")
    .sort(compareItems);
  if (leadIds.length === 0) return [];

  const lines = [
    theme.fg("accent", theme.bold("● main")),
    theme.fg("dim", "  FleetView · Agent Lead build"),
  ];
  for (const lead of leadIds) {
    const leadIdentity = lead.snapshot?.meta.leadAgentId ?? lead.id;
    const children = all
      .filter(
        (item) =>
          item.id !== lead.id &&
          (item.leadAgentId === leadIdentity || item.leadAgentId === lead.id),
      )
      .sort(compareItems);
    const runningChildren = children.filter(
      (item) =>
        item.status === "running" ||
        item.status === "starting" ||
        item.status === "booting",
    ).length;
    const childCount =
      children.length > 0
        ? ` · ${runningChildren}/${children.length} active`
        : "";
    const leadTitle = sanitizeText(lead.title).replace(/\s+/g, " ");
    lines.push(
      truncateToWidth(
        `○ ${theme.fg("accent", "lead-build")}  ${leadTitle} · ${itemDetails(lead)}${childCount}`,
        width,
      ),
    );
    children.forEach((child, index) => {
      const branch = index === children.length - 1 ? "└─" : "├─";
      const title = sanitizeText(child.title).replace(/\s+/g, " ");
      lines.push(
        truncateToWidth(
          `  ${branch} ${statusGlyph(child, theme)} ${child.mode ?? "build"}  ${title} · ${itemDetails(child)}`,
          width,
        ),
      );
    });
  }
  lines.push(theme.fg("dim", "  /subagents untuk membuka detail"));
  return lines.map((line) => truncateToWidth(line, width));
}

export function renderFleetView(
  ui: ExtensionUIContext,
  snapshots: ReadonlyArray<SubagentSnapshot>,
  queued: ReadonlyArray<WidgetQueuedJob>,
  hasBuildLead: boolean,
  theme: Theme = ui.theme,
  width = Math.max(40, Math.min(160, process.stdout.columns ?? 120)),
): void {
  const lines = buildFleetViewLines(
    snapshots,
    queued,
    hasBuildLead,
    width,
    theme,
  );
  ui.setWidget("subagents-fleet-view", lines.length > 0 ? lines : undefined, {
    placement: "belowEditor",
  });
}

export function invalidateFleetView(ui: ExtensionUIContext): void {
  ui.setWidget("subagents-fleet-view", undefined, { placement: "belowEditor" });
}
