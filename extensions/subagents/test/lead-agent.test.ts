import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { LeadAgentStore } from "../src/lead-agent.ts"

test("Lead Agent registry survives restart and updates its current job", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lead-agent-"))
  try {
    const store = new LeadAgentStore(root)
    await store.create({
      leadAgentId: "docs",
      jobId: "docs-job-1",
      title: "Documentation Lead Agent",
      backend: "pi",
      mode: "scout",
      charter: "Own documentation investigations.",
      scope: "Documentation and API reference work.",
      cwd: process.cwd(),
    })
    await store.update("docs", { jobId: "docs-job-2", lastSummary: "token=super-secret Previous investigation complete." })
    const restored = new LeadAgentStore(root)
    await restored.restore()
    assert.equal(restored.get("docs")?.jobId, "docs-job-2")
    assert.equal(restored.get("docs")?.charter, "Own documentation investigations.")
    assert.equal(restored.get("docs")?.scope, "Documentation and API reference work.")
    assert.equal(restored.get("docs")?.lastSummary, "token=[redacted] Previous investigation complete.")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Lead Agent registry migrates legacy resident state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lead-agent-legacy-"))
  try {
    await writeFile(path.join(root, "resident-subagents.json"), JSON.stringify({ version: 1, residents: [{
      residentId: "legacy",
      jobId: "legacy-job",
      title: "Legacy agent",
      backend: "pi",
      mode: "scout",
      cwd: process.cwd(),
      createdAt: 1,
      updatedAt: 1,
    }] }))
    const store = new LeadAgentStore(root)
    await store.restore()
    assert.equal(store.get("legacy")?.leadAgentId, "legacy")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
