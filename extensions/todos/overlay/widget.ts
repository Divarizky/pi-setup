/**
 * TodosOverlay — persistent widget showing the todo list above the editor.
 *
 * Lifecycle controller for Pi's `setWidget` contract: factory-form
 * registration in the aboveEditor slot, register-once + requestRender()
 * refresh, configurable collapse (not scroll), auto-hide when empty.
 *
 * Reads live state via `getRenderState()` (the ctx-less foreground slot) at
 * render time — NEVER from the branch (branch is stale inside
 * `tool_execution_end`).
 */

import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";

import {
  COLLAPSE_KEY_OFF,
  getMaxWidgetLines,
  resolveCollapseKey,
} from "../config.ts";
import { formatStatusLabel, t } from "../locale.ts";
import {
  selectHasActive,
  selectOverlayLayout,
  selectShowTaskIds,
  selectTodoCounts,
} from "../state/selectors.ts";
import { getRenderState } from "../state/store.ts";
import { formatOverlayTaskLine, STATUS_COLOR } from "./format.ts";

const WIDGET_KEY = "todos";
const ICON_FILLED = "▪";

// English fallbacks for localized overlay chrome strings.
const OVERLAY_HEADING = "Todos";
const OVERLAY_MORE = "more";
const OVERLAY_EXPAND_HINT = "{key} to expand";
const OVERLAY_COLLAPSED = "collapsed";

export class TodosOverlay {
  private uiCtx: ExtensionUIContext | undefined;
  private widgetRegistered = false;
  private tui: TUI | undefined;
  private completedTaskIdsPendingHide = new Set<number>();
  private hiddenCompletedTaskIds = new Set<number>();
  private lastNextId: number | undefined;
  private collapsed = false;
  private readonly collapseKey: string;

  constructor(collapseKey = resolveCollapseKey()) {
    this.collapseKey = collapseKey;
  }

  setUICtx(ctx: ExtensionUIContext): void {
    // Identity-compare so repeat session_start handlers are idempotent;
    // on identity change (/reload) invalidate so update() re-registers.
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
    }
  }

  update(): void {
    if (!this.uiCtx) return;
    const snapshot = this.getSnapshot();
    const visible = this.selectOverlayTasks(snapshot);

    if (visible.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget(WIDGET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      return;
    }

    if (!this.widgetRegistered) {
      this.uiCtx.setWidget(
        WIDGET_KEY,
        (tui, factoryTheme) => {
          this.tui = tui;
          return {
            render: (width: number) =>
              this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
            invalidate: () => {
              // No rendered strings are cached. Pi invalidates on theme
              // changes; the next render reads uiCtx.theme.
            },
          };
        },
        { placement: "aboveEditor" },
      );
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  resetCompletedDisplayState(): void {
    this.completedTaskIdsPendingHide.clear();
    this.hiddenCompletedTaskIds.clear();
    this.lastNextId = undefined;
  }

  hideCompletedTasksFromPreviousTurn(): void {
    if (this.completedTaskIdsPendingHide.size === 0) return;
    for (const taskId of this.completedTaskIdsPendingHide) {
      this.hiddenCompletedTaskIds.add(taskId);
    }
    this.completedTaskIdsPendingHide.clear();
    this.tui?.requestRender();
  }

  toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.tui?.requestRender(true);
  }

  isRegistered(): boolean {
    return this.widgetRegistered;
  }

  private getSnapshot() {
    const state = getRenderState();
    if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
      this.resetCompletedDisplayState();
    }
    this.lastNextId = state.nextId;
    const completedTaskIds = new Set(
      state.tasks
        .filter((task) => task.status === "completed")
        .map((task) => task.id),
    );
    for (const taskId of this.completedTaskIdsPendingHide) {
      if (!completedTaskIds.has(taskId))
        this.completedTaskIdsPendingHide.delete(taskId);
    }
    for (const taskId of this.hiddenCompletedTaskIds) {
      if (!completedTaskIds.has(taskId))
        this.hiddenCompletedTaskIds.delete(taskId);
    }
    return { tasks: [...state.tasks], nextId: state.nextId };
  }

  private selectOverlayTasks(
    snapshot: ReturnType<TodosOverlay["getSnapshot"]>,
  ) {
    return snapshot.tasks.filter(
      (task) =>
        task.status !== "deleted" && !this.shouldHideCompletedTask(task),
    );
  }

  private shouldHideCompletedTask(
    task: ReturnType<TodosOverlay["getSnapshot"]>["tasks"][number],
  ): boolean {
    return (
      task.status === "completed" && this.hiddenCompletedTaskIds.has(task.id)
    );
  }

  private renderWidget(theme: Theme, width: number): string[] {
    const snapshot = this.getSnapshot();
    const overlayTasks = this.selectOverlayTasks(snapshot);
    if (overlayTasks.length === 0) return [];

    const overlayState = { tasks: overlayTasks, nextId: snapshot.nextId };
    const truncate = (line: string): string =>
      truncateToWidth(line, width, "…");
    const counts = selectTodoCounts(overlayState);
    const hasActive = selectHasActive(overlayState);
    const showIds = selectShowTaskIds(overlayState);

    // All visible tasks completed → dim the whole panel (calm/done state).
    const allDone = !hasActive;
    const headingColor = allDone ? "dim" : "warning";
    const headingIcon = ICON_FILLED;
    const headingText = `${t("overlay.heading", OVERLAY_HEADING)} (${counts.completed}/${counts.total})`;
    const heading = truncate(
      `${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, headingText)}`,
    );

    if (this.collapsed) {
      const hint =
        this.collapseKey === COLLAPSE_KEY_OFF
          ? t("overlay.collapsed", OVERLAY_COLLAPSED)
          : t("overlay.expandHint", OVERLAY_EXPAND_HINT).replace(
              "{key}",
              this.collapseKey,
            );
      return this.withTrailingSpacer([
        heading,
        truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", hint)}`),
      ]);
    }

    const lines: string[] = [heading];
    const layout = selectOverlayLayout(overlayState, getMaxWidgetLines() - 1);
    for (const task of layout.visible) {
      lines.push(
        truncate(
          `${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds, allDone)}`,
        ),
      );
    }

    const newlyDisplayedCompletedTaskIds = overlayTasks
      .filter(
        (task) =>
          task.status === "completed" &&
          !this.completedTaskIdsPendingHide.has(task.id) &&
          !this.hiddenCompletedTaskIds.has(task.id),
      )
      .map((task) => task.id);
    for (const taskId of newlyDisplayedCompletedTaskIds) {
      this.completedTaskIdsPendingHide.add(taskId);
    }

    if (layout.hiddenCompleted === 0 && layout.truncatedTail === 0) {
      const last = lines.length - 1;
      lines[last] = lines[last].replace("├─", "└─");
      return this.withTrailingSpacer(lines);
    }

    const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
    const overflowParts: string[] = [];
    if (layout.hiddenCompleted > 0)
      overflowParts.push(
        `${layout.hiddenCompleted} ${formatStatusLabel("completed")}`,
      );
    if (layout.truncatedTail > 0)
      overflowParts.push(
        `${layout.truncatedTail} ${formatStatusLabel("pending")}`,
      );
    const more = t("overlay.more", OVERLAY_MORE);
    const summary =
      overflowParts.length > 0
        ? `+${totalHidden} ${more} (${overflowParts.join(", ")})`
        : `+${totalHidden} ${more}`;
    lines.push(
      truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", summary)}`),
    );
    return this.withTrailingSpacer(lines);
  }

  /** Trailing blank row so the panel isn't flush against the editor box. */
  private withTrailingSpacer(lines: string[]): string[] {
    if (lines.length === 0) return lines;
    lines.push("");
    return lines;
  }

  dispose(): void {
    if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
    this.collapsed = false;
    this.resetCompletedDisplayState();
  }
}
