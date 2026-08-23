/**
 * Layer composition and the async entry-point boundary.
 *
 * Everything inside the extension is Effect generators; this module is where
 * tool handlers (plain async functions) run those effects against one shared
 * ManagedRuntime.
 */

import { Cause, Exit, Layer, ManagedRuntime, type Effect } from "effect"
import { BackendRegistry, type SubagentBackend } from "./backend.ts"
import { orcaBackend } from "./backends/orca.ts"
import { piBackend } from "./backends/pi.ts"
import type { BackendName } from "./domain.ts"
import { SubagentManagerLive } from "./manager.ts"

const BackendRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [piBackend, orcaBackend]
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  )
})

const AppLayer = SubagentManagerLive.pipe(Layer.provide(BackendRegistryLive))

export function createSubagentRuntime() {
  return ManagedRuntime.make(AppLayer)
}

export type SubagentRuntime = ReturnType<typeof createSubagentRuntime>

export async function runTool<A, E>(
  runtime: SubagentRuntime,
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal; interruptMessage?: string } = {},
) {
  const exit = await runtime.runPromiseExit(
    effect,
    options.signal ? { signal: options.signal } : undefined,
  )
  if (Exit.isSuccess(exit)) return exit.value
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error(options.interruptMessage ?? "Operation was aborted.")
  }
  const [first] = Cause.prettyErrors(exit.cause)
  throw new Error(first?.message ?? Cause.pretty(exit.cause))
}
