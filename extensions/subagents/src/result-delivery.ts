/**
 * Deferred result delivery for subagents.
 *
 * Subagents that settle while no one is waiting have their results deferred
 * so they can be flushed as follow-up messages when the parent is idle.
 */

export function createDeferredResultDelivery<T extends { id: string }>() {
  const pending = new Map<string, T>()

  return {
    defer(result: T) {
      pending.set(result.id, result)
    },
    consume(ids: Iterable<string>) {
      for (const id of ids) pending.delete(id)
    },
    drain() {
      const results = [...pending.values()]
      pending.clear()
      return results
    },
    clear() {
      pending.clear()
    },
  }
}
