/**
 * Unified backend interface: one `SubagentBackend` per agent runtime.
 * Backends produce the same `SubagentSession` shape.
 */

import type { Effect, Scope, Stream } from "effect";
import { Context } from "effect";
import type {
  BackendName,
  SendError,
  SpawnError,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
} from "./domain.ts";

/** Canonical semantic status shared by local and external session monitors. */
export type SessionSemanticStatus = "busy" | "idle" | "unknown" | "dead";

export interface SessionStatusEvidence {
  readonly jobId: string;
  readonly status: SessionSemanticStatus;
  readonly source: string;
  readonly at: number;
  readonly eventName?: string;
  readonly evidence?: string;
  readonly identityVerified?: boolean;
}

export interface BackendCapabilities {
  readonly steering: boolean;
  readonly modelSelection: boolean;
  readonly reasoningEffort: boolean;
}

export interface SubagentSession {
  readonly meta: Effect.Effect<SubagentMeta>;
  readonly events: Stream.Stream<SubagentEvent>;
  send(text: string): Effect.Effect<void, SendError>;
  readonly interrupt: Effect.Effect<void>;
  readonly probeStatus?: Effect.Effect<SessionStatusEvidence | undefined>;
}

export interface SubagentBackend {
  readonly name: BackendName;
  readonly capabilities: BackendCapabilities;
  readonly available: Effect.Effect<boolean>;
  spawn(
    task: SpawnTask,
  ): Effect.Effect<SubagentSession, SpawnError, Scope.Scope>;
  reattach?(
    task: SpawnTask,
    identity: Pick<
      SubagentMeta,
      | "nativeSessionId"
      | "nativeTerminalHandle"
      | "nativeWorktreeId"
      | "nativeTabId"
      | "nativePaneKey"
      | "nativeLaunchToken"
    >,
  ): Effect.Effect<SubagentSession, SpawnError, Scope.Scope>;
}

export class BackendRegistry extends Context.Service<
  BackendRegistry,
  ReadonlyMap<BackendName, SubagentBackend>
>()("subagents/BackendRegistry") {}
