import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LeadHomeStore,
  leadHomeTransitions,
  provisionLeadProjects,
  validateLeadProjectSource,
} from "../src/lead-home.ts";

const execFile = promisify(execFileCallback);

test("Agent Lead accepts only HTTPS and SSH remote project origins", () => {
  assert.equal(
    validateLeadProjectSource("https://example.invalid/org/repo.git"),
    "remote",
  );
  assert.equal(
    validateLeadProjectSource("git@example.invalid:org/repo.git"),
    "remote",
  );
  assert.equal(
    validateLeadProjectSource("ssh://git@example.invalid/org/repo.git"),
    "remote",
  );
  assert.throws(
    () => validateLeadProjectSource("ftp://example.invalid/repo.git"),
    /HTTPS or SSH/i,
  );
  assert.throws(
    () =>
      validateLeadProjectSource("https://user:secret@example.invalid/repo.git"),
    /unsafe/i,
  );
});

test("Agent Lead provisions only the explicitly selected project clones", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lead-home-projects-"));
  const source = path.join(root, "source");
  const home = path.join(root, "home");
  try {
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "README.md"), "source\n", "utf8");
    await execFile("git", ["init", source]);
    await execFile("git", ["-C", source, "add", "README.md"]);
    await execFile("git", [
      "-C",
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "init",
    ]);
    const projects = await provisionLeadProjects(home, [
      { projectId: "docs", source },
    ]);
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.projectId, "docs");
    assert.equal(
      (await stat(path.join(home, "projects", "docs", ".git"))).isDirectory(),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Agent Lead home manifest round-trips and enforces lifecycle transitions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lead-home-"));
  const homePath = path.join(root, "leads", "docs");
  try {
    const store = new LeadHomeStore(homePath);
    await store.create({
      leadAgentId: "docs",
      homePath,
      stateRoot: path.join(homePath, "state"),
      parentStateRoot: path.join(root, "parent"),
      projects: [
        {
          projectId: "api",
          source: "/repo/api",
          clonePath: path.join(homePath, "projects", "api"),
          createdAt: 1,
        },
      ],
      status: "provisioning",
    });
    assert.equal(leadHomeTransitions("provisioning", "active"), true);
    assert.equal(leadHomeTransitions("active", "retired"), false);
    await store.transition("active");

    const restored = new LeadHomeStore(homePath);
    await restored.restore();
    assert.equal(restored.get()?.status, "active");
    assert.equal(restored.get()?.projects[0]?.projectId, "api");
    await assert.rejects(
      restored.transition("retired"),
      /Invalid Agent Lead home transition/,
    );
    await restored.transition("stopping");
    await restored.transition("retired");
    await restored.remove();
    assert.equal(restored.get(), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
