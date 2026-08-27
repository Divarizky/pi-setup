/**
 * Shared view formatters — overlay rows, /todos lines, tool render hooks.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { formatStatusLabel } from "../locale.ts";
import { selectTaskSubjectById } from "../state/selectors.ts";
import type { TaskState } from "../state/store.ts";
import type {
  Task,
  TaskAction,
  TaskDetails,
  TaskMutationParams,
  TaskStatus,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Icons — single source of truth.
// ---------------------------------------------------------------------------

const ICON_FILLED = "▪";
const ICON_HOLLOW = "▫";

function iconFor(status: TaskStatus): string {
  return status === "pending" ? ICON_HOLLOW : ICON_FILLED;
}

export const STATUS_COLOR: Record<
  TaskStatus,
  "dim" | "warning" | "success" | "muted"
> = {
  pending: "dim",
  in_progress: "warning",
  completed: "success",
  deleted: "muted",
};

export const ACTION_GLYPH: Record<TaskAction, string> = {
  create: "+",
  update: "→",
  delete: "×",
  get: "›",
  list: "☰",
  clear: "∅",
};

/** Format a single task row for the persistent overlay. When `allDone` is
 * true (no pending/in_progress visible) the whole row renders dim. */
export function formatOverlayTaskLine(
  t: Task,
  theme: Theme,
  showId: boolean,
  allDone = false,
): string {
  const iconColor = allDone ? "dim" : STATUS_COLOR[t.status];
  const glyph = theme.fg(iconColor, iconFor(t.status));
  let subject = theme.fg(allDone ? "dim" : "text", t.subject);
  if (t.status === "completed" || t.status === "deleted") {
    subject = theme.strikethrough(subject);
  }
  let line = `${glyph}`;
  if (showId) line += ` ${theme.fg("dim", `#${t.id}`)}`;
  line += ` ${subject}`;
  if (t.status === "in_progress" && t.activeForm) {
    line += ` ${theme.fg("muted", `(${t.activeForm})`)}`;
  }
  if (t.blockedBy && t.blockedBy.length > 0) {
    line += ` ${theme.fg("muted", `⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
  }
  return line;
}

/** Format a single task line for the `/todos` slash command. */
export function formatCommandTaskLine(t: Task): string {
  const glyph = iconFor(t.status);
  const form =
    t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
  const block = t.blockedBy?.length
    ? `    ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`
    : "";
  return `  ${glyph} #${t.id} ${t.subject}${form}${block}`;
}

// ---------------------------------------------------------------------------
// Tool render hooks
// ---------------------------------------------------------------------------

/** `renderCall` body. Returns a Text node for the tool call display. */
export function renderTodoCall(
  args: TaskMutationParams & { action: TaskAction },
  theme: Theme,
  state: TaskState,
): Text {
  const glyph = ACTION_GLYPH[args.action] ?? args.action;
  let text =
    theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", glyph);

  if (args.action === "create" && args.subject) {
    text += ` ${theme.fg("dim", args.subject)}`;
  } else if (
    (args.action === "update" ||
      args.action === "get" ||
      args.action === "delete") &&
    args.id !== undefined
  ) {
    const subject = selectTaskSubjectById(state, args.id);
    text += ` ${theme.fg("accent", subject ?? `#${args.id}`)}`;
  } else if (args.action === "list" && args.status) {
    text += ` ${theme.fg("muted", formatStatusLabel(args.status))}`;
  }
  return new Text(text, 0, 0);
}

/** `renderResult` body. Status echo from the details envelope. */
export function renderTodoResult(
  result: { details?: unknown },
  theme: Theme,
): Text {
  const details = result.details as TaskDetails | undefined;
  if (details?.error) {
    return new Text(theme.fg("warning", `✗ ${details.error}`), 0, 0);
  }
  let status: TaskStatus | undefined;
  if (details) {
    const params = details.params as TaskMutationParams;
    switch (details.action) {
      case "create":
        status = details.tasks[details.tasks.length - 1]?.status;
        break;
      case "update":
        status =
          params.status ??
          details.tasks.find((t) => t.id === params.id)?.status;
        break;
      case "delete":
        status = details.tasks.find((t) => t.id === params.id)?.status;
        break;
      case "list":
      case "get":
      case "clear":
        break;
    }
  }
  if (status) {
    const ic = iconFor(status);
    return new Text(
      theme.fg(STATUS_COLOR[status], `${ic} ${formatStatusLabel(status)}`),
      0,
      0,
    );
  }
  return new Text(theme.fg("success", "✓"), 0, 0);
}
