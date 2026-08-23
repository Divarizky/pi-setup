import type { BackendName, SubagentMode } from "./domain.ts"

export interface ExecutionPolicy {
  readonly mode: SubagentMode
  readonly backend: BackendName
  /** The Orca backend launches Pi inside its managed worktree. */
  readonly agent: "pi"
  readonly requiresWorktree: boolean
  readonly readOnly: boolean
}

/**
 * Public workflow policy for project subagents.
 *
 * Scout is intentionally a separate read-only Pi session in the parent's cwd.
 * Build is intentionally hosted by Orca, which owns the Pi terminal and
 * managed worktree. No backend fallback is allowed when a caller requests the
 * wrong combination.
 */
export function resolveExecutionPolicy(
  mode: SubagentMode,
  requestedBackend?: BackendName,
): ExecutionPolicy {
  if (mode === "scout") {
    if (requestedBackend !== undefined && requestedBackend !== "pi") {
      throw new Error("Scout only supports the Pi backend and never creates a worktree.")
    }
    return {
      mode,
      backend: "pi",
      agent: "pi",
      requiresWorktree: false,
      readOnly: true,
    }
  }

  if (requestedBackend !== undefined && requestedBackend !== "orca") {
    throw new Error("Build requires the Orca backend with a Pi agent and managed worktree.")
  }
  return {
    mode,
    backend: "orca",
    agent: "pi",
    requiresWorktree: true,
    readOnly: false,
  }
}
