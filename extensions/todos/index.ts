/**
 * todos — Pi extension. Registers the `todo` tool, `/todos` slash command,
 * `/lang` language switch, and the persistent TodosOverlay widget.
 *
 * Overlay lifecycle: session_start replays the branch into the session's own
 * slot and binds the foreground overlay; session_compact / session_tree
 * re-key and refresh; session_shutdown evicts the slot and disposes the
 * overlay; tool_execution_end refreshes after a successful `todo` call.
 * Config (maxWidgetLines, collapseKey) is read hot per render — no /reload.
 */

import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

import {
  COLLAPSE_KEY_OFF,
  getConfigLocale,
  resolveCollapseKey,
} from "./config.ts";
import { registerLangCommand, setLocale } from "./locale.ts";
import {
  makeOverlayLoader,
  prewarmOverlay,
  type OverlayImporter,
} from "./loader.ts";
import {
  clearActiveRenderSession,
  evictSession,
  getActiveRenderSession,
  getRenderState,
  replaceState,
  replayFromBranch,
  setActiveRenderSession,
  sid,
} from "./state/store.ts";
import { registerTodoTool } from "./tool.ts";
import { registerTodosCommand } from "./command.ts";
import { TOOL_NAME } from "./types.ts";
import type { TodosOverlay } from "./overlay/widget.ts";

/** pi-core's ExtensionRunner throws this phrase from an invalidated ctx proxy
 * after session replacement/reload. Match the stable substring so genuine
 * replay bugs still propagate instead of being silently swallowed. */
function isStaleCtxError(e: unknown): boolean {
  return /stale after session replacement/.test(String(e));
}

function formatError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function (
  pi: ExtensionAPI,
  importOverlay: OverlayImporter = () => import("./overlay/widget.ts"),
) {
  // Initial locale from config (read once at init; /lang switches live).
  setLocale(getConfigLocale());

  let todoOverlay: TodosOverlay | undefined;
  const loadTodoOverlay = makeOverlayLoader(importOverlay);
  let uiCtx: ExtensionUIContext | undefined;
  const uiSessions = new Map<string, ExtensionUIContext>();
  let lifecycleGeneration = 0;

  async function updateTodoOverlay(
    resetCompletedDisplayState = false,
    generation = lifecycleGeneration,
  ): Promise<void> {
    const hasVisibleTasks = getRenderState().tasks.some(
      (task) => task.status !== "deleted",
    );
    if (!uiCtx || (!todoOverlay && !hasVisibleTasks)) return;

    const { TodosOverlay } = await loadTodoOverlay();
    if (generation !== lifecycleGeneration || !uiCtx) return;

    todoOverlay ??= new TodosOverlay(collapseKey);
    todoOverlay.setUICtx(uiCtx);
    if (resetCompletedDisplayState) todoOverlay.resetCompletedDisplayState();
    todoOverlay.update();
  }

  registerTodoTool(pi);
  registerTodosCommand(pi);
  registerLangCommand(pi, () => {
    void updateTodoOverlay().catch((e) => {
      console.warn(
        `[todos] overlay refresh failed after language change: ${formatError(e)}`,
      );
    });
  });

  // Collapse/expand hotkey. Resolved once at factory scope from config
  // (register-once contract: a config change needs /reload to re-bind).
  // The handler closes over `todoOverlay` by reference and re-reads it at
  // fire time. No-op in headless mode or when the widget isn't registered.
  const collapseKey = resolveCollapseKey();
  if (collapseKey !== COLLAPSE_KEY_OFF) {
    pi.registerShortcut(collapseKey as KeyId, {
      description: "Collapse or expand the todo overlay",
      handler: (ctx) => {
        if (!ctx.hasUI || !todoOverlay?.isRegistered()) return;
        todoOverlay.toggleCollapse();
      },
    });
  }

  // Re-key a session's slot from its branch, then refresh the overlay only
  // when the refreshed session IS the foreground. Shared by session_compact
  // and session_tree. A stale ctx keeps current state — the replacement
  // session's session_start replays it. The render is sid-gated so a child
  // never refreshes the foreground overlay.
  const replayAndRefresh = async (
    ctx: Parameters<typeof sid>[0] & Parameters<typeof replayFromBranch>[0],
  ): Promise<void> => {
    let isForeground = false;
    try {
      const id = sid(ctx);
      replaceState(id, replayFromBranch(ctx));
      isForeground = id === getActiveRenderSession();
    } catch (e) {
      if (!isStaleCtxError(e)) throw e;
    }
    if (isForeground) await updateTodoOverlay(true);
  };

  pi.on("session_start", async (_event, ctx) => {
    let id: string;
    try {
      id = sid(ctx);
      // Every session replays into its OWN data slot (session isolation).
      replaceState(id, replayFromBranch(ctx));
    } catch (e) {
      if (!isStaleCtxError(e)) throw e;
      return;
    }
    if (!ctx.hasUI) return;
    uiSessions.set(id, ctx.ui);
    // First UI-bearing session_start claims the foreground (the interactive
    // launcher, by spawn-ordering) without eagerly loading the overlay.
    if (getActiveRenderSession() === "") setActiveRenderSession(id);
    if (id !== getActiveRenderSession()) return;
    const generation = ++lifecycleGeneration;
    uiCtx = ctx.ui;
    await updateTodoOverlay(true, generation);
  });

  pi.on("session_compact", async (_event, ctx) => {
    await replayAndRefresh(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await replayAndRefresh(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    let s: string;
    try {
      s = sid(ctx);
    } catch (e) {
      if (!isStaleCtxError(e)) throw e;
      s = "";
    }
    // The shutting-down session's own data slot is always evicted.
    evictSession(s);
    uiSessions.delete(s);
    // Overlay teardown is sid-gated: only the foreground's own shutdown
    // (or an unknown/stale sid) tears it down and clears the pointer.
    if (s === "" || s === getActiveRenderSession()) {
      lifecycleGeneration++;
      try {
        todoOverlay?.dispose();
      } finally {
        todoOverlay = undefined;
        clearActiveRenderSession();
        uiCtx = undefined;
      }

      // Promote an already-running UI session instead of leaving the
      // ctx-less render pointer orphaned after foreground shutdown.
      if (s !== "") {
        const replacement = uiSessions.entries().next().value as
          [string, ExtensionUIContext] | undefined;
        if (replacement) {
          const [replacementId, replacementCtx] = replacement;
          setActiveRenderSession(replacementId);
          uiCtx = replacementCtx;
          const generation = ++lifecycleGeneration;
          await updateTodoOverlay(true, generation);
        }
      }
    }
  });

  // Reads getRenderState() at render time; do NOT call replayFromBranch here
  // (branch is stale — message_end runs after tool_execution_end).
  pi.on("tool_execution_end", async (event) => {
    if (event.toolName !== TOOL_NAME || event.isError) return;
    try {
      await updateTodoOverlay();
    } catch (e) {
      console.warn(
        `[todos] overlay refresh failed (will retry on next update): ${formatError(e)}`,
      );
    }
  });

  // Evaluate the lazy graph after startup while Pi's boot-time dependency
  // paths are still stable. Loads no widget; stays deferred until a
  // foreground session has visible tasks. unref avoids holding the process.
  prewarmOverlay(loadTodoOverlay);

  pi.on("agent_start", async () => {
    todoOverlay?.hideCompletedTasksFromPreviousTurn();
  });
}
