import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileMatchesScope, MAX_VALIDATION_COMMANDS, normalizeValidationCommands } from "./delivery-validation.js";
import { decideScopeOverlap } from "./policy-decisions.js";
import type { TaskRecord } from "./task-state.js";
import type { TaskStore } from "./task-store.js";

// Any non-terminal state blocks another ship task in the same scope: a held
// candidate can still be integrated, so candidate_ready, recovery_required,
// integration_conflict, and interrupted all count as active.
const ACTIVE_SHIP_STATUSES: ReadonlySet<TaskRecord["status"]> = new Set([
  "preparing",
  "running",
  "candidate_ready",
  "recovery_required",
  "integrating",
  "integration_conflict",
  "interrupted",
]);

export interface ShipContract {
  repositoryPath: string;
  repositoryRoot: string;
  baseSha: string;
  targetBranch: string;
  writeScope: string[];
  validationCommands: string[];
}

export type ShipPreflightResult =
  | { ok: true; contract: ShipContract }
  | { ok: false; message: string };

interface ShipPreflightInput {
  pi: ExtensionAPI;
  cwd: string;
  store: Pick<TaskStore, "load">;
  writeScope?: unknown;
  validationCommands?: unknown;
  humanOverride: boolean;
  worktreeEnabled: boolean;
}

async function gitOutput(
  pi: ExtensionAPI,
  cwd: string,
  args: string[],
  timeout: number,
): Promise<string> {
  const result = await pi.exec("git", args, { cwd, timeout });
  if (result.killed || result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed (exit ${result.code})`);
  }
  return result.stdout.trim();
}

function normalizeScope(scope: string): string {
  const normalized = scope.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return normalized || ".";
}

export function normalizeWriteScope(value: unknown): string[] {
  if (!Array.isArray(value)) return ["**"];
  const scopes = value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map(normalizeScope);
  return scopes.length > 0 ? [...new Set(scopes)] : ["**"];
}

/**
 * Conservative overlap check: `true` unless roots are provably disjoint.
 * A glob wildcard can match beyond its literal prefix (e.g. `src/api*`
 * matches `src/api2` but not `src/ui`), so each side is matched against the
 * other as a literal path in both directions.
 */
export function scopesOverlap(left: string, right: string): boolean {
  const a = normalizeScope(left);
  const b = normalizeScope(right);
  if (a === "**" || b === "**" || a === "." || b === ".") return true;
  return fileMatchesScope(a, b) || fileMatchesScope(b, a);
}

export function anyScopeOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some(a => right.some(b => scopesOverlap(a, b)));
}

function overlappingTasks(tasks: Record<string, TaskRecord>, writeScope: string[]): TaskRecord[] {
  return Object.values(tasks).filter(task =>
    task.mode === "ship"
    && ACTIVE_SHIP_STATUSES.has(task.status)
    && anyScopeOverlap(writeScope, task.writeScope ?? ["**"]),
  );
}

/**
 * Read-only Git and durable-state preflight for a ship task.
 *
 * No command in this function mutates Git. The caller must run it before task
 * creation and before AgentManager.spawn, so every failure leaves the checkout
 * and the in-memory agent registry untouched.
 */
export async function preflightShipTask(input: ShipPreflightInput): Promise<ShipPreflightResult> {
  if (!input.worktreeEnabled) {
    return {
      ok: false,
      message: "Agent Control ship task requires worktree isolation, but worktree isolation is disabled for this project.",
    };
  }

  const writeScope = normalizeWriteScope(input.writeScope);
  const validationCommands = normalizeValidationCommands(input.validationCommands);
  if (validationCommands.length < 1 || validationCommands.length > MAX_VALIDATION_COMMANDS) {
    return {
      ok: false,
      message: `Agent Control ship preflight failed: provide 1-${MAX_VALIDATION_COMMANDS} validation_commands so success is based on execution evidence.`,
    };
  }
  let repositoryRoot: string;
  let baseSha: string;
  let targetBranch: string;
  let status: string;
  try {
    const inside = await gitOutput(input.pi, input.cwd, ["rev-parse", "--is-inside-work-tree"], 5000);
    if (inside !== "true") throw new Error("not inside a Git worktree");
    baseSha = await gitOutput(input.pi, input.cwd, ["rev-parse", "--verify", "HEAD^{commit}"], 5000);
    repositoryRoot = await gitOutput(input.pi, input.cwd, ["rev-parse", "--show-toplevel"], 5000);
    targetBranch = await gitOutput(input.pi, input.cwd, ["rev-parse", "--abbrev-ref", "HEAD"], 5000);
    status = await gitOutput(input.pi, input.cwd, ["status", "--porcelain", "--untracked-files=all"], 10000);
  } catch (error) {
    return {
      ok: false,
      message: `Agent Control ship preflight failed: Git repository must have a committed HEAD. ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (targetBranch === "HEAD") {
    return {
      ok: false,
      message: "Agent Control ship preflight failed: checkout is detached; switch to a target branch first.",
    };
  }

  if (status.length > 0) {
    return {
      ok: false,
      message: "Agent Control ship preflight failed: main checkout is dirty. Commit or remove staged, unstaged, and untracked changes first; no stash or WIP commit was created.",
    };
  }

  let snapshot: { tasks: Record<string, TaskRecord> };
  try {
    snapshot = input.store.load();
  } catch (error) {
    return {
      ok: false,
      message: `Agent Control ship preflight failed: durable task state could not be read. ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const overlap = overlappingTasks(snapshot.tasks, writeScope);
  const overlapDecision = decideScopeOverlap({ overlaps: overlap.length > 0, humanOverride: input.humanOverride });
  if (overlapDecision.decision === "blocked") {
    return {
      ok: false,
      message: `${overlapDecision.reason} Active task(s): ${overlap.map(task => task.id).join(", ")}.`,
    };
  }

  return {
    ok: true,
    contract: {
      repositoryPath: input.cwd,
      repositoryRoot,
      baseSha,
      targetBranch,
      writeScope,
      validationCommands,
    },
  };
}
