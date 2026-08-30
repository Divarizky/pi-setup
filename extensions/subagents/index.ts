/**
 * Subagents extension — spawn background Pi subagents.
 *
 * Original implementation, semantically equivalent to the reference repo but
 * written fresh. Supports in-process Pi and Orca-hosted Pi backends.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  getMarkdownTheme,
  ProjectTrustStore,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { deriveQuickAskTitle, isModelVisible } from "./src/quick-ask.ts";
import { ActionQueue } from "./src/action-queue.ts";
import { SubagentMonitor } from "./src/subagent-monitor.ts";
import { ApprovalGate, type ApprovalRequest } from "./src/approval.ts";
import {
  commitWorktree,
  createPullRequest,
  mergeWorktree,
  validateWorktree,
  pushWorktree,
} from "./src/delivery.ts";
import { JobPersistence } from "./src/persistence.ts";
import { ProvisioningStore } from "./src/provisioning.ts";
import { JobQueue } from "./src/job-queue.ts";
import { LeadAgentStore } from "./src/agent-lead.ts";
import {
  LeadHomeStore,
  isLeadHomeId,
  provisionLeadProjects,
  validateLeadProjectSource,
  type LeadProject,
  type LeadProjectInput,
} from "./src/lead-home.ts";
import { WorkflowEventQueue } from "./src/workflow/wake-queue.ts";
import { LeadAgentProposalStore } from "./src/workflow/lead-agent-proposals.ts";
import { OrchestrationCoordinator } from "./src/workflow/coordinator.ts";
import {
  LEAD_AGENT_EVENT_TYPES,
  parseLeadAgentEvent,
  type LeadAgentEvent,
} from "./src/workflow/orchestration.ts";
import { TaskLedger } from "./src/workflow/task-ledger.ts";
import { LeadAgentInbox } from "./src/workflow/lead-agent-inbox.ts";
import { DetachedWorktreeStore } from "./src/detached-worktrees.ts";
import type {
  WorkflowTaskRole,
  WorkflowTaskStatus,
} from "./src/workflow/state.ts";
import { ConcurrencyLimitError } from "./src/domain.ts";
import {
  BACKEND_NAMES,
  formatElapsed,
  isSubagentBooting,
  latestText,
  REASONING_EFFORTS,
  SUBAGENT_MODES,
  type BackendName,
  type LeadAgentId,
  type SubagentJobId,
  type WorkflowTaskId,
  type ReasoningEffort,
  type SubagentInitialTerminal,
  type SpawnTask,
  type SubagentMode,
  type SubagentSnapshot,
} from "./src/domain.ts";
import {
  formatActivityStatus,
  formatContextUtilization,
} from "./src/format.ts";
import {
  SubagentManager,
  type SubagentManagerShape,
  type SubagentReadModel,
} from "./src/manager.ts";
import {
  buildSubagentResultMessage,
  buildSubagentSpawnResult,
  formatSubagentReport,
  SUBAGENT_ACTION_CONFIRM_TOOL_DESCRIPTION,
  SUBAGENT_ACTION_LIST_TOOL_DESCRIPTION,
  SUBAGENT_ACTION_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CANCEL_TOOL_DESCRIPTION,
  SUBAGENT_DELIVER_PARAMETER_DESCRIPTIONS,
  SUBAGENT_DELIVER_TOOL_DESCRIPTION,
  SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CHECK_TOOL_DESCRIPTION,
  SUBAGENT_DELETE_PARAMETER_DESCRIPTIONS,
  SUBAGENT_DELETE_TOOL_DESCRIPTION,
  SUBAGENT_LIST_TOOL_DESCRIPTION,
  SUBAGENT_APPROVE_PARAMETER_DESCRIPTIONS,
  SUBAGENT_APPROVE_TOOL_DESCRIPTION,
  SUBAGENT_RETRY_PARAMETER_DESCRIPTIONS,
  SUBAGENT_RETRY_TOOL_DESCRIPTION,
  SUBAGENT_LEAD_AGENT_CREATE_TOOL_DESCRIPTION,
  SUBAGENT_LEAD_AGENT_SEND_TOOL_DESCRIPTION,
  SUBAGENT_LEAD_AGENT_STOP_TOOL_DESCRIPTION,
  SUBAGENT_LEAD_AGENT_EVENT_TOOL_DESCRIPTION,
  SUBAGENT_LEAD_AGENT_EVENT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_LEAD_AGENT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_RETIRE_PARAMETER_DESCRIPTIONS,
  SUBAGENT_RETIRE_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import {
  SpawnClaimRegistry,
  createSpawnFingerprint,
} from "./src/spawn-claims.ts";
import { resolveExecutionPolicy } from "./src/execution-policy.ts";
import {
  createSubagentRuntime,
  runTool,
  type SubagentRuntime,
} from "./src/runtime.ts";
import {
  assertBranchAvailable,
  CONVENTIONAL_BRANCH_TYPES,
  createBranchName,
  createJobId,
  createLeadJobId,
  createSubagentWorktree,
  deleteSubagentBranch,
  removeSubagentWorktree,
  resolveRepoRoot,
  type ConventionalBranchType,
} from "./src/worktree.ts";
import { OrcaCli, samePath } from "./src/transports/orca-cli.ts";
import {
  acquireStateLease,
  disposeWithStateLease,
  type StateLease,
} from "./src/state-lock.ts";
import { GlobalCapacityPool, type CapacityLease } from "./src/capacity-pool.ts";
import {
  activeCallerIdentity,
  activeParentStateRoot,
  createParentStateRoot,
} from "./src/parent-state.ts";
import { validateChildShellCommand } from "./src/shell-policy.ts";
import { formatReadinessReport, runReadinessDoctor } from "./src/readiness.ts";
export { isProtectedShellCommand } from "./src/shell-policy.ts";
import {
  resolveManagedLeadHome,
  resolveManagedSessionFile,
} from "./src/session-path.ts";
import {
  confirmSubagentDeletion,
  openSubagentPicker,
  openSubagentTakeover,
} from "./src/ui/takeover.ts";
import {
  invalidateAgentWidget,
  renderAgentWidget,
  type WidgetQueuedJob,
} from "./src/ui/agent-widget.ts";
import { invalidateFleetView, renderFleetView } from "./src/ui/fleet-view.ts";
import { notifySubagentCompletion } from "./src/ui/completion-notification.ts";

const SUBAGENT_OUTPUT_MAX_BYTES = 24 * 1024;
const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;

const THINKING_LEVELS: ReadonlyArray<ReasoningEffort> = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function parseThinkingLevel(
  value: string | number | undefined,
): ReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    return THINKING_LEVELS[value] ?? undefined;
  }
  const trimmed = String(value).trim().toLowerCase();
  if (THINKING_LEVELS.includes(trimmed as ReasoningEffort))
    return trimmed as ReasoningEffort;
  return undefined;
}

interface PreparedOrcaWorktree {
  readonly worktree: {
    readonly jobId: string;
    readonly repoRoot: string;
    readonly path: string;
    readonly branch: string;
  };
  readonly initialTerminal: SubagentInitialTerminal;
}

interface QuickAskResultData {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentSnapshot["status"];
  readonly errorText?: string;
  readonly prompt: string;
  readonly answer: string;
  readonly sessionFilePath?: string;
}

function describeSubagent(snap: SubagentSnapshot) {
  const details = [
    `${snap.meta.role === "lead" ? "agent-lead" : "subagent"}/${snap.backend}: ${snap.meta.modelLabel ?? "?"}`,
    snap.meta.worktree?.branch,
    snap.backend === "orca" && snap.meta.nativeTerminalHandle
      ? `terminal ${snap.meta.nativeTerminalHandle}`
      : undefined,
    snap.backend === "orca" && snap.meta.nativeTabId
      ? `tab ${snap.meta.nativeTabId}`
      : undefined,
    formatContextUtilization(snap.usage),
    formatElapsed(snap),
    snap.cwd,
  ].filter(Boolean);
  return `${snap.id} [${snap.status}] "${snap.title}" (${details.join(", ")})`;
}

function truncatedOutput(
  snap: SubagentSnapshot,
  maxBytes = SUBAGENT_OUTPUT_MAX_BYTES,
): string {
  const output = snap.finalText || "(no output)";
  const truncation = truncateHead(output, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(600, DEFAULT_MAX_LINES),
  });
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. Full transcript in session file: ${snap.meta.sessionFilePath ?? "?"}]`;
  }
  return text;
}

function resolveTrustedChildCwd(options: {
  parentCwd: string;
  requestedCwd: string;
  parentTrusted: boolean;
}) {
  let parentCwd: string;
  let childCwd: string;
  try {
    parentCwd = fs.realpathSync(options.parentCwd);
    childCwd = fs.realpathSync(options.requestedCwd);
  } catch {
    throw new Error(
      `working_dir is not a resolvable directory: ${options.requestedCwd}`,
    );
  }

  const relative = path.relative(parentCwd, childCwd);
  const insideParent =
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative));
  if (insideParent && options.parentTrusted) {
    return { cwd: childCwd, projectTrusted: true };
  }

  try {
    const trustStore = new ProjectTrustStore(getAgentDir());
    if (trustStore.get(childCwd) === true) {
      return { cwd: childCwd, projectTrusted: true };
    }
  } catch {
    // Treat unreadable trust state as untrusted.
  }
  throw new Error(
    `working_dir must be inside the current project or explicitly trusted: ${childCwd}`,
  );
}

export default function activate(pi: ExtensionAPI) {
  let runtime: SubagentRuntime | undefined;
  let managerPromise: Promise<SubagentManagerShape> | undefined;
  let stateLease: StateLease | undefined;
  let activeManager: SubagentManagerShape | undefined;
  let sessionContext: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubStatus: (() => void) | undefined;
  const resultDelivery = createDeferredResultDelivery<SubagentSnapshot>();
  const approvalGate = new ApprovalGate();
  let persistence: JobPersistence;
  let provisioning: ProvisioningStore;
  let jobQueue: JobQueue;
  let leadAgentStore: LeadAgentStore;
  let leadAgentProposalStore: LeadAgentProposalStore;
  let leadAgentInbox: LeadAgentInbox;
  let detachedWorktrees: DetachedWorktreeStore;
  let actionQueue: ActionQueue;
  let workflowQueue: WorkflowEventQueue;
  let taskLedger: TaskLedger;
  let subagentMonitor: SubagentMonitor;
  let stateRoot: string | undefined;
  let parentId: string | undefined;
  let storesReady = false;
  const capacityPool = new GlobalCapacityPool(
    path.join(getAgentDir(), "workspace", "state", "pool"),
    4,
  );
  const capacityLeases = new Map<string, CapacityLease>();
  let sessionReconcileTimer: ReturnType<typeof setInterval> | undefined;
  let uiRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let hasBuildLeadInSession = false;
  const orcaCli = new OrcaCli();
  const pendingSettled: Array<{ snap: SubagentSnapshot; consumed: boolean }> =
    [];
  const stoppingLeadIds = new Set<string>();
  /**
   * Claims protect the window before manager.spawn() registers a live session.
   * Orca's agent-first worktree creation is an external side effect, so a
   * duplicate tool call during that window must return the original job id.
   */
  const spawnClaims = new SpawnClaimRegistry();
  const releaseSpawnClaim = (jobId: SubagentJobId) =>
    spawnClaims.release(jobId);
  /** Destructive operations suppress late persistence/monitor callbacks. */
  const deletingJobs = new Set<string>();
  const leadOperationTails = new Map<string, Promise<void>>();
  const acquireLeadHomeLock = async (
    leadAgentId: string,
  ): Promise<(() => Promise<void>) | undefined> => {
    const homePath = leadAgentStore?.get(leadAgentId)?.homePath;
    if (!homePath) return undefined;
    const lockPath = path.join(homePath, ".lead-lifecycle-lock");
    for (;;) {
      try {
        await fs.promises.mkdir(lockPath);
        await fs.promises.writeFile(
          path.join(lockPath, "owner"),
          `${process.pid}\n`,
          "utf8",
        );
        return async () => {
          await fs.promises.rm(lockPath, { recursive: true, force: true });
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stale = false;
        try {
          const stat = await fs.promises.stat(lockPath);
          const old = Date.now() - stat.mtimeMs > 10 * 60_000;
          try {
            const owner = Number.parseInt(
              await fs.promises.readFile(path.join(lockPath, "owner"), "utf8"),
              10,
            );
            if (Number.isSafeInteger(owner) && owner > 0) {
              try {
                process.kill(owner, 0);
              } catch {
                stale = old;
              }
            } else {
              stale = old;
            }
          } catch (error) {
            stale = (error as NodeJS.ErrnoException).code === "ENOENT" && old;
          }
        } catch {
          /* incomplete or disappearing lock; retry without deleting a fresh owner */
        }
        if (stale) {
          await fs.promises.rm(lockPath, { recursive: true, force: true });
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  };

  const withLeadLifecycleLock = async <A>(
    leadAgentId: string,
    operation: () => Promise<A>,
  ): Promise<A> => {
    const previous = leadOperationTails.get(leadAgentId) ?? Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    leadOperationTails.set(leadAgentId, current);
    await previous;
    const releaseHomeLock = await acquireLeadHomeLock(leadAgentId);
    try {
      return await operation();
    } finally {
      await releaseHomeLock?.();
      unlock();
      if (leadOperationTails.get(leadAgentId) === current)
        leadOperationTails.delete(leadAgentId);
    }
  };

  const ensureStateStores = (ctx?: ExtensionContext) => {
    if (storesReady) return;
    const current = ctx ?? sessionContext;
    if (!current)
      throw new Error("Subagent state is unavailable before session_start.");
    stateRoot =
      activeParentStateRoot() ??
      createParentStateRoot(
        getAgentDir(),
        current.sessionManager.getSessionId(),
      );
    parentId = createHash("sha256")
      .update(stateRoot)
      .digest("hex")
      .slice(0, 24);
    persistence = new JobPersistence(stateRoot);
    provisioning = new ProvisioningStore(stateRoot);
    jobQueue = new JobQueue(stateRoot);
    leadAgentStore = new LeadAgentStore(stateRoot);
    leadAgentProposalStore = new LeadAgentProposalStore(stateRoot);
    leadAgentInbox = new LeadAgentInbox(stateRoot);
    detachedWorktrees = new DetachedWorktreeStore(stateRoot);
    actionQueue = new ActionQueue(stateRoot);
    workflowQueue = new WorkflowEventQueue(stateRoot);
    taskLedger = new TaskLedger(stateRoot);
    subagentMonitor = new SubagentMonitor(actionQueue);
    storesReady = true;
    orchestrationCoordinator = new OrchestrationCoordinator(
      taskLedger,
      handleLeadAgentEvent,
    );
  };

  const waitForCapacity = async (jobId: string, signal?: AbortSignal) => {
    if (!parentId)
      throw new Error(
        "Subagent capacity owner is unavailable before session_start.",
      );
    while (true) {
      if (signal?.aborted)
        throw new Error(
          "Subagent spawn aborted while waiting for global capacity.",
        );
      const lease = await capacityPool.tryAcquire(jobId, parentId);
      if (lease) {
        capacityLeases.set(jobId, lease);
        return lease;
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(
            new Error(
              "Subagent spawn aborted while waiting for global capacity.",
            ),
          );
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, 250);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
  };

  const releaseCapacity = async (jobId: string) => {
    const lease = capacityLeases.get(jobId);
    if (!lease) return;
    capacityLeases.delete(jobId);
    await lease.release().catch(() => {});
  };

  const createOrcaManagedWorktree = async (options: {
    readonly sourceDir: string;
    readonly jobId: string;
    readonly branchName: string;
    readonly title: string;
    readonly prompt: string;
    readonly mode: SubagentMode;
  }): Promise<PreparedOrcaWorktree> => {
    // Fail closed before any external mutation when the Orca runtime is down.
    await orcaCli.assertReady();
    const repoRoot = await resolveRepoRoot(options.sourceDir);
    await assertBranchAvailable(repoRoot, options.branchName);
    const created = await orcaCli.createPiWorktree({
      repoPath: repoRoot,
      name: options.branchName,
      title: options.title,
      prompt: options.prompt,
    });
    return {
      worktree: {
        jobId: options.jobId,
        repoRoot,
        path: created.path,
        branch: created.branch,
      },
      initialTerminal: created.terminal,
    };
  };

  const prepareOrcaTask = async (task: SpawnTask): Promise<SpawnTask> => {
    if (task.worktree && task.initialTerminal) return task;
    if (!task.jobId)
      throw new Error("Orca subagent requires a durable job id.");
    const prepared = await createOrcaManagedWorktree({
      sourceDir: task.cwd,
      jobId: task.jobId,
      branchName: task.branchName ?? createBranchName(task.title),
      title: task.title,
      prompt: task.prompt,
      mode: task.mode ?? "build",
    });
    return {
      ...task,
      cwd: prepared.worktree.path,
      worktree: prepared.worktree,
      initialTerminal: prepared.initialTerminal,
    };
  };

  const cleanupManagedWorktree = async (
    backend: BackendName,
    worktree: PreparedOrcaWorktree["worktree"] | undefined,
    nativeWorktreeId?: string,
    force = false,
  ) => {
    if (backend === "orca" && nativeWorktreeId) {
      if (!worktree)
        throw new Error(
          "Refusing Orca cleanup without recorded worktree metadata.",
        );
      const shown = await orcaCli.showWorktree(nativeWorktreeId);
      if (
        shown.id !== nativeWorktreeId ||
        !shown.path ||
        !samePath(shown.path, worktree.path)
      ) {
        throw new Error(
          `Refusing Orca cleanup: native worktree identity/path does not match recorded job metadata (${nativeWorktreeId}).`,
        );
      }
      await orcaCli.removeWorktree(nativeWorktreeId, { force });
      if (force) await deleteSubagentBranch(worktree.repoRoot, worktree.branch);
      return;
    }
    if (!worktree) return;
    // If Orca's native identity is gone, fall back to the same verified Git
    // path/branch checks used by the Pi backend instead of deleting unscoped data.
    await removeSubagentWorktree(worktree, { force, deleteBranch: force });
  };

  const persistSnapshot = async (
    snap: SubagentSnapshot,
    event: string,
    clearWorktree = false,
  ): Promise<boolean> => {
    if (deletingJobs.has(snap.id)) return false;
    try {
      await persistence.upsert({
        jobId: snap.id,
        origin: snap.origin,
        backend: snap.backend,
        role: snap.meta.role,
        ...(snap.meta.leadAgentId === undefined
          ? {}
          : { leadAgentId: snap.meta.leadAgentId }),
        ...(snap.meta.sessionFilePath === undefined
          ? {}
          : { sessionFilePath: snap.meta.sessionFilePath }),
        ...(snap.meta.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: snap.meta.nativeSessionId }),
        ...(snap.meta.nativeTerminalHandle === undefined
          ? {}
          : { nativeTerminalHandle: snap.meta.nativeTerminalHandle }),
        ...(snap.meta.nativeWorktreeId === undefined
          ? {}
          : { nativeWorktreeId: snap.meta.nativeWorktreeId }),
        ...(snap.meta.nativeTabId === undefined
          ? {}
          : { nativeTabId: snap.meta.nativeTabId }),
        ...(snap.meta.nativePaneKey === undefined
          ? {}
          : { nativePaneKey: snap.meta.nativePaneKey }),
        ...(snap.meta.nativeLaunchToken === undefined
          ? {}
          : { nativeLaunchToken: snap.meta.nativeLaunchToken }),
        ...(snap.meta.parentStateRoot === undefined
          ? {}
          : { parentStateRoot: snap.meta.parentStateRoot }),
        title: snap.title,
        mode: snap.meta.mode ?? "build",
        cwd: snap.cwd,
        status: snap.status,
        createdAt: snap.createdAt,
        settledAt: snap.settledAt,
        worktreePath: clearWorktree ? undefined : snap.meta.worktree?.path,
        branch: clearWorktree ? undefined : snap.meta.worktree?.branch,
        repoRoot: clearWorktree ? undefined : snap.meta.worktree?.repoRoot,
        errorText: snap.errorText,
        report: snap.report,
        finalText: snap.finalText,
      });
      await persistence.appendEvent({ at: Date.now(), jobId: snap.id, event });
      if (snap.meta.leadAgentId !== undefined) {
        const owner = leadAgentStore.get(snap.meta.leadAgentId);
        const ownerHomePath = owner?.homePath;
        const ownerStateRoot = ownerHomePath
          ? path.join(ownerHomePath, "state")
          : undefined;
        if (
          ownerHomePath &&
          ownerStateRoot &&
          !isLeadHomeRetired(ownerHomePath, snap.meta.leadAgentId) &&
          fs.existsSync(ownerHomePath) &&
          path.resolve(ownerStateRoot) !== path.resolve(persistence.rootDir)
        ) {
          await new JobPersistence(ownerStateRoot).upsert({
            jobId: snap.id,
            backend: snap.backend,
            role: snap.meta.role ?? "worker",
            leadAgentId: snap.meta.leadAgentId,
            sessionFilePath: snap.meta.sessionFilePath,
            nativeSessionId: snap.meta.nativeSessionId,
            nativeTerminalHandle: snap.meta.nativeTerminalHandle,
            nativeWorktreeId: snap.meta.nativeWorktreeId,
            nativeTabId: snap.meta.nativeTabId,
            nativePaneKey: snap.meta.nativePaneKey,
            nativeLaunchToken: snap.meta.nativeLaunchToken,
            parentStateRoot: snap.meta.parentStateRoot ?? stateRoot,
            title: snap.title,
            mode: snap.meta.mode ?? "build",
            cwd: snap.cwd,
            status: snap.status,
            queued: ["queued", "blocked"].includes(
              jobQueue.get(snap.id)?.status ?? "",
            ),
            createdAt: snap.createdAt,
            settledAt: snap.settledAt,
            worktreePath: clearWorktree ? undefined : snap.meta.worktree?.path,
            branch: clearWorktree ? undefined : snap.meta.worktree?.branch,
            repoRoot: clearWorktree ? undefined : snap.meta.worktree?.repoRoot,
            errorText: snap.errorText,
            report: snap.report,
            finalText: snap.finalText,
          });
        }
      }
      return true;
    } catch (error) {
      ui?.notify(
        `Subagent state persistence failed: ${String(error)}`,
        "warning",
      );
      return false;
    }
  };

  const removeLeadOwnedMirror = async (
    jobId: string,
    leadAgentId: string | undefined,
  ) => {
    if (!leadAgentId) return;
    const owner = leadAgentStore.get(leadAgentId);
    if (!owner?.homePath) return;
    const ownerStateRoot = path.join(owner.homePath, "state");
    if (path.resolve(ownerStateRoot) === path.resolve(persistence.rootDir))
      return;
    await new JobPersistence(ownerStateRoot).deleteJob(jobId);
  };

  const executeApprovedDelivery = async (
    manager: SubagentManagerShape,
    request: ApprovalRequest,
  ) => {
    const snap = await runTool(getRuntime(), manager.get(request.jobId));
    if (!snap) throw new Error(`Unknown subagent id: ${request.jobId}`);
    if (snap.status === "running")
      throw new Error("Cannot deliver a running subagent.");
    if (snap.meta.mode !== "build" || !snap.meta.worktree) {
      throw new Error(
        "Only settled build subagents with a worktree can be delivered.",
      );
    }
    const worktree = snap.meta.worktree;
    let detail = "";
    approvalGate.begin(request.id);
    try {
      // Persist the executing intent before any external side effect. A crash
      // after this point restores an executing approval and refuses an unsafe
      // blind retry instead of replaying commit/merge/push/PR.
      await persistApprovals();
    } catch (error) {
      approvalGate.fail(request.id);
      throw error;
    }
    try {
      if (request.operation === "review") {
        const validation = await validateWorktree(worktree);
        detail = `reviewed ${validation.changedFiles.length} changed path(s); checks: ${validation.checks.join(", ")}`;
      } else if (request.operation === "commit") {
        const validation = await commitWorktree(worktree, snap.title);
        detail = `committed ${validation.changedFiles.length} changed path(s)`;
      } else if (request.operation === "merge") {
        await mergeWorktree(worktree, worktree.repoRoot, snap.title);
        detail = `merged ${worktree.branch} into the coordinator checkout`;
      } else if (request.operation === "push") {
        await pushWorktree(worktree);
        detail = `pushed ${worktree.branch} to origin`;
      } else if (request.operation === "pr") {
        detail = await createPullRequest(
          worktree,
          snap.title,
          `Automated delivery for subagent ${snap.id}.\\n\\n${latestText(snap).slice(0, 12_000)}`,
        );
      } else {
        throw new Error(
          `Operation ${request.operation} is not handled by the delivery pipeline.`,
        );
      }
      const consumed = approvalGate.complete(request.id);
      await persistApprovals();
      await persistSnapshot(snap, `delivered:${request.operation}`);
      return { consumed, detail };
    } catch (error) {
      approvalGate.fail(request.id);
      try {
        await persistApprovals();
      } catch {
        /* preserve the original delivery failure */
      }
      throw error;
    }
  };

  const deletePiSessionFile = async (sessionFilePath: string) => {
    const managedRoots = [
      path.resolve(getAgentDir(), "sessions"),
      path.resolve(stateRoot!, "leads"),
    ];
    const target = path.resolve(sessionFilePath);
    const managedRoot = managedRoots.find((root) => {
      const relative = path.relative(root, target);
      return (
        relative !== "" &&
        !relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative)
      );
    });
    if (!managedRoot) {
      throw new Error(
        "Refusing to delete a Pi session outside the managed session directories.",
      );
    }
    try {
      await fs.promises.unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };

  const retiredLeadMarkerPath = (homePath: string, leadAgentId: string) =>
    path.join(
      path.dirname(path.resolve(homePath)),
      ".retired",
      `${leadAgentId}.json`,
    );
  const markLeadHomeRetired = async (
    homePath: string,
    leadAgentId: string,
    jobId?: string,
  ) => {
    const marker = retiredLeadMarkerPath(homePath, leadAgentId);
    await fs.promises.mkdir(path.dirname(marker), { recursive: true });
    const temporary = `${marker}.tmp-${process.pid}`;
    await fs.promises.writeFile(
      temporary,
      `${JSON.stringify({ leadAgentId, jobId, retiredAt: Date.now() })}\n`,
      "utf8",
    );
    await fs.promises.rename(temporary, marker);
  };
  const clearLeadHomeRetiredMarker = async (
    homePath: string,
    leadAgentId: string,
  ) => {
    await fs.promises.rm(retiredLeadMarkerPath(homePath, leadAgentId), {
      force: true,
    });
  };
  const isLeadHomeRetired = (homePath: string, leadAgentId: string) =>
    fs.existsSync(retiredLeadMarkerPath(homePath, leadAgentId));

  const deleteLeadHome = async (homePath: string) => {
    const leadsRoot = path.resolve(stateRoot!, "leads");
    const target = path.resolve(homePath);
    const relative = path.relative(leadsRoot, target);
    if (
      relative === "" ||
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        "Refusing to delete an Agent Lead home outside the managed lead directory.",
      );
    }
    await fs.promises.rm(target, { recursive: true, force: true });
  };

  /**
   * Remove a settled job's dashboard/session metadata after its Pi session file
   * was deleted externally. Build worktrees are deliberately preserved for
   * review, delivery, or later retirement.
   */
  const cleanDeleteSubagentMetadata = async (
    manager: SubagentManagerShape,
    id: string,
  ) => {
    if (deletingJobs.has(id)) return false;
    deletingJobs.add(id);
    try {
      const snap = await runTool(getRuntime(), manager.get(id));
      const durable = (await persistence.load()).find(
        (job) => job.jobId === id,
      );
      const queued = jobQueue.get(id);
      const leadAgents = leadAgentStore
        .list()
        .filter((item) => item.jobId === id);
      if (!snap && !durable && !queued && leadAgents.length === 0) return false;
      if (snap?.status === "running" || snap?.restarting) return false;

      const detachedWorktree =
        snap?.meta.worktree ??
        queued?.task.worktree ??
        (durable?.worktreePath && durable.branch && durable.repoRoot
          ? {
              jobId: id,
              path: durable.worktreePath,
              branch: durable.branch,
              repoRoot: durable.repoRoot,
            }
          : leadAgents.find(
                (item) => item.worktreePath && item.branch && item.repoRoot,
              )
            ? (() => {
                const leadAgent = leadAgents.find(
                  (item) => item.worktreePath && item.branch && item.repoRoot,
                )!;
                return {
                  jobId: id,
                  path: leadAgent.worktreePath!,
                  branch: leadAgent.branch!,
                  repoRoot: leadAgent.repoRoot!,
                };
              })()
            : undefined);
      const detachedBackend =
        snap?.meta.backend ??
        durable?.backend ??
        queued?.backend ??
        leadAgents[0]?.backend;
      const detachedMode =
        snap?.meta.mode ?? durable?.mode ?? queued?.mode ?? leadAgents[0]?.mode;
      if (detachedWorktree && detachedMode === "build" && detachedBackend) {
        await detachedWorktrees.add({
          jobId: id,
          title:
            snap?.title ??
            durable?.title ??
            queued?.title ??
            leadAgents[0]?.title ??
            id,
          backend: detachedBackend,
          path: detachedWorktree.path,
          branch: detachedWorktree.branch,
          repoRoot: detachedWorktree.repoRoot,
          ...((snap?.meta.nativeWorktreeId ??
          durable?.nativeWorktreeId ??
          queued?.task.initialTerminal?.worktreeId)
            ? {
                nativeWorktreeId:
                  snap?.meta.nativeWorktreeId ??
                  durable?.nativeWorktreeId ??
                  queued?.task.initialTerminal?.worktreeId,
              }
            : {}),
          ...(leadAgents[0] ? { leadAgentId: leadAgents[0].leadAgentId } : {}),
          detachedAt: Date.now(),
        });
      }

      await subagentMonitor.forgetJob(id);
      resultDelivery.consume([id]);
      for (let index = pendingSettled.length - 1; index >= 0; index--) {
        if (pendingSettled[index]?.snap.id === id)
          pendingSettled.splice(index, 1);
      }
      const sessionFiles = new Set<string>([
        ...(snap?.meta.sessionFilePath ? [snap.meta.sessionFilePath] : []),
        ...(durable?.sessionFilePath ? [durable.sessionFilePath] : []),
        ...(queued?.task.sessionFilePath ? [queued.task.sessionFilePath] : []),
        ...leadAgents.flatMap((item) =>
          item.sessionFilePath ? [item.sessionFilePath] : [],
        ),
      ]);
      for (const sessionFile of sessionFiles)
        await deletePiSessionFile(sessionFile);
      for (const leadAgent of leadAgents) {
        if (leadAgent.homePath) await deleteLeadHome(leadAgent.homePath);
      }
      await fs.promises.rm(path.join(stateRoot!, "orca-inbox", id), {
        recursive: true,
        force: true,
      });
      await runTool(getRuntime(), manager.forget(id));

      await provisioning.remove(id);
      const proposalIds = new Set<string>();
      for (const leadAgent of leadAgents) {
        for (const proposalId of await leadAgentProposalStore.removeUndispatchedByLeadAgentId(
          leadAgent.leadAgentId,
        )) {
          proposalIds.add(proposalId);
        }
      }
      await leadAgentStore.removeByJobId(id);
      approvalGate.forgetJob(id);
      await persistApprovals();
      await jobQueue.remove(id);
      await workflowQueue.removeTask(id);
      await taskLedger.remove(id);
      for (const proposalId of proposalIds) {
        await workflowQueue.removeTask(proposalId);
        await taskLedger.remove(proposalId);
      }
      await persistence.deleteJob(id);
      await removeLeadOwnedMirror(
        id,
        durable?.leadAgentId ??
          queued?.task.leadAgentId ??
          snap?.meta.leadAgentId,
      );
      return true;
    } finally {
      deletingJobs.delete(id);
    }
  };

  /**
   * Explicit user deletion is destructive and cascades through the Thread,
   * session, durable records, and managed worktree. Recovery paths must never
   * call this function; a missing terminal is not user intent to delete.
   */
  const deleteSubagentCompletely = async (
    manager: SubagentManagerShape,
    id: string,
    options: { readonly preserveApproval?: boolean } = {},
  ) => {
    if (deletingJobs.has(id)) return true;
    deletingJobs.add(id);
    try {
      const snap = await runTool(getRuntime(), manager.get(id));
      const durable = (await persistence.load()).find(
        (job) => job.jobId === id,
      );
      const leadAgents = leadAgentStore
        .list()
        .filter((item) => item.jobId === id);
      const queued = jobQueue.get(id);
      const approvals = approvalGate.list().filter((item) => item.jobId === id);
      const actions = actionQueue
        .list()
        .filter((item) => item.event.jobId === id);
      if (
        !snap &&
        !durable &&
        !queued &&
        leadAgents.length === 0 &&
        approvals.length === 0 &&
        actions.length === 0
      )
        return false;

      // Stop producers first. This also prevents monitor/status callbacks from
      // writing new action records while the cascade is in progress.
      await subagentMonitor.forgetJob(id);
      resultDelivery.consume([id]);
      for (let index = pendingSettled.length - 1; index >= 0; index--) {
        if (pendingSettled[index]?.snap.id === id)
          pendingSettled.splice(index, 1);
      }
      if (snap?.status === "running" || snap?.restarting)
        await runTool(getRuntime(), manager.cancel([id]));
      if (snap) await runTool(getRuntime(), manager.closeSession(id));

      const current = (await runTool(getRuntime(), manager.get(id))) ?? snap;
      const backend =
        current?.backend ??
        durable?.backend ??
        queued?.backend ??
        leadAgents[0]?.backend ??
        "pi";
      const worktree =
        current?.meta.worktree ??
        queued?.task.worktree ??
        (durable?.worktreePath && durable.branch && durable.repoRoot
          ? {
              jobId: id,
              path: durable.worktreePath,
              branch: durable.branch,
              repoRoot: durable.repoRoot,
            }
          : leadAgents.find(
                (item) => item.worktreePath && item.branch && item.repoRoot,
              )
            ? (() => {
                const leadAgent = leadAgents.find(
                  (item) => item.worktreePath && item.branch && item.repoRoot,
                )!;
                return {
                  jobId: id,
                  path: leadAgent.worktreePath!,
                  branch: leadAgent.branch!,
                  repoRoot: leadAgent.repoRoot!,
                };
              })()
            : undefined);
      const nativeWorktreeId =
        current?.meta.nativeWorktreeId ??
        durable?.nativeWorktreeId ??
        queued?.task.initialTerminal?.worktreeId;
      const sessionFiles = new Set<string>([
        ...(current?.meta.sessionFilePath
          ? [current.meta.sessionFilePath]
          : []),
        ...(durable?.sessionFilePath ? [durable.sessionFilePath] : []),
        ...(queued?.task.sessionFilePath ? [queued.task.sessionFilePath] : []),
        ...leadAgents.flatMap((item) =>
          item.sessionFilePath ? [item.sessionFilePath] : [],
        ),
      ]);

      // Remove external resources before dropping the snapshot, so a failed
      // cleanup leaves an actionable visible job that can be retried.
      try {
        await cleanupManagedWorktree(backend, worktree, nativeWorktreeId, true);
      } catch (error) {
        if (snap) {
          const recovered = await runTool(
            getRuntime(),
            manager.markRecoveryRequired(
              id,
              `Cleanup verification failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
          if (recovered)
            await persistSnapshot(recovered, "cleanup-recovery-required");
        }
        throw error;
      }
      for (const sessionFile of sessionFiles)
        await deletePiSessionFile(sessionFile);
      for (const leadAgent of leadAgents) {
        if (leadAgent.homePath) await deleteLeadHome(leadAgent.homePath);
      }
      await fs.promises.rm(path.join(stateRoot!, "orca-inbox", id), {
        recursive: true,
        force: true,
      });
      await provisioning.remove(id);
      await detachedWorktrees.remove(id);
      await runTool(getRuntime(), manager.forget(id));
      await leadAgentStore.removeByJobId(id);
      if (!options.preserveApproval) approvalGate.forgetJob(id);
      await persistApprovals();
      await jobQueue.remove(id);
      await workflowQueue.removeTask(id);
      await taskLedger.remove(id);
      await persistence.deleteJob(id);
      await removeLeadOwnedMirror(
        id,
        durable?.leadAgentId ??
          queued?.task.leadAgentId ??
          snap?.meta.leadAgentId,
      );
      return true;
    } finally {
      deletingJobs.delete(id);
    }
  };

  const executeLeadRetirement = async (
    manager: SubagentManagerShape,
    request: ApprovalRequest,
  ) => {
    const leadAgent = leadAgentStore
      .list()
      .find((lead) => lead.jobId === request.jobId);
    if (!leadAgent?.homePath) {
      const retiredRoot = path.join(stateRoot!, "leads", ".retired");
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(retiredRoot, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try {
          const marker = JSON.parse(
            fs.readFileSync(path.join(retiredRoot, entry.name), "utf8"),
          ) as { jobId?: unknown; leadAgentId?: unknown };
          const homeGone =
            typeof marker.leadAgentId === "string" &&
            !fs.existsSync(path.join(stateRoot!, "leads", marker.leadAgentId));
          if (marker.jobId === request.jobId && homeGone) {
            const current = approvalGate.get(request.id);
            if (current?.status === "approved") approvalGate.begin(request.id);
            if (approvalGate.get(request.id)?.status === "executing")
              approvalGate.complete(request.id);
            await persistApprovals();
            return;
          }
        } catch {
          /* malformed marker is not proof of completed retirement */
        }
      }
      throw new Error(
        `Agent Lead home is unavailable for retirement: ${request.jobId}`,
      );
    }
    return await withLeadLifecycleLock(leadAgent.leadAgentId, async () => {
      const home = await resolveManagedLeadHome(
        leadAgent.homePath,
        path.join(stateRoot!, "leads"),
      );
      if (!home)
        throw new Error(`Agent Lead home is missing: ${leadAgent.homePath}`);
      const current = await runTool(getRuntime(), manager.get(request.jobId));
      if (current?.status === "running" || current?.restarting)
        throw new Error("Cannot retire a running Agent Lead.");

      const homeStateRoot = path.join(home, "state");
      const homeJobs = await new JobPersistence(homeStateRoot).load();
      const homeProvisioning = new ProvisioningStore(homeStateRoot);
      await homeProvisioning.restore();
      const parentJobs = await persistence.load();
      const parentQueued = jobQueue.list();
      const activeWorkers = new Set<string>();
      for (const record of [
        ...homeProvisioning.list(),
        ...provisioning.list().filter((item) => {
          const relative = path.relative(home, path.resolve(item.sourceCwd));
          return (
            relative === "" ||
            (!relative.startsWith(`..${path.sep}`) &&
              relative !== ".." &&
              !path.isAbsolute(relative))
          );
        }),
      ]) {
        if (record.jobId !== request.jobId) activeWorkers.add(record.jobId);
      }
      for (const job of [...homeJobs, ...parentJobs]) {
        if (
          job.jobId !== request.jobId &&
          job.leadAgentId === leadAgent.leadAgentId &&
          (job.status === "running" ||
            job.errorText?.includes("recovery_required"))
        )
          activeWorkers.add(job.jobId);
      }
      for (const queued of parentQueued) {
        if (
          queued.id !== request.jobId &&
          queued.task.leadAgentId === leadAgent.leadAgentId &&
          queued.status !== "done" &&
          queued.status !== "failed"
        )
          activeWorkers.add(queued.id);
      }
      for (const snap of manager.view.list()) {
        if (
          snap.id !== request.jobId &&
          snap.meta.leadAgentId === leadAgent.leadAgentId &&
          (snap.status === "running" ||
            snap.restarting === true ||
            snap.errorText?.includes("recovery_required"))
        )
          activeWorkers.add(snap.id);
      }
      if (activeWorkers.size > 0)
        throw new Error(
          `Cannot retire Agent Lead while owned workers are active or queued: ${[...activeWorkers].join(", ")}.`,
        );

      approvalGate.begin(request.id);
      await persistApprovals();
      const homeStore = new LeadHomeStore(home);
      try {
        await homeStore.restore();
        const status = homeStore.get()?.status;
        if (
          status === "active" ||
          status === "paused" ||
          status === "recovery-required"
        )
          await homeStore.transition("stopping");
        await markLeadHomeRetired(home, leadAgent.leadAgentId, request.jobId);
        await deleteSubagentCompletely(manager, request.jobId, {
          preserveApproval: true,
        });
        approvalGate.complete(request.id);
        await persistApprovals();
      } catch (error) {
        approvalGate.fail(request.id);
        await persistApprovals().catch(() => {});
        try {
          if (fs.existsSync(home))
            await clearLeadHomeRetiredMarker(home, leadAgent.leadAgentId);
          await homeStore.restore();
          if (homeStore.get()?.status === "stopping")
            await homeStore.transition("recovery-required", String(error));
        } catch {
          // Preserve the original retirement failure; recovery can inspect the journal.
        }
        throw error;
      }
    });
  };

  const reconcileLeadHomes = async () => {
    const leadsRoot = path.join(stateRoot!, "leads");
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(leadsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (
        entry.name === ".retired" ||
        !entry.isDirectory() ||
        !isLeadHomeId(entry.name) ||
        leadAgentStore.get(entry.name)
      )
        continue;
      const homePath = path.join(leadsRoot, entry.name);
      const homeStore = new LeadHomeStore(homePath);
      try {
        let home = await homeStore.restore();
        if (!home) {
          home = await homeStore.create({
            leadAgentId: entry.name,
            homePath,
            stateRoot: path.join(homePath, "state"),
            parentStateRoot: stateRoot!,
            projects: [],
            status: "failed",
            failureReason:
              "Lead home directory existed without a durable manifest.",
          });
        }
        if (home.status === "active")
          await homeStore.transition(
            "recovery-required",
            "Lead registry was missing after provisioning; explicit recovery is required.",
          );
        if (home.status === "provisioning")
          await homeStore.transition(
            "failed",
            "Lead provisioning was interrupted before runtime registration.",
          );
        await leadAgentStore.create({
          leadAgentId: home.leadAgentId,
          jobId: createLeadJobId(`orphan-${home.leadAgentId}`),
          title: `Recovered ${home.leadAgentId}`,
          backend: "pi",
          mode: "scout",
          cwd: home.homePath,
          homePath: home.homePath,
        });
      } catch (error) {
        ui?.notify(
          `Agent Lead home ${homePath} requires manual recovery: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    }
  };

  const reconcileLeadRetirements = async (manager: SubagentManagerShape) => {
    for (const request of approvalGate
      .list()
      .filter(
        (item) =>
          item.operation === "retire-lead" &&
          (item.status === "approved" || item.status === "executing"),
      )) {
      if (request.status === "executing") approvalGate.fail(request.id);
      try {
        await executeLeadRetirement(
          manager,
          approvalGate.get(request.id) ?? request,
        );
      } catch (error) {
        ui?.notify(
          `Agent Lead retirement remains pending for ${request.jobId}: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    }
    await persistApprovals();
  };

  const reconcileDeletedSessions = async (manager: SubagentManagerShape) => {
    for (const snap of manager.view.list()) {
      if (snap.backend === "pi") {
        const sessionFilePath = snap.meta.sessionFilePath;
        const sessionMissing =
          sessionFilePath !== undefined && !fs.existsSync(sessionFilePath);
        if (sessionMissing && snap.status !== "running" && !snap.restarting) {
          const isLead = leadAgentStore
            .list()
            .some((lead) => lead.jobId === snap.id);
          if (isLead) {
            const recovered = await runTool(
              getRuntime(),
              manager.markRecoveryRequired(
                snap.id,
                "Agent Lead session file is missing; home preserved for explicit recovery or retirement.",
              ),
            );
            if (recovered)
              await persistSnapshot(recovered, "lead-recovery-required");
            continue;
          }
          // A user deleting a settled Pi session is an explicit clean-delete
          // signal. Close any still-live child session, remove dashboard and
          // workflow metadata, and preserve build worktrees.
          await cleanDeleteSubagentMetadata(manager, snap.id);
          continue;
        }
        // A live in-process session is authoritative while it is running;
        // missing files during that window can be a write/rename race.
        if (await runTool(getRuntime(), manager.hasLiveSession(snap.id)))
          continue;
        if (sessionMissing) {
          const recovered = await runTool(
            getRuntime(),
            manager.markRecoveryRequired(
              snap.id,
              "Pi session file is missing after restart.",
            ),
          );
          if (recovered) await persistSnapshot(recovered, "recovery-required");
        }
        continue;
      }
      if (snap.status !== "running" && !snap.restarting) continue;
      if (
        snap.backend === "orca" &&
        snap.meta.nativeWorktreeId &&
        snap.meta.nativeTerminalHandle
      ) {
        if (snap.errorText === "Run was aborted") continue;
        try {
          const terminals = await orcaCli.listTerminals(
            snap.meta.nativeWorktreeId,
          );
          if (
            !terminals.some(
              (terminal) => terminal.handle === snap.meta.nativeTerminalHandle,
            )
          ) {
            const recovered = await runTool(
              getRuntime(),
              manager.markRecoveryRequired(
                snap.id,
                "Orca terminal is missing or disconnected.",
              ),
            );
            if (recovered)
              await persistSnapshot(recovered, "recovery-required");
          }
        } catch {
          // A transient Orca CLI failure is not evidence of deletion.
        }
      }
    }
  };

  const reconcileProvisioning = async (manager: SubagentManagerShape) => {
    const knownJobIds = new Set([
      ...manager.view.list().map((snap) => snap.id),
      // A queued record is not proof that external provisioning completed;
      // retain the intent until a snapshot or durable job adopts the resource.
      ...leadAgentStore.list().map((lead) => lead.jobId),
      ...(await persistence.load()).map((job) => job.jobId),
    ]);
    for (const record of provisioning.list()) {
      if (knownJobIds.has(record.jobId)) {
        await provisioning.remove(record.jobId);
      } else {
        ui?.notify(
          `Unfinished subagent provisioning found for ${record.jobId}; worktree was preserved for manual recovery.`,
          "warning",
        );
      }
    }
  };

  const persistApprovals = async () => {
    await persistence.saveApprovals(approvalGate.list());
  };

  const findCallingSubagent = async (ctx: ExtensionContext) => {
    ensureStateStores(ctx);
    const bound = activeCallerIdentity();
    if (bound) {
      return {
        jobId: bound.jobId,
        role: bound.role,
        leadAgentId: bound.leadAgentId,
        parentStateRoot: bound.parentStateRoot,
        coordinatorStateRoot: bound.coordinatorStateRoot,
        title: bound.title,
        mode: bound.mode,
        cwd: bound.cwd,
        status: "running" as const,
        createdAt: Date.now(),
      };
    }
    const sessionFile = ctx.sessionManager.getSessionFile();
    const normalize = (value: string) => {
      const resolved = path.resolve(value);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const records = await persistence.load();
    const normalizedSessionFile =
      sessionFile === undefined ? undefined : normalize(sessionFile);
    const bySession =
      normalizedSessionFile === undefined
        ? undefined
        : records.find(
            (job) =>
              job.sessionFilePath !== undefined &&
              normalize(job.sessionFilePath) === normalizedSessionFile,
          );
    if (bySession) return bySession;
    // A child session must have a durable session binding before it can call
    // privileged tools. Never infer identity from cwd: another session or a
    // project process may legitimately share that directory.
    if (activeParentStateRoot() !== undefined) {
      throw new Error(
        "Unrecognized child session identity; refusing privileged subagent operation.",
      );
    }
    return undefined;
  };

  const resolveCallerParentInbox = (caller: {
    readonly parentStateRoot?: string;
  }): LeadAgentInbox => {
    if (caller.parentStateRoot === undefined) return leadAgentInbox;
    const parentRoot = path.resolve(caller.parentStateRoot);
    const managedParents = path.resolve(
      getAgentDir(),
      "workspace",
      "state",
      "parents",
    );
    const relativeParent = path.relative(managedParents, parentRoot);
    const managed =
      (relativeParent === "" ||
        (!relativeParent.startsWith(`..${path.sep}`) &&
          relativeParent !== ".." &&
          !path.isAbsolute(relativeParent))) &&
      /^[a-f0-9]{24}$/i.test(path.basename(parentRoot));
    if (!managed)
      throw new Error(
        "Caller parent state root is outside the managed parent namespace.",
      );
    return new LeadAgentInbox(parentRoot);
  };

  const assertLeadAgentToolRole = async (
    ctx: ExtensionContext,
    leadAgentId: string,
  ) => {
    const caller = await findCallingSubagent(ctx);
    if (!caller) return;
    if (caller.role !== "lead")
      throw new Error(
        "Only an Agent Lead or the parent session may use Agent Lead orchestration tools.",
      );
    const callerLeadStore = new LeadAgentStore(stateRoot!);
    await callerLeadStore.restore();
    const leadAgent = callerLeadStore.get(leadAgentId);
    if (!leadAgent || leadAgent.jobId !== caller.jobId) {
      throw new Error(
        `Agent Lead session is not authorized for ${leadAgentId}.`,
      );
    }
  };

  const assertParentToolRole = async (ctx: ExtensionContext) => {
    const caller = await findCallingSubagent(ctx);
    if (caller)
      throw new Error(
        "Only the parent session may approve or reject Agent Lead proposals.",
      );
  };

  let jobQueueDispatching = false;
  const dispatchQueuedJobs = async (manager: SubagentManagerShape) => {
    if (jobQueueDispatching) return;
    jobQueueDispatching = true;
    try {
      for (const record of jobQueue
        .list()
        .filter((item) => item.status === "running")) {
        const snap = manager.view.get(record.id);
        if (snap?.status === "done") await jobQueue.mark(record.id, "done");
        else if (snap?.status === "failed")
          await jobQueue.mark(record.id, "failed", snap.errorText);
      }
      for (const blocked of jobQueue.blocked(
        (id) =>
          manager.view.get(id)?.status === "failed" ||
          jobQueue.get(id)?.status === "blocked" ||
          jobQueue.get(id)?.status === "failed",
      )) {
        const reason = "A dependency failed; dispatch is blocked.";
        await jobQueue.mark(blocked.id, "blocked", reason);
        releaseSpawnClaim(blocked.id);
        await syncLedgerStatus({
          taskId: blocked.id,
          title: blocked.title,
          mode: blocked.mode,
          status: "blocked",
          message: reason,
          dependsOn: blocked.dependsOn,
          priority: blocked.priority,
          requiresWorktree:
            blocked.task.worktree !== undefined || blocked.mode === "build",
        });
        await workflowQueue.publish(blocked.id, {
          type: "status",
          status: "blocked",
          generation: workflowQueue.latestGeneration(blocked.id) ?? 1,
          message: reason,
          at: Date.now(),
        });
      }
      for (const queued of jobQueue.ready(
        (id) =>
          manager.view.get(id)?.status === "done" ||
          jobQueue.get(id)?.status === "done",
      )) {
        await jobQueue.mark(queued.id, "running");
        let preparedTask: SpawnTask | undefined;
        const provisioningRequired =
          queued.backend === "orca" && queued.mode === "build";
        try {
          const lease = await capacityPool.tryAcquire(queued.id, parentId!);
          if (!lease) {
            await jobQueue.mark(queued.id, "queued");
            continue;
          }
          capacityLeases.set(queued.id, lease);
          if (provisioningRequired) {
            await provisioning.begin({
              jobId: queued.id,
              backend: queued.backend,
              mode: queued.mode,
              title: queued.title,
              sourceCwd: queued.task.cwd,
              branchName: queued.task.branchName,
            });
          }
          preparedTask =
            queued.backend === "orca"
              ? await prepareOrcaTask(queued.task)
              : queued.task;
          if (provisioningRequired && preparedTask.worktree) {
            await provisioning.update(queued.id, {
              worktree: preparedTask.worktree,
              nativeWorktreeId: preparedTask.initialTerminal?.worktreeId,
            });
          }
          const snap = await runTool(
            getRuntime(),
            manager.spawn(queued.backend, preparedTask),
          );
          await publishWorkflowStatus(snap, "working");
          const persisted = await persistSnapshot(snap, "job-dispatched");
          if (persisted) await provisioning.remove(queued.id);
        } catch (error) {
          if (preparedTask?.worktree && !manager.view.get(queued.id)) {
            try {
              await cleanupManagedWorktree(
                queued.backend,
                preparedTask.worktree,
                preparedTask.initialTerminal?.worktreeId,
              );
              if (provisioningRequired) await provisioning.remove(queued.id);
            } catch {
              // Preserve the worktree and provisioning intent when cleanup cannot be verified.
            }
          } else if (provisioningRequired) {
            await provisioning.remove(queued.id).catch(() => {});
          }
          await releaseCapacity(queued.id);
          if (
            error instanceof ConcurrencyLimitError ||
            /concurr|maximum.*running|capacity/i.test(
              error instanceof Error ? error.message : String(error),
            )
          ) {
            // Capacity is transient. Leave the job queued so the next
            // settlement/timer dispatch can retry it without losing the job.
            await jobQueue.mark(queued.id, "queued");
          } else {
            await jobQueue.mark(
              queued.id,
              "failed",
              error instanceof Error ? error.message : String(error),
            );
            releaseSpawnClaim(queued.id);
          }
        }
      }
    } finally {
      jobQueueDispatching = false;
    }
  };

  const waitForQueuedJobs = async (
    manager: SubagentManagerShape,
    ids: ReadonlyArray<string>,
    onUpdate?: (pending: string[]) => void,
    signal?: AbortSignal,
  ) => {
    while (true) {
      if (signal?.aborted)
        throw new Error("Job queue wait aborted. Queued jobs remain durable.");
      await dispatchQueuedJobs(manager);
      const waiting = ids.filter((id) => {
        const queued = jobQueue.get(id);
        return (
          !!queued &&
          (queued.status === "queued" ||
            (queued.status === "running" && !manager.view.get(id)))
        );
      });
      if (waiting.length > 0) {
        onUpdate?.(waiting);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 250);
          const abort = () => {
            clearTimeout(timer);
            reject(
              new Error("Job queue wait aborted. Queued jobs remain durable."),
            );
          };
          signal?.addEventListener("abort", abort, { once: true });
        });
        continue;
      }
      const managerIds = ids.filter((id) => !!manager.view.get(id));
      if (managerIds.length > 0) {
        await runTool(getRuntime(), manager.waitFor(managerIds, onUpdate), {
          signal,
          interruptMessage: "Wait aborted. Jobs keep running.",
        });
      }
      await dispatchQueuedJobs(manager);
      const remaining = ids.filter((id) => {
        const queued = jobQueue.get(id);
        return queued?.status === "queued" || queued?.status === "running";
      });
      if (remaining.length === 0) return;
    }
  };

  const getRuntime = () => (runtime ??= createSubagentRuntime(stateRoot));

  const getManager = () => {
    managerPromise ??= (async (): Promise<SubagentManagerShape> => {
      ensureStateStores();
      stateLease = await acquireStateLease(stateRoot!);
      try {
        return await getRuntime()
          .runPromise(SubagentManager)
          .then(async (manager) => {
            manager.view.setOnSettled(onSettled);
            try {
              approvalGate.restore(await persistence.loadApprovals());
              await provisioning.restore();
              await detachedWorktrees.restore();
              await actionQueue.restore();
              await workflowQueue.restore();
              await taskLedger.restore();
              await jobQueue.restore();
              await leadAgentStore.restore();
              await reconcileLeadHomes();
              await leadAgentProposalStore.restore();
              const jobs = await persistence.load();
              const events = await persistence.loadEvents();
              await runTool(getRuntime(), manager.restore(jobs, events));
              await reconcileProvisioning(manager);
              for (const snap of [...manager.view.list()]) {
                if (
                  snap.backend !== "orca" ||
                  !snap.errorText?.includes("restarted")
                )
                  continue;
                const lease = await capacityPool.tryAcquire(snap.id, parentId!);
                if (!lease) {
                  ui?.notify(
                    `Orca job ${snap.id} remains paused because the global subagent capacity is full.`,
                    "warning",
                  );
                  continue;
                }
                capacityLeases.set(snap.id, lease);
                try {
                  await runTool(getRuntime(), manager.reattach(snap.id));
                } catch (error) {
                  await releaseCapacity(snap.id);
                  const reason = `Orca reattach failed: ${error instanceof Error ? error.message : String(error)}`;
                  const recovered = await runTool(
                    getRuntime(),
                    manager.markRecoveryRequired(snap.id, reason),
                  );
                  if (recovered)
                    await persistSnapshot(recovered, "recovery-required");
                  ui?.notify(
                    `Orca job ${snap.id} requires recovery: ${reason}`,
                    "warning",
                  );
                }
              }
              for (const snap of manager.view.list())
                await persistSnapshot(snap, "restored");
              await reconcileDeletedSessions(manager);
              await reconcileLeadRetirements(manager);
              await subagentMonitor.reconcile(manager.view.list());
              await leadAgentInbox.drain(async (event) => {
                await orchestrationCoordinator!.emit(event);
              });
              for (const evidence of await runTool(
                getRuntime(),
                manager.probeStatuses(),
              )) {
                await subagentMonitor.observeEvidence(evidence);
              }
              subagentMonitor.start(
                () => manager.view.list(),
                async () => runTool(getRuntime(), manager.probeStatuses()),
              );
              await dispatchQueuedJobs(manager);
              sessionReconcileTimer ??= setInterval(() => {
                void (async () => {
                  await leadAgentInbox.drain(async (event) => {
                    await orchestrationCoordinator!.emit(event);
                  });
                  await reconcileDeletedSessions(manager);
                  await dispatchQueuedJobs(manager);
                })().catch(() => {});
              }, 5_000);
              sessionReconcileTimer.unref?.();
            } catch (error) {
              ui?.notify(
                `Durable subagent state was not restored; subagent tools are locked: ${String(error)}`,
                "error",
              );
              throw error;
            }
            unsubStatus?.();
            unsubStatus = manager.view.subscribe(() => {
              updateStatus(manager);
              renderSubagentUi(manager);
              void dispatchQueuedJobs(manager).catch(() => {});
            });
            activeManager = manager;
            await orchestrationCoordinator?.replay();
            updateStatus(manager);
            renderSubagentUi(manager);
            if (ui && sessionContext?.mode === "tui") {
              uiRefreshTimer ??= setInterval(() => {
                if (activeManager) renderSubagentUi(activeManager);
              }, 120);
              uiRefreshTimer.unref?.();
            }
            return manager;
          });
      } catch (error) {
        await stateLease?.release().catch(() => {});
        stateLease = undefined;
        throw error;
      }
    })();
    return managerPromise;
  };

  const createLeadProjectionView = async (
    manager: SubagentManagerShape,
  ): Promise<{ view: SubagentReadModel; refresh: () => Promise<void> }> => {
    const base = manager.view;
    let projected: SubagentSnapshot[] = [];
    let projectedIds = new Set<string>();
    const refresh = async () => {
      const existing = new Set([
        ...base.list().map((snap) => snap.id),
        ...jobQueue.list().map((job) => job.id),
      ]);
      const next: SubagentSnapshot[] = [];
      for (const lead of leadAgentStore.list()) {
        if (!lead.homePath) continue;
        const home = await resolveManagedLeadHome(
          lead.homePath,
          path.join(stateRoot!, "leads"),
        );
        if (!home) continue;
        const jobs = await new JobPersistence(path.join(home, "state")).load();
        for (const job of jobs) {
          if (
            job.jobId === lead.jobId ||
            job.leadAgentId !== lead.leadAgentId ||
            existing.has(job.jobId)
          )
            continue;
          next.push({
            id: job.jobId,
            origin: job.origin ?? "model",
            backend: job.backend ?? "pi",
            title: job.title,
            prompt: "Projected from the Agent Lead home.",
            cwd: job.cwd,
            status: job.status,
            restarting: job.queued === true,
            createdAt: job.createdAt,
            settledAt: job.settledAt,
            errorText: job.errorText,
            report: job.report,
            metrics: {
              runCount: 0,
              restartCount: 0,
              timeoutCount: 0,
              startedAt: job.createdAt,
              lastEventAt: job.settledAt ?? job.createdAt,
            },
            eventLog: [],
            meta: {
              backend: job.backend ?? "pi",
              role: "worker",
              leadAgentId: lead.leadAgentId,
              mode: job.mode,
              sessionFilePath: job.sessionFilePath,
              parentStateRoot: job.parentStateRoot,
              nativeSessionId: job.nativeSessionId,
              nativeTerminalHandle: job.nativeTerminalHandle,
              nativeWorktreeId: job.nativeWorktreeId,
              nativeTabId: job.nativeTabId,
              nativePaneKey: job.nativePaneKey,
              nativeLaunchToken: job.nativeLaunchToken,
              ...(job.worktreePath && job.branch && job.repoRoot
                ? {
                    worktree: {
                      jobId: job.jobId,
                      path: job.worktreePath,
                      branch: job.branch,
                      repoRoot: job.repoRoot,
                    },
                  }
                : {}),
            },
            usage: {},
            transcript: [],
            liveTools: [],
            queued: [],
            finalText: job.finalText ?? "",
            turns: 0,
          });
        }
      }
      projected = next;
      projectedIds = new Set(projected.map((snap) => snap.id));
    };
    await refresh();
    const all = () => [...base.list(), ...projected];
    const view: SubagentReadModel = {
      list: all,
      get: (id) => base.get(id) ?? projected.find((snap) => snap.id === id),
      size: () => base.size() + projected.length,
      subscribe: (listener) => base.subscribe(listener),
      subscribeTo: (id, listener) =>
        projectedIds.has(id) ? () => {} : base.subscribeTo(id, listener),
      requestSend: (id, _text, onError) => {
        if (projectedIds.has(id))
          onError?.(
            "Projected Lead child is controlled by its Lead runtime; send the follow-up through subagent_lead_send.",
          );
        else base.requestSend(id, _text, onError);
      },
      requestAbort: (id, onError) => {
        if (projectedIds.has(id))
          onError?.(
            "Projected Lead child is controlled by its Lead runtime; stop the Lead or use its own coordinator tools.",
          );
        else base.requestAbort(id, onError);
      },
      setOnSettled: (hook) => base.setOnSettled(hook),
    };
    return { view, refresh };
  };

  const updateStatus = (manager: SubagentManagerShape) => {
    if (!ui) return;
    const subs = manager.view.list();
    if (subs.length === 0) {
      ui.setStatus("subagents", undefined);
      return;
    }
    const starting = subs.filter(
      (snap) => snap.restarting === true || isSubagentBooting(snap),
    ).length;
    const running = subs.filter(
      (snap) =>
        snap.status === "running" &&
        !snap.restarting &&
        !isSubagentBooting(snap),
    ).length;
    const failed = subs.filter((snap) => snap.status === "failed").length;
    const done = subs.length - starting - running - failed;
    ui.setStatus(
      "subagents",
      formatActivityStatus(ui.theme, { starting, running, done, failed }),
    );
  };

  const queuedUiJobs = (): ReadonlyArray<WidgetQueuedJob> =>
    jobQueue.list().map((job) => ({
      id: job.id,
      title: job.title,
      status: job.status,
      createdAt: job.createdAt,
      mode: job.mode,
      role: job.task.role,
      leadAgentId: job.task.leadAgentId,
    }));

  const renderSubagentUi = (manager: SubagentManagerShape) => {
    if (!ui || sessionContext?.mode !== "tui") return;
    const snapshots = manager.view.list();
    const queued = queuedUiJobs();
    if (
      snapshots.some(
        (snap) => snap.meta.role === "lead" && snap.meta.mode === "build",
      ) ||
      queued.some((job) => job.role === "lead" && job.mode === "build") ||
      leadAgentStore.list().some((lead) => lead.mode === "build")
    ) {
      hasBuildLeadInSession = true;
    }
    renderAgentWidget(ui, snapshots, queued);
    renderFleetView(ui, snapshots, queued, hasBuildLeadInSession);
  };

  const syncLedgerStatus = async (options: {
    readonly taskId: WorkflowTaskId;
    readonly title: string;
    readonly mode: SubagentMode;
    readonly status: WorkflowTaskStatus;
    readonly role?: WorkflowTaskRole;
    readonly message?: string;
    readonly leadAgentId?: LeadAgentId;
    readonly dependsOn?: ReadonlyArray<WorkflowTaskId>;
    readonly priority?: number;
    readonly requiresWorktree?: boolean;
  }) => {
    let task = await taskLedger.ensure({
      id: options.taskId,
      title: options.title,
      mode: options.mode,
      role: options.role ?? "worker",
      dependsOn: options.dependsOn ?? [],
      priority: options.priority ?? 0,
      requiresWorktree: options.requiresWorktree ?? options.mode === "build",
      leadAgentId: options.leadAgentId,
    });
    if (options.status === "working" && task.status === "queued") {
      task = await taskLedger.status(task.id, "working");
    } else if (options.status !== "working" && task.status === "queued") {
      task = await taskLedger.status(task.id, "working");
    }
    if (
      options.status === "paused" &&
      (task.status === "done" || task.status === "failed")
    )
      return task;
    if (options.status === "paused" && task.status === "needs-decision") {
      task = await taskLedger.status(task.id, "working", options.message);
    }
    if (task.status !== options.status) {
      const generation =
        options.status === "working" ? task.generation + 1 : task.generation;
      task = await taskLedger.status(
        task.id,
        options.status,
        options.message,
        generation,
      );
    }
    return task;
  };

  const publishWorkflowStatus = async (
    snap: SubagentSnapshot,
    status: WorkflowTaskStatus,
    message?: string,
  ) => {
    if (snap.origin === "quick-ask") return;
    const ledgerTask = await syncLedgerStatus({
      taskId: snap.id,
      title: snap.title,
      mode: snap.meta.mode ?? "build",
      status,
      message,
      requiresWorktree: !!snap.meta.worktree,
    });
    if (ledgerTask.parentTaskId && (status === "done" || status === "failed")) {
      const parent = taskLedger.get(ledgerTask.parentTaskId);
      if (parent && parent.status !== "done" && parent.status !== "failed") {
        if (parent.status === "queued")
          await taskLedger.status(parent.id, "working");
        await taskLedger.status(parent.id, status, message);
      }
    }
    if (
      status === "paused" &&
      (ledgerTask.status === "done" || ledgerTask.status === "failed")
    )
      return;
    const latest = workflowQueue.latestGeneration(snap.id);
    const current =
      latest === undefined ? undefined : workflowQueue.status(snap.id, latest);
    const generation =
      status === "working"
        ? current === "working"
          ? latest!
          : (latest ?? 0) + 1
        : (latest ?? 1);
    await workflowQueue.publish(snap.id, {
      type: "status",
      status,
      generation,
      at: snap.settledAt ?? Date.now(),
      ...(message === undefined ? {} : { message }),
    });
  };

  let orchestrationCoordinator: OrchestrationCoordinator | undefined;
  const resumeTaskAfterDecision = async (
    taskId: WorkflowTaskId,
    message: string,
    at: number,
  ) => {
    const task = taskLedger.get(taskId);
    if (task?.status === "needs-decision") {
      await taskLedger.status(taskId, "working", message);
    }

    const generation = workflowQueue.latestGeneration(taskId);
    if (
      generation !== undefined &&
      workflowQueue.status(taskId, generation) === "needs-decision"
    ) {
      await workflowQueue.publish(taskId, {
        type: "status",
        status: "working",
        generation,
        message,
        at,
      });
    }
  };

  const handleLeadAgentEvent = async (event: LeadAgentEvent) => {
    const leadAgent = leadAgentStore.get(event.leadAgentId);
    if (!leadAgent) throw new Error(`Unknown Agent Lead: ${event.leadAgentId}`);
    if (event.actorId !== "parent" && event.actorId !== event.leadAgentId)
      throw new Error(
        `Event actor is not authorized for Agent Lead ${event.leadAgentId}.`,
      );
    if (event.type === "proposal") {
      // A proposal is created in the ledger as queued. Do not route this
      // through status synchronization: it advances queued tasks to working
      // before applying terminal statuses, and working -> queued is invalid.
      await taskLedger.ensure({
        id: event.proposalId,
        title: event.title,
        mode: event.mode,
        role: "worker",
        dependsOn: event.dependsOn,
        priority: event.priority,
        requiresWorktree: event.mode === "build",
        leadAgentId: event.leadAgentId,
      });
      if (!leadAgentProposalStore.get(event.proposalId)) {
        await leadAgentProposalStore.create({
          id: event.proposalId,
          leadAgentId: event.leadAgentId,
          title: event.title,
          prompt: event.prompt,
          mode: event.mode,
          ...(event.workingDir === undefined
            ? {}
            : { workingDir: event.workingDir }),
          dependsOn: event.dependsOn,
          priority: event.priority,
        });
      }
      return;
    }
    if (
      event.taskId &&
      (event.type === "worker_done" ||
        event.type === "escalation" ||
        event.type === "ask")
    ) {
      let task = taskLedger.get(event.taskId);
      if (!task && event.actorId === event.leadAgentId) {
        // Direct Lead spawns have no parent proposal to pre-register. Adopt
        // their signed task on the first operational event in the parent ledger.
        await syncLedgerStatus({
          taskId: event.taskId,
          title: event.taskId,
          mode: "build",
          status: "working",
          leadAgentId: event.leadAgentId,
        });
        task = taskLedger.get(event.taskId);
      }
      if (!task || task.leadAgentId !== event.leadAgentId)
        throw new Error(
          `Event task is not owned by Agent Lead ${event.leadAgentId}.`,
        );
      if (
        task.status === "queued" ||
        task.status === "done" ||
        task.status === "failed"
      )
        throw new Error(
          `Event task ${event.taskId} is not an active execution.`,
        );
      const status = event.type === "worker_done" ? "done" : "needs-decision";
      const message =
        event.type === "worker_done"
          ? event.summary
          : event.type === "ask"
            ? event.question
            : event.reason;
      if (event.type === "worker_done") {
        await resumeTaskAfterDecision(
          event.taskId,
          "Parent decision received; task resumed.",
          event.at,
        );
      }
      await syncLedgerStatus({
        taskId: event.taskId,
        title: event.taskId,
        mode: "build",
        status,
        message,
        leadAgentId: event.leadAgentId,
      });
      let workflowStatus =
        workflowQueue.latestGeneration(event.taskId) === undefined
          ? undefined
          : workflowQueue.status(event.taskId);
      if (workflowStatus === undefined) {
        await workflowQueue.publish(event.taskId, {
          type: "status",
          status: "queued",
          generation: 1,
          at: event.at,
        });
        await workflowQueue.publish(event.taskId, {
          type: "status",
          status: "working",
          generation: 1,
          at: event.at,
        });
        workflowStatus = "working";
      }
      if (workflowStatus !== status) {
        await workflowQueue.publish(event.taskId, {
          type: "status",
          status,
          generation: workflowQueue.latestGeneration(event.taskId) ?? 1,
          message,
          at: event.at,
        });
      }
    }
    if (event.type === "reply") {
      if (!activeManager) return false;
      const leadAgent = leadAgentStore.get(event.leadAgentId);
      if (leadAgent) {
        const current = await runTool(
          getRuntime(),
          activeManager.get(leadAgent.jobId),
        );
        if (current?.status === "running") {
          await runTool(
            getRuntime(),
            activeManager.send(
              leadAgent.jobId,
              `Reply to ${event.replyTo}: ${event.answer}`,
            ),
          );
        }
      }
    }
  };
  const deliverResult = (snap: SubagentSnapshot) => {
    pi.sendMessage(
      {
        customType: "subagent-result",
        content: buildSubagentResultMessage({
          id: snap.id,
          title: snap.title,
          status: snap.status,
          errorText: snap.errorText,
          output: truncatedOutput(snap),
          report: snap.report,
          approvalId: approvalGate.get(`approval:${snap.id}:review`)?.id,
        }),
        display: true,
        details: {
          id: snap.id,
          title: snap.title,
          status: snap.status,
          // Keep the normalized report machine-readable for the parent while
          // the rendered content and raw terminal output remain untrusted data.
          report: snap.report,
        },
      },
      // Firstmate-parity delivery: a settled child always reaches the parent as
      // its own turn ("the model is never left blind"). The message stays
      // marked untrusted; disable with SUBAGENT_AUTO_WAKE=0.
      {
        deliverAs: "nextTurn",
        triggerTurn: process.env.SUBAGENT_AUTO_WAKE === "0" ? false : true,
      },
    );
  };

  const flushResults = () => {
    for (const snap of resultDelivery.drain()) deliverResult(snap);
  };

  const subagentUiOptions = () => ({
    getApprovals: (jobId: string) =>
      approvalGate.list().filter((item) => item.jobId === jobId),
    getActions: (jobId: string) =>
      actionQueue.list().filter((item) => item.event.jobId === jobId),
    onDelete: async (jobId: string) => {
      const manager = await getManager();
      if (!manager.view.get(jobId))
        throw new Error(
          "Projected Lead children are read-only in the parent dashboard; manage them through the Lead runtime.",
        );
      await deleteSubagentCompletely(manager, jobId);
    },
    onRetry: async (jobId: string) => {
      const manager = await getManager();
      if (!manager.view.get(jobId))
        throw new Error(
          "Projected Lead children are read-only in the parent dashboard; retry them through the Lead runtime.",
        );
      await waitForCapacity(jobId);
      try {
        await runTool(getRuntime(), manager.retry(jobId));
      } catch (error) {
        await releaseCapacity(jobId);
        throw error;
      }
      const snap = await runTool(getRuntime(), manager.get(jobId));
      if (snap) {
        await publishWorkflowStatus(snap, "working");
        await persistSnapshot(snap, "dashboard-retry-requested");
      }
    },
    onApprove: async (jobId: string, approvalId: string) => {
      const manager = await getManager();
      if (!manager.view.get(jobId))
        throw new Error(
          "Projected Lead children are read-only in the parent dashboard; approve actions in the Lead runtime.",
        );
      const request = approvalGate.get(approvalId);
      if (!request || request.jobId !== jobId || request.status !== "pending") {
        throw new Error("Approval request is no longer pending.");
      }
      if (
        !ui ||
        !(await ui.confirm(
          `Approve ${request.operation}`,
          `Allow ${request.operation} for build job ${request.jobId}? This may change Git state or external repositories.`,
        ))
      )
        throw new Error("Approval cancelled.");
      const approved = approvalGate.approve(approvalId);
      await persistApprovals();
      if (approved.operation === "delete-worktree") {
        await deleteSubagentCompletely(manager, approved.jobId);
      } else if (approved.operation === "retire-lead") {
        await executeLeadRetirement(manager, approved);
      } else {
        await executeApprovedDelivery(manager, approved);
      }
    },
    onConfirmAction: async (actionId: string) => {
      const manager = await getManager();
      const action = actionQueue
        .list()
        .find((item) => item.event.actionId === actionId);
      if (action?.event.jobId && !manager.view.get(action.event.jobId))
        throw new Error(
          "Projected Lead children are read-only in the parent dashboard; confirm actions in the Lead runtime.",
        );
      await actionQueue.confirm(actionId);
    },
    onInspectTerminal: async (snap: SubagentSnapshot) => {
      if (snap.backend !== "orca") return;
      const identity = [
        snap.meta.nativeTerminalHandle
          ? `terminal=${snap.meta.nativeTerminalHandle}`
          : undefined,
        snap.meta.nativeWorktreeId
          ? `worktree=${snap.meta.nativeWorktreeId}`
          : undefined,
        snap.meta.worktree?.path
          ? `path=${snap.meta.worktree.path}`
          : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      ui?.notify(
        `Inspect Orca terminal manually: ${identity || "identity unavailable"}`,
        "info",
      );
    },
  });

  const deliverQuickAskResult = (snap: SubagentSnapshot) => {
    pi.appendEntry<QuickAskResultData>("quick-ask-result", {
      id: snap.id,
      title: snap.title,
      status: snap.status,
      errorText: snap.errorText,
      prompt: snap.prompt,
      answer: truncatedOutput(snap),
      sessionFilePath: snap.meta.sessionFilePath,
    });
    ui?.notify(
      snap.status === "failed"
        ? `quick ask "${snap.title}" failed — reopen it with /subagents`
        : `quick ask "${snap.title}" answered — reopen it with /subagents`,
      snap.status === "failed" ? "error" : "info",
    );
  };

  const onSettled = (snap: SubagentSnapshot, consumed: boolean) => {
    releaseSpawnClaim(snap.id);
    void releaseCapacity(snap.id);
    if (deletingJobs.has(snap.id)) return;
    if (!sessionContext) {
      pendingSettled.push({
        snap: { ...snap, meta: { ...snap.meta } },
        consumed,
      });
      return;
    }
    const requiresDecision =
      snap.report?.outcome === "blocked" ||
      snap.report?.needsParentDecision === true;
    const stoppedLead =
      snap.meta.role === "lead" &&
      snap.meta.leadAgentId !== undefined &&
      stoppingLeadIds.has(snap.meta.leadAgentId);
    void publishWorkflowStatus(
      snap,
      stoppedLead
        ? "paused"
        : requiresDecision
          ? "needs-decision"
          : snap.status === "done"
            ? "done"
            : "failed",
      snap.errorText ?? snap.report?.error?.message,
    ).catch((error) => {
      ui?.notify(
        `Workflow event persistence failed: ${String(error)}`,
        "warning",
      );
    });
    void persistSnapshot(snap, "settled");
    if (
      snap.meta.mode === "build" &&
      snap.status === "done" &&
      snap.report?.outcome === "success" &&
      snap.meta.worktree
    ) {
      approvalGate.request({
        jobId: snap.id,
        operation: "review",
        mode: "build",
      });
      void persistApprovals().catch((error) => {
        ui?.notify(
          `Approval state persistence failed: ${String(error)}`,
          "warning",
        );
      });
    }
    void subagentMonitor.observe(snap).catch(() => {});
    if (snap.origin === "quick-ask") {
      deliverQuickAskResult({ ...snap, meta: { ...snap.meta } });
      return;
    }
    if (ui && sessionContext?.mode === "tui")
      notifySubagentCompletion(ui, snap);
    if (consumed) {
      resultDelivery.consume([snap.id]);
      return;
    }
    resultDelivery.defer({ ...snap, meta: { ...snap.meta } });
    if (sessionContext?.isIdle()) flushResults();
  };

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    ensureStateStores(ctx);
    if (ctx.hasUI) ui = ctx.ui;
    const pending = pendingSettled.splice(0);
    for (const item of pending) onSettled(item.snap, item.consumed);
    if (ctx.mode === "tui" && ctx.hasUI) {
      void getManager()
        .then((manager) => renderSubagentUi(manager))
        .catch((error) => {
          ui?.notify(
            `Subagent UI initialization failed: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        });
    }
  });

  pi.on("agent_settled", flushResults);

  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    resultDelivery.clear();
    pendingSettled.length = 0;
    stoppingLeadIds.clear();
    approvalGate.clear();
    unsubStatus?.();
    unsubStatus = undefined;
    if (storesReady) subagentMonitor.stop();
    if (sessionReconcileTimer) clearInterval(sessionReconcileTimer);
    sessionReconcileTimer = undefined;
    if (uiRefreshTimer) clearInterval(uiRefreshTimer);
    uiRefreshTimer = undefined;
    hasBuildLeadInSession = false;
    if (ui) {
      invalidateAgentWidget(ui);
      invalidateFleetView(ui);
    }
    ui?.setStatus("subagents", undefined);
    ui = undefined;
    activeManager = undefined;
    const closing = runtime;
    const lease = stateLease;
    runtime = undefined;
    managerPromise = undefined;
    stateLease = undefined;
    await disposeWithStateLease(async () => {
      await closing?.dispose();
    }, lease);
    await Promise.all(
      [...capacityLeases.values()].map((item) =>
        item.release().catch(() => {}),
      ),
    );
    capacityLeases.clear();
    storesReady = false;
    stateRoot = undefined;
    parentId = undefined;
    orchestrationCoordinator = undefined;
  });

  // --- Tools ---------------------------------------------------------------

  // Build workers and Leads may edit/test, but delivery and destructive shell
  // operations must stay behind the parent approval gateway. This is a
  // defense-in-depth hook; the authoritative delivery boundary remains the
  // typed delivery/approval tools and the managed worktree checks.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const caller = await findCallingSubagent(ctx);
    if (!caller) return undefined;
    const command =
      typeof event.input.command === "string" ? event.input.command : "";
    const policy = validateChildShellCommand(command);
    if (policy.allowed) return undefined;
    return {
      block: true,
      reason:
        policy.reason ?? "Shell command is not allowed in a child runtime.",
    };
  });

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    parameters: Type.Object({
      prompt: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 32_000,
          description:
            "Fallback task prompt; ignored when proposal_id is provided.",
        }),
      ),
      name: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 160,
          description:
            "Fallback task name; ignored when proposal_id is provided.",
        }),
      ),
      proposal_id: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 128,
          description: "Approved Agent Lead child proposal to dispatch.",
        }),
      ),
      working_dir: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
        }),
      ),
      mode: Type.Optional(
        StringEnum(SUBAGENT_MODES, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.mode,
        }),
      ),
      backend: Type.Optional(
        StringEnum(BACKEND_NAMES, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.backend,
        }),
      ),
      reasoning_effort: Type.Optional(
        StringEnum(REASONING_EFFORTS, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({
          minimum: 1_000,
          maximum: 86_400_000,
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.timeoutMs,
        }),
      ),
      depends_on: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
          maxItems: 16,
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.dependsOn,
        }),
      ),
      priority: Type.Optional(
        Type.Integer({
          minimum: -100,
          maximum: 100,
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.priority,
        }),
      ),
      branch_type: Type.Optional(
        StringEnum(CONVENTIONAL_BRANCH_TYPES, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.branchType,
        }),
      ),
      branch_scope: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 32,
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.branchScope,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const manager = await getManager();
      const caller = await findCallingSubagent(ctx);
      if (caller && caller.role !== "lead")
        throw new Error(
          "Only an Agent Lead or the parent session may spawn subagents.",
        );
      const proposalId = params.proposal_id as string | undefined;
      const proposal =
        proposalId === undefined
          ? undefined
          : leadAgentProposalStore.get(proposalId);
      const proposalLeadAgent =
        proposal === undefined
          ? undefined
          : leadAgentStore.get(proposal.leadAgentId);
      const owningLeadAgentId =
        proposalLeadAgent?.leadAgentId ??
        (proposalId === undefined && caller?.role === "lead"
          ? caller.leadAgentId
          : undefined);
      const releaseLeadHomeLock =
        owningLeadAgentId === undefined
          ? undefined
          : await acquireLeadHomeLock(owningLeadAgentId);
      try {
        if (proposalId !== undefined) {
          if (!proposal)
            throw new Error(`Unknown Agent Lead proposal: ${proposalId}`);
          if (!proposalLeadAgent)
            throw new Error(
              `Agent Lead owner is missing for proposal: ${proposalId}`,
            );
          if (proposal.status !== "approved")
            throw new Error(
              `Agent Lead proposal ${proposalId} must be approved before dispatch.`,
            );
        }
        if (
          !proposal &&
          (typeof params.name !== "string" ||
            !params.name.trim() ||
            typeof params.prompt !== "string" ||
            !params.prompt.trim())
        ) {
          throw new Error(
            "subagent_spawn requires name and prompt when proposal_id is not provided.",
          );
        }
        const mode =
          proposal?.mode ??
          (params.mode as SubagentMode | undefined) ??
          "build";
        if (proposalLeadAgent && proposal?.workingDir === undefined) {
          throw new Error(
            "Agent Lead child tasks must specify working_dir inside the Lead home.",
          );
        }
        if (
          caller?.role === "lead" &&
          proposal === undefined &&
          typeof params.working_dir !== "string"
        ) {
          throw new Error(
            "Agent Lead child tasks must specify working_dir inside the Lead home.",
          );
        }
        const policy = resolveExecutionPolicy(
          mode,
          params.backend as BackendName | undefined,
        );
        const harness = policy.backend;
        const dependsOn = proposal
          ? [...proposal.dependsOn]
          : [...new Set((params.depends_on as string[] | undefined) ?? [])];
        const priority =
          typeof params.priority === "number" ? params.priority : 0;
        const branchType = params.branch_type as
          ConventionalBranchType | undefined;
        const branchScope = params.branch_scope as string | undefined;

        const proposalHome = proposalLeadAgent
          ? await resolveManagedLeadHome(
              proposalLeadAgent.homePath,
              path.join(stateRoot!, "leads"),
            )
          : undefined;
        if (proposalLeadAgent?.homePath && !proposalHome) {
          throw new Error(
            `Agent Lead home is missing: ${proposalLeadAgent.homePath}`,
          );
        }
        const requestedCwd = proposalLeadAgent
          ? path.resolve(
              proposalHome ??
                proposalLeadAgent.repoRoot ??
                proposalLeadAgent.cwd,
              proposal?.workingDir ?? ".",
            )
          : path.resolve(
              ctx.cwd,
              (params.working_dir as string | undefined) ?? ".",
            );
        const child = proposalHome
          ? (() => {
              const homeRoot = fs.realpathSync(proposalHome);
              const childRoot = fs.realpathSync(requestedCwd);
              const relative = path.relative(homeRoot, childRoot);
              const insideHome =
                relative === "" ||
                (!relative.startsWith(`..${path.sep}`) &&
                  relative !== ".." &&
                  !path.isAbsolute(relative));
              if (!insideHome)
                throw new Error(
                  `Agent Lead working_dir must stay inside its managed home: ${childRoot}`,
                );
              return { cwd: childRoot, projectTrusted: true };
            })()
          : resolveTrustedChildCwd({
              parentCwd: ctx.cwd,
              requestedCwd,
              parentTrusted: ctx.isProjectTrusted(),
            });
        const title =
          (proposal?.title ?? (params.name as string)).trim().slice(0, 160) ||
          "subagent";
        const prompt = proposal?.prompt ?? (params.prompt as string);
        const jobId = createJobId(title);
        const branchName = jobId
          ? createBranchName(title, { type: branchType, scope: branchScope })
          : undefined;
        let capacityUnavailable = false;
        const spawnFingerprint = jobId
          ? createSpawnFingerprint({
              backend: harness,
              mode,
              sourceCwd: child.cwd,
              prompt,
              ...(proposalId === undefined ? {} : { proposalId }),
            })
          : undefined;
        const existingClaim =
          spawnFingerprint === undefined
            ? undefined
            : spawnClaims.get(spawnFingerprint);
        if (existingClaim) {
          const current = manager.view.get(existingClaim.id);
          const state =
            current?.status === "running"
              ? "already running"
              : "still starting";
          return {
            content: [
              {
                type: "text",
                text: `Subagent ${existingClaim.id} "${existingClaim.title}" is ${state}; reusing it instead of creating another Orca worktree.`,
              },
            ],
            details: {
              id: existingClaim.id,
              title: existingClaim.title,
              status: current?.status ?? "starting",
              cwd: existingClaim.cwd,
              branch: existingClaim.branch,
              mode: existingClaim.mode,
              harness: existingClaim.backend,
              deduplicated: true,
            },
          };
        }
        if (dependsOn.length === 0) {
          const lease = await capacityPool.tryAcquire(jobId, parentId!);
          if (lease) capacityLeases.set(jobId, lease);
          else capacityUnavailable = true;
        }
        if (spawnFingerprint && jobId) {
          spawnClaims.set(spawnFingerprint, {
            id: jobId,
            title,
            backend: harness,
            mode,
            cwd: child.cwd,
            ...(branchName === undefined ? {} : { branch: branchName }),
          });
        }
        let worktree: PreparedOrcaWorktree["worktree"] | undefined;
        let initialTerminal: SubagentInitialTerminal | undefined;
        const provisioningRequired =
          jobId !== undefined &&
          policy.requiresWorktree &&
          dependsOn.length === 0 &&
          !capacityUnavailable;
        try {
          if (provisioningRequired) {
            await provisioning.begin({
              jobId: jobId!,
              backend: harness,
              mode,
              title,
              sourceCwd: child.cwd,
              branchName,
            });
          }
          if (
            !capacityUnavailable &&
            jobId &&
            harness === "orca" &&
            dependsOn.length === 0
          ) {
            const prepared = await createOrcaManagedWorktree({
              sourceDir: child.cwd,
              jobId,
              branchName: branchName!,
              title,
              prompt,
              mode,
            });
            worktree = prepared.worktree;
            initialTerminal = prepared.initialTerminal;
          } else if (
            !capacityUnavailable &&
            jobId &&
            policy.requiresWorktree &&
            harness !== "orca"
          ) {
            worktree = await createSubagentWorktree({
              sourceDir: child.cwd,
              workspaceRoot: path.join(getAgentDir(), "workspace"),
              jobId,
              branchName,
            });
          }
          if (provisioningRequired && worktree) {
            await provisioning.update(jobId!, {
              worktree,
              nativeWorktreeId: initialTerminal?.worktreeId,
            });
          }
        } catch (error) {
          if (worktree) {
            try {
              await cleanupManagedWorktree(
                harness,
                worktree,
                initialTerminal?.worktreeId,
              );
              if (jobId) await provisioning.remove(jobId);
            } catch {
              // Keep the provisioning intent for recovery when cleanup is unverified.
            }
          } else if (jobId && provisioningRequired) {
            // Keep the durable intent: the external creator may have succeeded
            // before throwing, so recovery must inspect/adopt the resource.
          }
          await releaseCapacity(jobId);
          releaseSpawnClaim(jobId);
          throw error;
        }
        const cwd = worktree?.path ?? child.cwd;

        const task = {
          jobId,
          branchName,
          prompt,
          title,
          cwd,
          worktree,
          initialTerminal,
          mode,
          role: "worker",
          ...((owningLeadAgentId ?? proposal?.leadAgentId) === undefined
            ? {}
            : { leadAgentId: owningLeadAgentId ?? proposal?.leadAgentId }),
          model: params.model as string | undefined,
          reasoningEffort: params.reasoning_effort as
            ReasoningEffort | undefined,
          timeoutMs: params.timeout_ms as number | undefined,
          parent: {
            parentCwd: ctx.cwd,
            projectTrusted: child.projectTrusted,
            parentStateRoot: stateRoot,
            coordinatorStateRoot:
              caller?.role === "lead"
                ? ((caller as { readonly coordinatorStateRoot?: string })
                    .coordinatorStateRoot ?? caller.parentStateRoot)
                : stateRoot,
            inheritedModel: ctx.model
              ? { provider: ctx.model.provider, id: ctx.model.id }
              : undefined,
            inheritedThinkingLevel: parseThinkingLevel(pi.getThinkingLevel()),
            modelRegistry: ctx.modelRegistry,
          },
        } as const;

        const leadOwnerId = owningLeadAgentId ?? proposal?.leadAgentId;
        if (leadOwnerId) {
          const owner = leadAgentStore.get(leadOwnerId);
          const ownerHomePath = owner?.homePath;
          const ownerStateRoot = ownerHomePath
            ? path.join(ownerHomePath, "state")
            : undefined;
          if (
            ownerHomePath &&
            ownerStateRoot &&
            !isLeadHomeRetired(ownerHomePath, leadOwnerId) &&
            fs.existsSync(ownerHomePath) &&
            path.resolve(ownerStateRoot) !== path.resolve(persistence.rootDir)
          ) {
            await new JobPersistence(ownerStateRoot).upsert({
              jobId: jobId!,
              backend: harness,
              role: "worker",
              leadAgentId: leadOwnerId,
              parentStateRoot: stateRoot,
              title,
              mode,
              cwd,
              status: "running",
              queued: dependsOn.length > 0 || capacityUnavailable,
              createdAt: Date.now(),
              worktreePath: worktree?.path,
              branch: worktree?.branch,
              repoRoot: worktree?.repoRoot,
            });
          }
        }

        const prepareProposalLedger = async () => {
          if (!proposal) return;
          const parent = await taskLedger.ensure({
            id: proposal.id,
            title: proposal.title,
            mode: proposal.mode,
            role: "worker",
            dependsOn: proposal.dependsOn,
            priority: proposal.priority,
            requiresWorktree: proposal.mode === "build",
            leadAgentId: proposal.leadAgentId,
          });
          if (parent.status === "queued")
            await taskLedger.status(parent.id, "working");
        };

        if (dependsOn.length > 0 || capacityUnavailable) {
          try {
            const queued = await jobQueue.enqueue(
              {
                id: jobId!,
                title,
                backend: harness,
                mode,
                dependsOn,
                priority: proposal?.priority ?? priority,
                task,
              },
              (id) => !!manager.view.get(id) || !!jobQueue.get(id),
            );
            await prepareProposalLedger();
            await taskLedger.ensure({
              id: jobId!,
              title,
              mode,
              role: "worker",
              dependsOn,
              priority: proposal?.priority ?? priority,
              requiresWorktree: policy.requiresWorktree,
              leadAgentId: owningLeadAgentId ?? proposal?.leadAgentId,
              parentTaskId: proposal?.id,
            });
            await workflowQueue.publish(jobId!, {
              type: "status",
              status: "queued",
              generation: 1,
              at: Date.now(),
            });
            if (proposalId) await leadAgentProposalStore.dispatch(proposalId);
            await dispatchQueuedJobs(manager);
            return {
              content: [
                {
                  type: "text",
                  text:
                    queued.dependsOn.length > 0
                      ? `Queued job ${queued.id} "${queued.title}" (priority ${queued.priority}); waiting for: ${queued.dependsOn.join(", ")}.`
                      : `Queued job ${queued.id} "${queued.title}" (priority ${queued.priority}); waiting for a global subagent capacity slot.`,
                },
              ],
              details: {
                id: queued.id,
                status: queued.status,
                dependsOn: queued.dependsOn,
                priority: queued.priority,
                cwd,
                branch: worktree?.branch,
                mode,
                harness,
              },
            };
          } catch (error) {
            if (worktree) {
              try {
                await cleanupManagedWorktree(
                  harness,
                  worktree,
                  initialTerminal?.worktreeId,
                );
              } catch {
                /* preserve a cleanup warning below */
              }
            }
            await removeLeadOwnedMirror(jobId!, leadOwnerId).catch(() => {});
            releaseSpawnClaim(jobId!);
            throw error;
          }
        }

        if (jobId) {
          await prepareProposalLedger();
          await taskLedger.ensure({
            id: jobId,
            title,
            mode,
            role: "worker",
            dependsOn,
            priority: proposal?.priority ?? priority,
            requiresWorktree: policy.requiresWorktree,
            leadAgentId: owningLeadAgentId ?? proposal?.leadAgentId,
            parentTaskId: proposal?.id,
          });
        }
        let snap: SubagentSnapshot;
        try {
          snap = await runTool(getRuntime(), manager.spawn(harness, task), {
            signal,
            interruptMessage: "Subagent spawn aborted.",
          });
        } catch (error) {
          if (worktree && !manager.view.get(jobId!)) {
            try {
              await cleanupManagedWorktree(
                harness,
                worktree,
                initialTerminal?.worktreeId,
              );
              if (jobId) await provisioning.remove(jobId);
            } catch {
              /* never force-delete output */
            }
          } else if (jobId && provisioningRequired) {
            // Preserve provisioning intent across uncertain external failures.
          }
          await removeLeadOwnedMirror(jobId!, leadOwnerId).catch(() => {});
          await releaseCapacity(jobId!);
          releaseSpawnClaim(jobId!);
          throw error;
        }
        await publishWorkflowStatus(snap, "working");
        const persisted = await persistSnapshot(snap, "spawned");
        if (persisted && jobId && provisioningRequired)
          await provisioning.remove(jobId);
        if (proposalId) await leadAgentProposalStore.dispatch(proposalId);

        return {
          content: [
            {
              type: "text",
              text: buildSubagentSpawnResult({
                id: snap.id,
                title: snap.title,
                harness,
                modelLabel: snap.meta.modelLabel ?? "?",
                cwd,
                branch: worktree?.branch,
                mode,
              }),
            },
          ],
          details: {
            id: snap.id,
            title: snap.title,
            cwd,
            branch: worktree?.branch,
            repoRoot: worktree?.repoRoot,
            mode,
            harness,
            model: snap.meta.modelLabel,
          },
        };
      } finally {
        await releaseLeadHomeLock?.();
      }
    },
  });

  pi.registerTool({
    name: "subagent_lead_doctor",
    label: "Check Agent Lead Readiness",
    description:
      "Check and optionally safely repair an Agent Lead environment without installing packages or changing credentials.",
    parameters: Type.Object({
      lead_agent_id: Type.String({ minLength: 1, maxLength: 128 }),
      auto_repair: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const leadAgentId = params.lead_agent_id as string;
      await assertLeadAgentToolRole(ctx, leadAgentId);
      const lead = leadAgentStore.get(leadAgentId);
      if (!lead?.homePath)
        throw new Error(`Unknown Agent Lead home: ${leadAgentId}`);
      const home = await resolveManagedLeadHome(
        lead.homePath,
        path.join(stateRoot!, "leads"),
      );
      if (!home)
        throw new Error(`Agent Lead home is missing: ${lead.homePath}`);
      const report = await runReadinessDoctor(
        home,
        params.auto_repair === true,
      );
      return {
        content: [{ type: "text", text: formatReadinessReport(report) }],
        details: report,
      };
    },
  });

  pi.registerTool({
    name: "subagent_lead_create",
    label: "Create Agent Lead",
    description: SUBAGENT_LEAD_AGENT_CREATE_TOOL_DESCRIPTION,
    parameters: Type.Object({
      lead_agent_id: Type.String({
        minLength: 1,
        maxLength: 128,
        description: SUBAGENT_LEAD_AGENT_PARAMETER_DESCRIPTIONS.leadAgentId,
      }),
      name: Type.String({
        minLength: 1,
        maxLength: 160,
        description: SUBAGENT_LEAD_AGENT_PARAMETER_DESCRIPTIONS.name,
      }),
      prompt: Type.String({
        minLength: 1,
        maxLength: 32_000,
        description: SUBAGENT_LEAD_AGENT_PARAMETER_DESCRIPTIONS.prompt,
      }),
      charter: Type.Optional(
        Type.String({
          maxLength: 32_000,
          description: "Persistent Agent Lead domain charter.",
        }),
      ),
      scope: Type.Optional(
        Type.String({
          maxLength: 4_096,
          description: "Agent Lead routing scope.",
        }),
      ),
      projects: Type.Array(
        Type.Object({
          project_id: Type.String({ minLength: 1, maxLength: 128 }),
          source: Type.String({ minLength: 1, maxLength: 4_096 }),
        }),
        {
          minItems: 1,
          maxItems: 32,
          description:
            "Explicit local paths or Git URLs to clone into the Agent Lead home.",
        },
      ),
      working_dir: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      await assertParentToolRole(ctx);
      const manager = await getManager();
      const leadAgentId = (params.lead_agent_id as string).trim();
      return await withLeadLifecycleLock(leadAgentId, async () => {
        const title = (params.name as string).trim().slice(0, 160);
        if (!isLeadHomeId(leadAgentId))
          throw new Error(`Invalid Agent Lead id: ${leadAgentId}`);
        const mode: SubagentMode = "scout";
        const policy = resolveExecutionPolicy(mode, "pi");
        const harness = policy.backend;
        if (leadAgentStore.get(leadAgentId))
          throw new Error(`Agent Lead already exists: ${leadAgentId}`);
        const requestedCwd = path.resolve(
          ctx.cwd,
          (params.working_dir as string | undefined) ?? ".",
        );
        const child = resolveTrustedChildCwd({
          parentCwd: ctx.cwd,
          requestedCwd,
          parentTrusted: ctx.isProjectTrusted(),
        });
        const projectInputs = (await Promise.all(
          (
            (params.projects as ReadonlyArray<{
              project_id: string;
              source: string;
            }>) ?? []
          ).map(async (project) => {
            const source = project.source.trim();
            if (validateLeadProjectSource(source) === "remote")
              return { projectId: project.project_id, source };
            const trustedSource = resolveTrustedChildCwd({
              parentCwd: child.cwd,
              requestedCwd: path.resolve(child.cwd, source),
              parentTrusted: child.projectTrusted,
            });
            return { projectId: project.project_id, source: trustedSource.cwd };
          }),
        )) satisfies ReadonlyArray<LeadProjectInput>;
        const jobId = createLeadJobId(title);
        const homePath = path.join(stateRoot!, "leads", leadAgentId);
        const homeStateRoot = path.join(homePath, "state");
        const homeStore = new LeadHomeStore(homePath);
        let provisionedProjects: ReadonlyArray<LeadProject> = [];
        await waitForCapacity(jobId, signal);
        try {
          fs.mkdirSync(path.dirname(homePath), { recursive: true });
          try {
            fs.mkdirSync(homePath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST")
              throw new Error(`Agent Lead home already exists: ${homePath}`);
            throw error;
          }
          await clearLeadHomeRetiredMarker(homePath, leadAgentId);
          await homeStore.create({
            leadAgentId,
            homePath,
            stateRoot: homeStateRoot,
            parentStateRoot: stateRoot!,
            projects: [],
            status: "provisioning",
          });
          const readiness = await runReadinessDoctor(homePath, true);
          if (!readiness.ready)
            throw new Error(
              `Agent Lead environment is not ready.\n${formatReadinessReport(readiness)}`,
            );
          provisionedProjects = await provisionLeadProjects(
            homePath,
            projectInputs,
          );
          await homeStore.setProjects(provisionedProjects);
          await homeStore.transition("active");
          await leadAgentStore.create({
            leadAgentId,
            jobId,
            title,
            backend: harness,
            mode,
            charter: params.charter as string | undefined,
            scope: params.scope as string | undefined,
            cwd: homePath,
            homePath,
          });
        } catch (error) {
          await leadAgentStore.removeByJobId(jobId).catch(() => {});
          await releaseCapacity(jobId);
          await deleteLeadHome(homePath).catch(() => {});
          throw error;
        }
        const homeLeadStore = new LeadAgentStore(homeStateRoot);
        const homePersistence = new JobPersistence(homeStateRoot);
        try {
          await homeLeadStore.create({
            leadAgentId,
            jobId,
            title,
            backend: harness,
            mode,
            charter: params.charter as string | undefined,
            scope: params.scope as string | undefined,
            cwd: homePath,
            homePath,
          });
          await homePersistence.upsert({
            jobId,
            backend: harness,
            role: "lead",
            leadAgentId,
            parentStateRoot: stateRoot!,
            title,
            mode,
            cwd: homePath,
            status: "running",
            createdAt: Date.now(),
          });
        } catch (error) {
          await leadAgentStore.removeByJobId(jobId).catch(() => {});
          await releaseCapacity(jobId);
          await deleteLeadHome(homePath).catch(() => {});
          throw error;
        }
        const leadAgentPrompt = [
          `You are the persistent Agent Lead ${leadAgentId}, a Coordinator for your own home.`,
          `Lead home: ${homePath}`,
          "You may spawn, inspect, steer, retry, and cancel Scout or Build Subagents inside this home.",
          "Use Agent Lead events for delivery, destructive operations, escalations, questions, and worker outcomes; the parent Coordinator owns final approval.",
          provisionedProjects.length > 0
            ? `Projects: ${provisionedProjects.map((project) => `${project.projectId}=${project.clonePath}`).join(", ")}`
            : "Projects: none",
          params.charter ? `Charter: ${params.charter as string}` : undefined,
          params.scope ? `Scope: ${params.scope as string}` : undefined,
          `Initial briefing: ${params.prompt as string}`,
        ]
          .filter(Boolean)
          .join("\n\n");
        const task = {
          jobId,
          prompt: leadAgentPrompt,
          title,
          cwd: homePath,
          mode,
          role: "lead",
          leadAgentId,
          sessionDir: path.join(homePath, "sessions"),
          parent: {
            parentCwd: ctx.cwd,
            projectTrusted: true,
            parentStateRoot: homeStateRoot,
            coordinatorStateRoot: stateRoot!,
            inheritedModel: ctx.model
              ? { provider: ctx.model.provider, id: ctx.model.id }
              : undefined,
            inheritedThinkingLevel: parseThinkingLevel(pi.getThinkingLevel()),
            modelRegistry: ctx.modelRegistry,
          },
        } as const;
        let snap: SubagentSnapshot;
        try {
          snap = await runTool(getRuntime(), manager.spawn(harness, task), {
            signal,
            interruptMessage: "Agent Lead creation aborted.",
          });
        } catch (error) {
          await leadAgentStore.removeByJobId(jobId).catch(() => {});
          await releaseCapacity(jobId);
          await deleteLeadHome(homePath).catch(() => {});
          throw error;
        }
        try {
          await homeLeadStore.update(leadAgentId, {
            jobId: snap.id,
            cwd: snap.cwd,
            sessionFilePath: snap.meta.sessionFilePath,
          });
          await homePersistence.upsert({
            jobId: snap.id,
            backend: harness,
            role: "lead",
            leadAgentId,
            sessionFilePath: snap.meta.sessionFilePath,
            parentStateRoot: stateRoot!,
            title,
            mode,
            cwd: snap.cwd,
            status: "running",
            createdAt: snap.createdAt,
          });
          await leadAgentStore.update(leadAgentId, {
            jobId: snap.id,
            sessionFilePath: snap.meta.sessionFilePath,
            cwd: snap.cwd,
          });
        } catch (error) {
          try {
            if (snap.status === "running")
              await runTool(getRuntime(), manager.cancel([snap.id]));
            await runTool(getRuntime(), manager.closeSession(snap.id));
          } catch {
            // Preserve the original registry error; the session remains recoverable.
          }
          await releaseCapacity(jobId);
          await deleteLeadHome(homePath).catch(() => {});
          throw error;
        }
        await syncLedgerStatus({
          taskId: snap.id,
          title,
          mode,
          role: "subagent-lead",
          status: "working",
          leadAgentId,
          requiresWorktree: false,
        });
        await publishWorkflowStatus(snap, "working");
        await persistSnapshot(snap, "lead-agent-created");
        return {
          content: [
            {
              type: "text",
              text: `Created Agent Lead ${leadAgentId} using job ${snap.id}. Use subagent_lead_send for follow-ups.`,
            },
          ],
          details: {
            leadAgentId,
            jobId: snap.id,
            mode,
            backend: harness,
            homePath,
          },
        };
      });
    },
  });

  pi.registerTool({
    name: "subagent_lead_send",
    label: "Send Agent Lead",
    description: SUBAGENT_LEAD_AGENT_SEND_TOOL_DESCRIPTION,
    parameters: Type.Object({
      lead_agent_id: Type.String({
        minLength: 1,
        maxLength: 128,
        description: SUBAGENT_LEAD_AGENT_PARAMETER_DESCRIPTIONS.leadAgentId,
      }),
      prompt: Type.String({
        minLength: 1,
        maxLength: 32_000,
        description: SUBAGENT_LEAD_AGENT_PARAMETER_DESCRIPTIONS.prompt,
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      await assertParentToolRole(ctx);
      const manager = await getManager();
      const leadAgentId = params.lead_agent_id as string;
      return await withLeadLifecycleLock(leadAgentId, async () => {
        const leadAgent = leadAgentStore.get(leadAgentId);
        if (!leadAgent) throw new Error(`Unknown Agent Lead: ${leadAgentId}`);
        const current = await runTool(
          getRuntime(),
          manager.get(leadAgent.jobId),
        );
        if (current && current.status !== "failed") {
          const acquired = current.status !== "running";
          if (acquired) await waitForCapacity(leadAgent.jobId, signal);
          let sent = false;
          try {
            await runTool(
              getRuntime(),
              manager.send(leadAgent.jobId, params.prompt as string),
              { signal, interruptMessage: "Agent Lead follow-up aborted." },
            );
            sent = true;
          } catch (error) {
            if (acquired) await releaseCapacity(leadAgent.jobId);
            // Never create a duplicate while the existing Agent Lead is running.
            if (current.status === "running") throw error;
            // A restored or pruned session may no longer be sendable. Reopen below.
          }
          if (sent) {
            stoppingLeadIds.delete(leadAgent.leadAgentId);
            if (leadAgent.homePath) {
              const homeStore = new LeadHomeStore(leadAgent.homePath);
              await homeStore.restore();
              if (
                homeStore.get()?.status === "paused" ||
                homeStore.get()?.status === "recovery-required"
              ) {
                await homeStore.transition("active");
              }
            }
            await leadAgentStore.update(leadAgentId, {
              lastSummary: params.prompt as string,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Follow-up sent to Agent Lead ${leadAgentId} (job ${leadAgent.jobId}).`,
                },
              ],
              details: { leadAgentId, jobId: leadAgent.jobId },
            };
          }
        }
        const newJobId = createLeadJobId(leadAgent.title, "follow-up");
        const leadHomePath = await resolveManagedLeadHome(
          leadAgent.homePath,
          path.join(stateRoot!, "leads"),
        );
        if (leadAgent.homePath && !leadHomePath) {
          throw new Error(`Agent Lead home is missing: ${leadAgent.homePath}`);
        }
        const trusted = leadHomePath
          ? { cwd: leadHomePath, projectTrusted: true }
          : resolveTrustedChildCwd({
              parentCwd: ctx.cwd,
              requestedCwd: leadAgent.repoRoot ?? leadAgent.cwd,
              parentTrusted: ctx.isProjectTrusted(),
            });
        const sessionFilePath = await resolveManagedSessionFile(
          leadAgent.sessionFilePath,
          [
            path.join(getAgentDir(), "sessions"),
            path.join(stateRoot!, "leads"),
          ],
        );
        await waitForCapacity(newJobId, signal);
        const task = {
          jobId: newJobId,
          prompt: [
            `You are the Agent Lead ${leadAgentId}, continuing a prior session.`,
            leadAgent.charter ? `Charter: ${leadAgent.charter}` : undefined,
            leadAgent.scope ? `Scope: ${leadAgent.scope}` : undefined,
            `Previous summary: ${leadAgent.lastSummary ?? "none"}.`,
            `Follow-up: ${params.prompt as string}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
          title: leadAgent.title,
          cwd: trusted.cwd,
          mode: "scout",
          role: "lead",
          leadAgentId,
          sessionFilePath,
          sessionDir: leadHomePath
            ? path.join(leadHomePath, "sessions")
            : undefined,
          parent: {
            parentCwd: ctx.cwd,
            projectTrusted: trusted.projectTrusted,
            parentStateRoot: leadHomePath
              ? path.join(leadHomePath, "state")
              : stateRoot,
            inheritedModel: ctx.model
              ? { provider: ctx.model.provider, id: ctx.model.id }
              : undefined,
            inheritedThinkingLevel: parseThinkingLevel(pi.getThinkingLevel()),
            modelRegistry: ctx.modelRegistry,
          },
        } as const;
        let reopened: SubagentSnapshot;
        try {
          reopened = await runTool(getRuntime(), manager.spawn("pi", task), {
            signal,
            interruptMessage: "Agent Lead reopen aborted.",
          });
        } catch (error) {
          await releaseCapacity(newJobId);
          throw error;
        }
        await syncLedgerStatus({
          taskId: reopened.id,
          title: leadAgent.title,
          mode: "scout",
          role: "subagent-lead",
          status: "working",
          leadAgentId,
          requiresWorktree: false,
        });
        if (leadHomePath) {
          const homeStateRoot = path.join(leadHomePath, "state");
          const homeLeadStore = new LeadAgentStore(homeStateRoot);
          await homeLeadStore.restore();
          const localLead = homeLeadStore.get(leadAgentId);
          if (localLead) {
            await homeLeadStore.update(leadAgentId, {
              jobId: reopened.id,
              backend: "pi",
              mode: "scout",
              sessionFilePath: reopened.meta.sessionFilePath,
            });
          } else {
            await homeLeadStore.create({
              leadAgentId,
              jobId: reopened.id,
              title: leadAgent.title,
              backend: "pi",
              mode: "scout",
              charter: leadAgent.charter,
              scope: leadAgent.scope,
              cwd: reopened.cwd,
              homePath: leadHomePath,
              sessionFilePath: reopened.meta.sessionFilePath,
            });
          }
          const homePersistence = new JobPersistence(homeStateRoot);
          await homePersistence.deleteJob(leadAgent.jobId);
          await homePersistence.upsert({
            jobId: reopened.id,
            backend: "pi",
            role: "lead",
            leadAgentId,
            sessionFilePath: reopened.meta.sessionFilePath,
            parentStateRoot: stateRoot!,
            title: leadAgent.title,
            mode: "scout",
            cwd: reopened.cwd,
            status: "running",
            createdAt: reopened.createdAt,
          });
        }
        const previousJobId = leadAgent.jobId;
        await leadAgentStore.update(leadAgentId, {
          jobId: reopened.id,
          backend: "pi",
          mode: "scout",
          lastSummary: params.prompt as string,
          sessionFilePath: reopened.meta.sessionFilePath,
        });
        if (previousJobId !== reopened.id) {
          await subagentMonitor.forgetJob(previousJobId);
          resultDelivery.consume([previousJobId]);
          approvalGate.forgetJob(previousJobId);
          await runTool(getRuntime(), manager.forget(previousJobId));
          await provisioning.remove(previousJobId);
          await jobQueue.remove(previousJobId);
          await workflowQueue.removeTask(previousJobId);
          await taskLedger.remove(previousJobId);
          await persistence.deleteJob(previousJobId);
        }
        if (leadHomePath) {
          const homeStore = new LeadHomeStore(leadHomePath);
          await homeStore.restore();
          if (
            homeStore.get()?.status === "paused" ||
            homeStore.get()?.status === "recovery-required"
          ) {
            await homeStore.transition("active");
          }
        }
        await publishWorkflowStatus(reopened, "working");
        await persistSnapshot(reopened, "lead-agent-reopened");
        return {
          content: [
            {
              type: "text",
              text: `Agent Lead ${leadAgentId} reopened as job ${reopened.id}.`,
            },
          ],
          details: { leadAgentId, jobId: reopened.id, reopened: true },
        };
      });
    },
  });

  pi.registerTool({
    name: "subagent_lead_stop",
    label: "Stop Agent Lead",
    description: SUBAGENT_LEAD_AGENT_STOP_TOOL_DESCRIPTION,
    parameters: Type.Object({
      lead_agent_id: Type.String({
        minLength: 1,
        maxLength: 128,
        description: SUBAGENT_LEAD_AGENT_PARAMETER_DESCRIPTIONS.leadAgentId,
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      await assertParentToolRole(ctx);
      const manager = await getManager();
      const leadAgentId = params.lead_agent_id as string;
      return await withLeadLifecycleLock(leadAgentId, async () => {
        const leadAgent = leadAgentStore.get(leadAgentId);
        if (!leadAgent)
          throw new Error(`Unknown Agent Lead: ${params.lead_agent_id}`);
        const current = await runTool(
          getRuntime(),
          manager.get(leadAgent.jobId),
        );
        if (current?.status === "running" || current?.restarting) {
          stoppingLeadIds.add(leadAgent.leadAgentId);
          try {
            await runTool(getRuntime(), manager.cancel([leadAgent.jobId]), {
              signal,
              interruptMessage: "Agent Lead stop aborted.",
            });
          } catch (error) {
            stoppingLeadIds.delete(leadAgent.leadAgentId);
            throw error;
          }
        }
        if (current && current.status !== "running" && !current.restarting) {
          await publishWorkflowStatus(
            current,
            "paused",
            "Agent Lead was stopped by the Coordinator.",
          );
        }
        if (leadAgent.homePath) {
          const homeStore = new LeadHomeStore(leadAgent.homePath);
          await homeStore.restore();
          if (homeStore.get()?.status === "active") {
            await homeStore.transition("paused");
          }
        }
        return {
          content: [
            {
              type: "text",
              text: `Stopped Agent Lead ${leadAgent.leadAgentId}; its home and project clones were preserved.`,
            },
          ],
          details: {
            leadAgentId: leadAgent.leadAgentId,
            jobId: leadAgent.jobId,
            stopped: true,
            homePath: leadAgent.homePath,
          },
        };
      });
    },
  });

  pi.registerTool({
    name: "subagent_lead_retire",
    label: "Retire Agent Lead Home",
    description:
      "Request Coordinator approval to permanently delete a stopped Agent Lead home and its project clones.",
    parameters: Type.Object({
      lead_agent_id: Type.String({
        minLength: 1,
        maxLength: 128,
        description: SUBAGENT_LEAD_AGENT_PARAMETER_DESCRIPTIONS.leadAgentId,
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await assertParentToolRole(ctx);
      const manager = await getManager();
      const leadAgentId = params.lead_agent_id as string;
      return await withLeadLifecycleLock(leadAgentId, async () => {
        const leadAgent = leadAgentStore.get(leadAgentId);
        if (!leadAgent) throw new Error(`Unknown Agent Lead: ${leadAgentId}`);
        if (!leadAgent.homePath)
          throw new Error("This Agent Lead has no managed home to retire.");
        const current = await runTool(
          getRuntime(),
          manager.get(leadAgent.jobId),
        );
        if (current?.status === "running" || current?.restarting)
          throw new Error("Stop the Agent Lead before retiring its home.");
        const home = await resolveManagedLeadHome(
          leadAgent.homePath,
          path.join(stateRoot!, "leads"),
        );
        if (!home)
          throw new Error(`Agent Lead home is missing: ${leadAgent.homePath}`);
        const homeJobs = await new JobPersistence(
          path.join(home, "state"),
        ).load();
        const activeWorkers = homeJobs.filter(
          (job) =>
            job.jobId !== leadAgent.jobId &&
            (job.status === "running" ||
              job.errorText?.includes("recovery_required")),
        );
        if (activeWorkers.length > 0) {
          throw new Error(
            `Cannot retire Agent Lead home while owned workers are active or recovering: ${activeWorkers.map((job) => job.jobId).join(", ")}.`,
          );
        }
        const request =
          approvalGate.get(`approval:${leadAgent.jobId}:retire-lead`) ??
          approvalGate.request({
            jobId: leadAgent.jobId,
            operation: "retire-lead",
            mode: "build",
          });
        await persistApprovals();
        return {
          content: [
            {
              type: "text",
              text: `Agent Lead home retirement approval ${request.status}: ${request.id}.`,
            },
          ],
          details: { request, leadAgentId, homePath: home },
        };
      });
    },
  });

  pi.registerTool({
    name: "subagent_lead_event",
    label: "Emit Agent Lead Event",
    description: SUBAGENT_LEAD_AGENT_EVENT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      event_id: Type.String({
        minLength: 1,
        maxLength: 128,
        description: SUBAGENT_LEAD_AGENT_EVENT_PARAMETER_DESCRIPTIONS.eventId,
      }),
      type: StringEnum(LEAD_AGENT_EVENT_TYPES, {
        description: SUBAGENT_LEAD_AGENT_EVENT_PARAMETER_DESCRIPTIONS.type,
      }),
      actor_id: Type.String({
        minLength: 1,
        maxLength: 128,
        description: SUBAGENT_LEAD_AGENT_EVENT_PARAMETER_DESCRIPTIONS.actorId,
      }),
      lead_agent_id: Type.String({
        minLength: 1,
        maxLength: 128,
        description:
          SUBAGENT_LEAD_AGENT_EVENT_PARAMETER_DESCRIPTIONS.leadAgentId,
      }),
      task_id: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 128,
          description: SUBAGENT_LEAD_AGENT_EVENT_PARAMETER_DESCRIPTIONS.taskId,
        }),
      ),
      correlation_id: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 128,
          description:
            SUBAGENT_LEAD_AGENT_EVENT_PARAMETER_DESCRIPTIONS.correlationId,
        }),
      ),
      proposal_id: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 128,
          description:
            SUBAGENT_LEAD_AGENT_EVENT_PARAMETER_DESCRIPTIONS.proposalId,
        }),
      ),
      title: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 160,
          description: SUBAGENT_LEAD_AGENT_EVENT_PARAMETER_DESCRIPTIONS.title,
        }),
      ),
      prompt: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 32_000,
          description: SUBAGENT_LEAD_AGENT_EVENT_PARAMETER_DESCRIPTIONS.prompt,
        }),
      ),
      working_dir: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 4_096,
          description:
            "Project directory inside the managed Lead home for this proposal.",
        }),
      ),
      mode: Type.Optional(
        StringEnum(SUBAGENT_MODES, {
          description: SUBAGENT_LEAD_AGENT_EVENT_PARAMETER_DESCRIPTIONS.mode,
        }),
      ),
      depends_on: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
          maxItems: 16,
          description:
            SUBAGENT_LEAD_AGENT_EVENT_PARAMETER_DESCRIPTIONS.dependsOn,
        }),
      ),
      priority: Type.Optional(
        Type.Integer({
          minimum: -100,
          maximum: 100,
          description:
            SUBAGENT_LEAD_AGENT_EVENT_PARAMETER_DESCRIPTIONS.priority,
        }),
      ),
      summary: Type.Optional(
        Type.String({
          maxLength: 4_096,
          description: SUBAGENT_LEAD_AGENT_EVENT_PARAMETER_DESCRIPTIONS.summary,
        }),
      ),
      reason: Type.Optional(
        Type.String({
          maxLength: 4_096,
          description: SUBAGENT_LEAD_AGENT_EVENT_PARAMETER_DESCRIPTIONS.reason,
        }),
      ),
      question: Type.Optional(
        Type.String({
          maxLength: 4_096,
          description:
            SUBAGENT_LEAD_AGENT_EVENT_PARAMETER_DESCRIPTIONS.question,
        }),
      ),
      answer: Type.Optional(
        Type.String({
          maxLength: 4_096,
          description: SUBAGENT_LEAD_AGENT_EVENT_PARAMETER_DESCRIPTIONS.answer,
        }),
      ),
      reply_to: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 128,
          description: SUBAGENT_LEAD_AGENT_EVENT_PARAMETER_DESCRIPTIONS.replyTo,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await assertLeadAgentToolRole(ctx, params.lead_agent_id as string);
      const caller = await findCallingSubagent(ctx);
      const event = parseLeadAgentEvent({
        eventId: params.event_id,
        type: params.type,
        actorId:
          caller?.role === "lead"
            ? (caller.leadAgentId ?? params.actor_id)
            : "parent",
        leadAgentId: params.lead_agent_id,
        taskId: params.task_id,
        correlationId: params.correlation_id,
        proposalId: params.proposal_id,
        title: params.title,
        prompt: params.prompt,
        workingDir: params.working_dir,
        mode: params.mode,
        dependsOn: params.depends_on ?? [],
        priority: params.priority ?? 0,
        summary: params.summary,
        reason: params.reason,
        question: params.question,
        answer: params.answer,
        replyTo: params.reply_to,
        at: Date.now(),
      });
      if (caller) {
        await resolveCallerParentInbox(caller).enqueue(event);
        return {
          content: [
            {
              type: "text",
              text: `${event.type} event ${event.eventId} was queued for the parent runtime.`,
            },
          ],
          details: event,
        };
      }
      await getManager();
      const result = await orchestrationCoordinator!.emit(event);
      return {
        content: [
          {
            type: "text",
            text: `${event.type} event ${event.eventId} ${result.duplicate ? "was already recorded" : "was recorded"}.`,
          },
        ],
        details: event,
      };
    },
  });

  pi.registerTool({
    name: "subagent_lead_propose",
    label: "Propose Agent Lead Child",
    description:
      "Record a child task proposed for an Agent Lead. Dispatch requires explicit parent approval.",
    parameters: Type.Object({
      lead_agent_id: Type.String({ minLength: 1, maxLength: 128 }),
      proposal_id: Type.String({ minLength: 1, maxLength: 128 }),
      name: Type.String({ minLength: 1, maxLength: 160 }),
      prompt: Type.String({ minLength: 1, maxLength: 32_000 }),
      working_dir: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 4_096,
          description: "Project directory inside the managed Lead home.",
        }),
      ),
      mode: Type.Optional(StringEnum(SUBAGENT_MODES)),
      depends_on: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
          maxItems: 16,
        }),
      ),
      priority: Type.Optional(Type.Integer({ minimum: -100, maximum: 100 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await assertLeadAgentToolRole(ctx, params.lead_agent_id as string);
      const caller = await findCallingSubagent(ctx);
      const event = parseLeadAgentEvent({
        eventId: `proposal-${params.proposal_id as string}`,
        type: "proposal",
        actorId:
          caller?.role === "lead" ? (caller.leadAgentId ?? "parent") : "parent",
        leadAgentId: params.lead_agent_id,
        proposalId: params.proposal_id,
        title: params.name,
        prompt: params.prompt,
        workingDir: params.working_dir,
        mode: (params.mode as SubagentMode | undefined) ?? "build",
        dependsOn: params.depends_on ?? [],
        priority: params.priority ?? 0,
        at: Date.now(),
      });
      if (event.type !== "proposal")
        throw new Error("Agent Lead proposal event was malformed.");
      if (caller) {
        await resolveCallerParentInbox(caller).enqueue(event);
        return {
          content: [
            {
              type: "text",
              text: `Agent Lead child proposal ${event.proposalId} was queued for the parent runtime.`,
            },
          ],
          details: event,
        };
      }
      await getManager();
      await orchestrationCoordinator!.emit(event);
      const proposal = leadAgentProposalStore.get(event.proposalId);
      return {
        content: [
          {
            type: "text",
            text: `Agent Lead child proposal ${event.proposalId} recorded and awaits parent approval.`,
          },
        ],
        details: proposal ?? event,
      };
    },
  });

  pi.registerTool({
    name: "subagent_lead_approve",
    label: "Approve Agent Lead Child",
    description:
      "Approve an Agent Lead child proposal. The approved proposal must be passed to subagent_spawn with proposal_id.",
    parameters: Type.Object({
      proposal_id: Type.String({ minLength: 1, maxLength: 128 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await assertParentToolRole(ctx);
      const proposal = await leadAgentProposalStore.approve(
        params.proposal_id as string,
      );
      return {
        content: [
          {
            type: "text",
            text: `Agent Lead proposal ${proposal.id} approved. Dispatch it with subagent_spawn using proposal_id=${proposal.id}.`,
          },
        ],
        details: proposal,
      };
    },
  });

  pi.registerTool({
    name: "subagent_lead_reject",
    label: "Reject Agent Lead Child",
    description: "Reject an Agent Lead child proposal with a durable reason.",
    parameters: Type.Object({
      proposal_id: Type.String({ minLength: 1, maxLength: 128 }),
      reason: Type.String({ minLength: 1, maxLength: 4_096 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await assertParentToolRole(ctx);
      const proposal = await leadAgentProposalStore.reject(
        params.proposal_id as string,
        params.reason as string,
      );
      return {
        content: [
          {
            type: "text",
            text: `Agent Lead proposal ${proposal.id} rejected.`,
          },
        ],
        details: proposal,
      };
    },
  });

  pi.registerTool({
    name: "subagent_retry",
    label: "Retry Subagent",
    description: SUBAGENT_RETRY_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        minLength: 1,
        maxLength: 128,
        description: SUBAGENT_RETRY_PARAMETER_DESCRIPTIONS.id,
      }),
      prompt: Type.Optional(
        Type.String({
          maxLength: 32_000,
          description: SUBAGENT_RETRY_PARAMETER_DESCRIPTIONS.prompt,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const manager = await getManager();
      const id = params.id as string;
      const queued = jobQueue.get(id);
      if (queued?.status === "blocked") {
        const prompt =
          typeof params.prompt === "string" && params.prompt.trim().length > 0
            ? params.prompt
            : queued.task.prompt;
        if (prompt.trim().length === 0) {
          throw new Error(
            `Blocked job ${id} has no persisted briefing; provide a complete prompt to re-enqueue it.`,
          );
        }
        const requestedCwd = path.resolve(ctx.cwd, queued.task.cwd || ".");
        const child = resolveTrustedChildCwd({
          parentCwd: ctx.cwd,
          requestedCwd,
          parentTrusted: ctx.isProjectTrusted(),
        });
        const task: SpawnTask = {
          ...queued.task,
          jobId: id,
          prompt,
          cwd: child.cwd,
          parent: {
            ...queued.task.parent,
            parentCwd: ctx.cwd,
            projectTrusted: child.projectTrusted,
            modelRegistry: ctx.modelRegistry,
            ...(ctx.model
              ? {
                  inheritedModel: {
                    provider: ctx.model.provider,
                    id: ctx.model.id,
                  },
                }
              : {}),
            inheritedThinkingLevel: parseThinkingLevel(pi.getThinkingLevel()),
          },
        };
        const requeued = await jobQueue.requeue(id, task);
        await dispatchQueuedJobs(manager);
        const snap = await runTool(getRuntime(), manager.get(id));
        if (snap) {
          await publishWorkflowStatus(snap, "working");
          await persistSnapshot(snap, "re-enqueued");
        }
        return {
          content: [
            { type: "text", text: `Re-enqueued blocked subagent job ${id}.` },
          ],
          details: {
            id,
            status: snap?.status ?? requeued.status,
            restartCount: snap?.metrics.restartCount ?? 0,
          },
        };
      }
      await waitForCapacity(id, signal);
      try {
        await runTool(
          getRuntime(),
          manager.retry(id, params.prompt as string | undefined),
          {
            signal,
            interruptMessage:
              "Retry aborted; the preserved subagent worktree remains available.",
          },
        );
      } catch (error) {
        await releaseCapacity(id);
        throw error;
      }
      const snap = await runTool(getRuntime(), manager.get(id));
      if (snap) {
        await publishWorkflowStatus(snap, "working");
        await persistSnapshot(snap, "retry-requested");
      }
      return {
        content: [
          { type: "text", text: `Retry requested for subagent ${id}.` },
        ],
        details: {
          id,
          status: snap?.status,
          restartCount: snap?.metrics.restartCount,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_action_list",
    label: "List Subagent Actions",
    description: SUBAGENT_ACTION_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const actions = actionQueue.list();
      const text =
        actions.length === 0
          ? "No action items."
          : actions
              .map(
                (action) =>
                  `${action.status}: ${action.event.actionId} [${action.event.type}] job=${action.event.jobId} — ${action.event.message}`,
              )
              .join("\\n");
      return { content: [{ type: "text", text }], details: { actions } };
    },
  });

  pi.registerTool({
    name: "subagent_action_confirm",
    label: "Confirm Subagent Action",
    description: SUBAGENT_ACTION_CONFIRM_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        minLength: 1,
        maxLength: 256,
        description: SUBAGENT_ACTION_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    async execute(_toolCallId, params) {
      const confirmed = await actionQueue.confirm(params.id as string);
      return {
        content: [
          {
            type: "text",
            text: `Action confirmed: ${confirmed.event.actionId}.`,
          },
        ],
        details: confirmed,
      };
    },
  });

  pi.registerTool({
    name: "subagent_deliver",
    label: "Deliver Subagent Changes",
    description: SUBAGENT_DELIVER_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        minLength: 1,
        maxLength: 128,
        description: SUBAGENT_DELIVER_PARAMETER_DESCRIPTIONS.id,
      }),
      operation: StringEnum(
        ["review", "commit", "merge", "push", "pr"] as const,
        {
          description: SUBAGENT_DELIVER_PARAMETER_DESCRIPTIONS.operation,
        },
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await assertParentToolRole(ctx);
      const manager = await getManager();
      const jobId = params.id as string;
      const operation = params.operation as
        "review" | "commit" | "merge" | "push" | "pr";
      const snap = await runTool(getRuntime(), manager.get(jobId));
      if (!snap) throw new Error(`Unknown subagent id: ${jobId}`);
      if (snap.status === "running")
        throw new Error("Cannot deliver a running subagent.");
      if (snap.meta.mode !== "build" || !snap.meta.worktree) {
        throw new Error(
          "Only settled build subagents with a worktree can be delivered.",
        );
      }
      const missingPrerequisites = approvalGate.missingPrerequisites(
        jobId,
        operation,
      );
      if (missingPrerequisites.length > 0) {
        throw new Error(
          `Delivery ${operation} requires consumed approval(s): ${missingPrerequisites.join(", ")}.`,
        );
      }
      const request =
        approvalGate.get(`approval:${jobId}:${operation}`) ??
        approvalGate.request({ jobId, operation, mode: "build" });
      await persistApprovals();
      if (request.status === "approved") {
        const delivery = await executeApprovedDelivery(manager, request);
        return {
          content: [
            { type: "text", text: `Delivery complete: ${delivery.detail}.` },
          ],
          details: { request: delivery.consumed, detail: delivery.detail },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Approval required before ${operation}: ${request.id} (${request.status}).`,
          },
        ],
        details: { request, detail: "" },
      };
    },
  });

  pi.registerTool({
    name: "subagent_delete",
    label: "Delete Subagent Thread",
    description: SUBAGENT_DELETE_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        minLength: 1,
        maxLength: 128,
        description: SUBAGENT_DELETE_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await assertParentToolRole(ctx);
      const manager = await getManager();
      const id = params.id as string;
      if (leadAgentStore.list().some((lead) => lead.jobId === id)) {
        throw new Error(
          "Agent Lead homes require subagent_lead_retire and its approval-gated deletion flow.",
        );
      }
      const snap = await runTool(getRuntime(), manager.get(id));
      if (!snap) throw new Error(`Unknown subagent id: ${id}`);
      const confirmed = await confirmSubagentDeletion(ctx, snap);
      if (!confirmed)
        return {
          content: [{ type: "text", text: `Deletion cancelled for ${id}.` }],
          details: { id, deleted: false },
        };
      await deleteSubagentCompletely(manager, id);
      return {
        content: [
          {
            type: "text",
            text: `Deleted subagent Thread ${id}, session history, and managed worktree.`,
          },
        ],
        details: { id, deleted: true },
      };
    },
  });

  pi.registerTool({
    name: "subagent_retire",
    label: "Delete Subagent and Worktree",
    description: SUBAGENT_RETIRE_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        minLength: 1,
        maxLength: 128,
        description: SUBAGENT_RETIRE_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await assertParentToolRole(ctx);
      const manager = await getManager();
      const jobId = params.id as string;
      if (leadAgentStore.list().some((lead) => lead.jobId === jobId)) {
        throw new Error(
          "Agent Lead homes require subagent_lead_retire and its approval-gated deletion flow.",
        );
      }
      const snap = await runTool(getRuntime(), manager.get(jobId));
      if (!snap) throw new Error(`Unknown subagent id: ${jobId}`);
      if (snap.status === "running")
        throw new Error("Cannot retire a running subagent.");
      if (snap.meta.mode !== "build" || !snap.meta.worktree) {
        throw new Error("Only settled build worktrees can be retired.");
      }
      const request =
        approvalGate.get(`approval:${jobId}:delete-worktree`) ??
        approvalGate.request({
          jobId,
          operation: "delete-worktree",
          mode: "build",
        });
      await persistApprovals();
      return {
        content: [
          {
            type: "text",
            text: `Full subagent deletion approval ${request.status}: ${request.id}.`,
          },
        ],
        details: request,
      };
    },
  });

  pi.registerTool({
    name: "subagent_approve",
    label: "Approve Subagent Delivery",
    description: SUBAGENT_APPROVE_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        minLength: 1,
        maxLength: 256,
        description: SUBAGENT_APPROVE_PARAMETER_DESCRIPTIONS.id,
      }),
      decision: StringEnum(["approve", "reject"] as const, {
        description: SUBAGENT_APPROVE_PARAMETER_DESCRIPTIONS.decision,
      }),
      reason: Type.Optional(
        Type.String({
          maxLength: 4096,
          description:
            "Required when decision is reject; ignored when approving.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await assertParentToolRole(ctx);
      const manager = await getManager();
      const id = params.id as string;
      const request = approvalGate.get(id);
      if (!request) throw new Error(`Unknown approval request: ${id}`);
      const decision = params.decision as "approve" | "reject";
      if (decision === "approve") {
        const confirmed = await ctx.ui.confirm(
          `Approve ${request.operation}`,
          `Allow ${request.operation} for build job ${request.jobId}? This may change Git state or external repositories.`,
        );
        if (!confirmed) {
          return {
            content: [
              {
                type: "text",
                text: `Human confirmation declined: ${request.id}.`,
              },
            ],
            details: request,
          };
        }
      }
      let result =
        decision === "approve"
          ? approvalGate.approve(id)
          : approvalGate.reject(
              id,
              (params.reason as string | undefined) ?? "",
            );
      await persistApprovals();
      if (result.status === "approved" && result.operation === "retire-lead") {
        await executeLeadRetirement(manager, result);
        result = approvalGate.get(result.id) ?? result;
      } else if (
        result.status === "approved" &&
        result.operation !== "delete-worktree"
      ) {
        const delivery = await executeApprovedDelivery(manager, result);
        result = delivery.consumed;
      }
      if (
        result.status === "approved" &&
        result.operation === "delete-worktree"
      ) {
        // Worktree deletion is a destructive alias for full Thread deletion.
        // Keep one cascade path so the dashboard and approval flow cannot
        // leave different orphaned records behind.
        await deleteSubagentCompletely(manager, result.jobId);
        result = { ...result, status: "consumed" };
      }
      return {
        content: [
          {
            type: "text",
            text: `Approval ${result.status}: ${result.id} (${result.operation}, job ${result.jobId}).`,
          },
        ],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "subagent_wake_list",
    label: "List Subagent Wakes",
    description:
      "List durable actionable workflow wakes that have not been acknowledged.",
    parameters: Type.Object({}),
    async execute() {
      const wakes = workflowQueue.pending();
      const text =
        wakes.length === 0
          ? "No pending workflow wakes."
          : wakes
              .map(
                (wake) =>
                  `${wake.id} [${wake.status}] job=${wake.taskId}${wake.message ? ` — ${wake.message}` : ""}`,
              )
              .join("\n");
      return { content: [{ type: "text", text }], details: { wakes } };
    },
  });

  pi.registerTool({
    name: "subagent_wake_ack",
    label: "Acknowledge Subagent Wake",
    description:
      "Acknowledge one durable workflow wake after its result or decision has been handled.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, maxLength: 128 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await assertParentToolRole(ctx);
      const acknowledged = await workflowQueue.acknowledge(params.id as string);
      if (!acknowledged)
        throw new Error(
          `Unknown or already acknowledged workflow wake: ${params.id}`,
        );
      return {
        content: [
          { type: "text", text: `Workflow wake acknowledged: ${params.id}.` },
        ],
        details: { id: params.id, acknowledged: true },
      };
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagents",
    description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        maxItems: 64,
        description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");
      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return (
          (!snap && !jobQueue.get(id)) || (!!snap && !isModelVisible(snap))
        );
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      await waitForQueuedJobs(
        manager,
        ids,
        (pending) => {
          onUpdate?.({
            content: [
              { type: "text", text: `Waiting for ${pending.join(", ")}...` },
            ],
            details: { pending },
          });
        },
        signal,
      );

      resultDelivery.consume(ids);

      const sections: string[] = [];
      let remainingBytes = WAIT_OUTPUT_MAX_BYTES;
      for (const id of ids) {
        const snap = manager.view.get(id);
        if (!snap) {
          const queued = jobQueue.get(id);
          sections.push(
            `## ${id}\n\nJob ${queued?.status ?? "not tracked"}${queued?.errorText ? `: ${queued.errorText}` : ""}`,
          );
          continue;
        }
        const verb = snap.status === "failed" ? "failed" : "finished";
        let section = `## ${snap.id} "${snap.title}" ${verb}`;
        const approval = approvalGate.get(`approval:${snap.id}:commit`);
        if (approval)
          section += `\nApproval: ${approval.id} (${approval.status})`;
        if (snap.errorText) section += `\nError: ${snap.errorText}`;
        if (snap.report) section += `\n${formatSubagentReport(snap.report)}`;
        const headerBytes = Buffer.byteLength(section, "utf8") + 2;
        const outputBudget = Math.max(
          512,
          Math.min(WAIT_PER_AGENT_MAX_BYTES, remainingBytes - headerBytes),
        );
        section += `\n\n${truncatedOutput(snap, outputBudget)}`;
        const sectionBytes = Buffer.byteLength(section, "utf8");
        if (sectionBytes > remainingBytes) {
          sections.push(
            `## ${snap.id} "${snap.title}"\n\n[omitted: total wait output limit reached]`,
          );
          break;
        }
        sections.push(section);
        remainingBytes -= sectionBytes;
      }

      const combined = sections.join("\n\n---\n\n");
      const bounded = truncateHead(combined, {
        maxBytes: WAIT_OUTPUT_MAX_BYTES - 128,
        maxLines: DEFAULT_MAX_LINES,
      });
      const text = bounded.truncated
        ? `${bounded.content}\n\n[wait output truncated at the total output limit]`
        : bounded.content;
      return {
        content: [{ type: "text", text }],
        details: {
          results: ids.map((id) => {
            const snap = manager.view.get(id);
            return { id, title: snap?.title, status: snap?.status };
          }),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagents",
    description: SUBAGENT_CANCEL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");

      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const report = await runTool(getRuntime(), manager.cancel(ids), {
        signal,
        interruptMessage: "Subagent cancellation aborted.",
      });

      const lines = report.map((entry) =>
        entry.cancelled
          ? `Cancelled ${entry.id} "${entry.title}".`
          : `${entry.id} "${entry.title}" was already ${entry.status}.`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            title: entry.title,
            status: entry.status,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap || !isModelVisible(snap)) {
        const known = manager.view
          .list()
          .filter(isModelVisible)
          .map((s) => s.id);
        throw new Error(
          `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }

      let text = `${describeSubagent(snap)}\nTurns: ${snap.turns}`;
      if (snap.backend === "orca" && snap.meta.nativeWorktreeId) {
        text += `\nOrca worktree: ${snap.meta.nativeWorktreeId}`;
      }
      if (snap.backend === "orca" && snap.meta.nativePaneKey) {
        text += `\nOrca pane: ${snap.meta.nativePaneKey}`;
      }
      if (snap.errorText) text += `\nError: ${snap.errorText}`;

      const output = latestText(snap);
      if (output) {
        const preview = truncateHead(output, { maxBytes: 2048, maxLines: 20 });
        text += `\n\nLatest output:\n${preview.content}`;
        if (preview.truncated) text += "\n[...]";
      } else if (snap.status === "running") {
        text += "\n\n(no text output yet)";
      }

      return {
        content: [{ type: "text", text }],
        details: { id: snap.id, status: snap.status, turns: snap.turns },
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: SUBAGENT_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const manager = await getManager();
      const projection = await createLeadProjectionView(manager);
      const view = projection.view;
      const subs = view.list().filter(isModelVisible);
      const queued = jobQueue
        .list()
        .filter((job) => job.status === "queued" || job.status === "blocked");
      const leadAgents = leadAgentStore.list();
      const lines = [
        ...leadAgents.map(
          (leadAgent) =>
            `Agent Lead ${leadAgent.leadAgentId} [persistent] "${leadAgent.title}" (job ${leadAgent.jobId})`,
        ),
        ...subs
          .filter((snap) => snap.meta.role !== "lead")
          .map(
            (snap) =>
              `${snap.meta.leadAgentId ? `  └─ ` : ""}${describeSubagent(snap)}`,
          ),
        ...queued.map(
          (job) =>
            `${job.id} [${job.status}] "${job.title}" (priority ${job.priority}, depends on ${job.dependsOn.join(", ") || "none"})`,
        ),
      ];
      const text = lines.length === 0 ? "No subagents." : lines.join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          subagents: subs.map((snap) => ({
            id: snap.id,
            title: snap.title,
            harness: snap.backend,
            role: snap.meta.role ?? "worker",
            ...(snap.meta.leadAgentId === undefined
              ? {}
              : { leadAgentId: snap.meta.leadAgentId }),
            status: snap.status,
            ...(snap.backend !== "orca"
              ? {}
              : {
                  terminalHandle: snap.meta.nativeTerminalHandle,
                  worktreeId: snap.meta.nativeWorktreeId,
                  tabId: snap.meta.nativeTabId,
                  paneKey: snap.meta.nativePaneKey,
                }),
          })),
          queued: queued.map((job) => ({
            id: job.id,
            title: job.title,
            harness: job.backend,
            status: job.status,
            dependsOn: job.dependsOn,
            priority: job.priority,
          })),
          leadAgents: leadAgents.map((leadAgent) => ({
            leadAgentId: leadAgent.leadAgentId,
            jobId: leadAgent.jobId,
            title: leadAgent.title,
            backend: leadAgent.backend,
            mode: leadAgent.mode,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_detached_worktrees",
    label: "List Detached Worktrees",
    description:
      "List build worktrees preserved after external Pi session deletion.",
    parameters: Type.Object({}),
    async execute() {
      await getManager();
      const worktrees = detachedWorktrees.list();
      const text =
        worktrees.length === 0
          ? "No detached worktrees."
          : worktrees
              .map(
                (item) =>
                  `${item.jobId} "${item.title}" (${item.backend})\n  path=${item.path}\n  branch=${item.branch}\n  repo=${item.repoRoot}${item.nativeWorktreeId ? `\n  Orca worktree=${item.nativeWorktreeId}` : ""}`,
              )
              .join("\n");
      return {
        content: [{ type: "text", text }],
        details: { worktrees },
      };
    },
  });

  // --- Renderers -----------------------------------------------------------

  pi.registerMessageRenderer(
    "subagent-result",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        id?: string;
        title?: string;
        status?: string;
      };
      const failed = details.status === "failed";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`subagent ${details.id ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${details.title ?? ""} · ${failed ? "failed" : "finished"}`,
        );

      const content =
        typeof message.content === "string" ? message.content : "";
      const body = content.split("\n").slice(1).join("\n").trim();

      if (expanded) {
        const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const previewLines = body.split("\n").slice(0, 8);
      let text = header;
      for (const line of previewLines)
        text += `\n${theme.fg("toolOutput", line)}`;
      if (body.split("\n").length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  pi.registerEntryRenderer<QuickAskResultData>(
    "quick-ask-result",
    (entry, { expanded }, theme) => {
      const data = entry.data;
      const failed = data?.status === "failed";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`quick ask · ${data?.title ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${failed ? "failed" : "answered"} · ${data?.id ?? "?"}`,
        );
      const body = [
        data?.errorText ? `Error: ${data.errorText}` : "",
        data?.answer ?? "(no answer)",
      ]
        .filter(Boolean)
        .join("\n\n");

      if (expanded) {
        const md = new Markdown(body, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const lines = body.split("\n");
      let text = header;
      for (const line of lines.slice(0, 8))
        text += `\n${theme.fg("toolOutput", line)}`;
      if (lines.length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  // --- Commands ------------------------------------------------------------

  const runQuickAsk = async (rawArgs: string, ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI)
        ctx.ui.notify("quick ask is only available in the TUI", "error");
      return;
    }

    let prompt = rawArgs.trim();
    if (!prompt) {
      const input = await ctx.ui.input("quick ask", "Ask a one-off question…");
      prompt = input?.trim() ?? "";
      if (!prompt) return;
    }

    const manager = await getManager();
    const quickAskJobId = createJobId(deriveQuickAskTitle(prompt));
    let snap: SubagentSnapshot;
    try {
      await waitForCapacity(quickAskJobId);
      snap = await runTool(
        getRuntime(),
        manager.spawn("pi", {
          jobId: quickAskJobId,
          origin: "quick-ask",
          role: "worker",
          prompt,
          title: deriveQuickAskTitle(prompt),
          mode: "scout",
          cwd: ctx.cwd,
          parent: {
            parentCwd: ctx.cwd,
            projectTrusted: ctx.isProjectTrusted(),
            parentStateRoot: stateRoot,
            inheritedModel: ctx.model
              ? { provider: ctx.model.provider, id: ctx.model.id }
              : undefined,
            inheritedThinkingLevel: parseThinkingLevel(pi.getThinkingLevel()),
            modelRegistry: ctx.modelRegistry,
          },
        }),
      );
      await persistSnapshot(snap, "quick-ask-spawned");
    } catch (error) {
      await releaseCapacity(quickAskJobId);
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
      return;
    }

    await openSubagentTakeover(ctx, manager.view, snap.id, {
      badge: "quick ask",
      ...subagentUiOptions(),
    });
  };

  pi.registerCommand("quick-ask", {
    description:
      "Ask a one-off side question while the main agent keeps working",
    handler: runQuickAsk,
  });

  pi.registerCommand("subagents", {
    description: "List, inspect, and take over subagents",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Subagent takeover is only available in the TUI",
            "error",
          );
        return;
      }
      const manager = await getManager();
      const projection = await createLeadProjectionView(manager);
      const view = projection.view;
      if (view.size() === 0) {
        ctx.ui.notify(
          "No subagents yet. The agent spawns them with subagent_spawn.",
          "info",
        );
        return;
      }
      const refreshTimer = setInterval(() => {
        void projection.refresh().catch(() => {});
      }, 1_000);
      refreshTimer.unref?.();
      try {
        await openSubagentPicker(ctx, view, subagentUiOptions());
      } finally {
        clearInterval(refreshTimer);
      }
    },
  });
}
