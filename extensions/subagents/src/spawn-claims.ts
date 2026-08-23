import { createHash } from "node:crypto"
import type { BackendName, SubagentMode } from "./domain.ts"

export interface SpawnClaim {
  readonly id: string
  readonly title: string
  readonly backend: BackendName
  readonly mode: SubagentMode
  readonly cwd: string
  readonly branch?: string
}

export function createSpawnFingerprint(options: {
  readonly backend: BackendName
  readonly mode: SubagentMode
  readonly sourceCwd: string
  readonly prompt: string
  readonly proposalId?: string
}) {
  return createHash("sha256")
    .update(JSON.stringify(options))
    .digest("hex")
}

/**
 * In-memory reservation for a job while Orca creates its worktree and starts
 * Pi. The manager takes ownership once it has a live session; the claim stays
 * until settlement so repeated model calls reuse the same job.
 */
export class SpawnClaimRegistry {
  private readonly claims = new Map<string, SpawnClaim>()

  get(fingerprint: string) {
    return this.claims.get(fingerprint)
  }

  set(fingerprint: string, claim: SpawnClaim) {
    this.claims.set(fingerprint, claim)
  }

  release(jobId: string) {
    for (const [fingerprint, claim] of this.claims) {
      if (claim.id === jobId) this.claims.delete(fingerprint)
    }
  }
}
