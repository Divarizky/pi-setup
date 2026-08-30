import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import path from "node:path";

const parentStateContext = new AsyncLocalStorage<string>();

export interface CallerIdentity {
  readonly jobId: string;
  readonly role: "worker" | "lead";
  readonly leadAgentId?: string;
  readonly parentStateRoot?: string;
  readonly coordinatorStateRoot?: string;
  readonly cwd: string;
  readonly title: string;
  readonly mode: "scout" | "build";
}

const callerIdentityContext = new AsyncLocalStorage<CallerIdentity>();

/** Stable, filesystem-safe namespace for one parent Pi session. */
export function createParentStateRoot(agentDir: string, sessionId: string) {
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return path.join(agentDir, "workspace", "state", "parents", key);
}

/** Parent-state override used while an in-process child session is created. */
export function activeParentStateRoot() {
  return parentStateContext.getStore();
}

export function runWithParentStateRoot<A>(
  root: string,
  operation: () => Promise<A>,
): Promise<A> {
  return parentStateContext.run(root, operation);
}

export function activeCallerIdentity() {
  return callerIdentityContext.getStore();
}

export function runWithCallerIdentity<A>(
  identity: CallerIdentity,
  operation: () => Promise<A>,
): Promise<A> {
  return callerIdentityContext.run(identity, operation);
}
