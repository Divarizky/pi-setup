import assert from "node:assert/strict"
import test from "node:test"
import { SpawnClaimRegistry, createSpawnFingerprint } from "../src/spawn-claims.ts"

test("spawn claims reuse an in-flight Orca build and release it on settlement", () => {
  const claims = new SpawnClaimRegistry()
  const fingerprint = createSpawnFingerprint({
    backend: "orca",
    mode: "build",
    sourceCwd: "C:/repo",
    prompt: "Create src/build-result.txt",
  })
  const sameTask = createSpawnFingerprint({
    backend: "orca",
    mode: "build",
    sourceCwd: "C:/repo",
    prompt: "Create src/build-result.txt",
  })
  const differentTask = createSpawnFingerprint({
    backend: "orca",
    mode: "build",
    sourceCwd: "C:/repo",
    prompt: "Create src/other-result.txt",
  })

  claims.set(fingerprint, {
    id: "sa-build-1",
    title: "build result",
    backend: "orca",
    mode: "build",
    cwd: "C:/repo",
    branch: "chore/subagents/build-result",
  })

  assert.equal(sameTask, fingerprint)
  assert.equal(claims.get(sameTask)?.id, "sa-build-1")
  assert.equal(claims.get(differentTask), undefined)

  claims.release("sa-build-1")
  assert.equal(claims.get(fingerprint), undefined)
})

test("spawn fingerprints keep proposals as distinct durable work items", () => {
  const common = {
    backend: "orca" as const,
    mode: "build" as const,
    sourceCwd: "C:/repo",
    prompt: "Implement the approved task",
  }
  assert.notEqual(
    createSpawnFingerprint({ ...common, proposalId: "proposal-a" }),
    createSpawnFingerprint({ ...common, proposalId: "proposal-b" }),
  )
})
