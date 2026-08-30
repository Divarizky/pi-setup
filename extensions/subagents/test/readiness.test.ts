import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runReadinessDoctor } from "../src/readiness.ts";

test("readiness doctor safely repairs Lead directories and rechecks tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-readiness-"));
  try {
    const report = await runReadinessDoctor(root, true);
    assert.equal(report.repaired, true);
    assert.equal(report.ready, true);
    await access(path.join(root, "state"));
    await access(path.join(root, "sessions"));
    await access(path.join(root, "projects"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readiness doctor rejects a regular file where a directory is required", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-readiness-file-"));
  try {
    await writeFile(path.join(root, "state"), "not a directory\n", "utf8");
    const report = await runReadinessDoctor(root, false);
    assert.equal(
      report.checks.some(
        (check) => check.name === "state directory" && !check.ok,
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readiness doctor does not repair unless explicitly requested", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-readiness-check-"));
  try {
    const report = await runReadinessDoctor(root, false);
    assert.equal(report.repaired, false);
    assert.equal(
      report.checks.some(
        (check) => check.name === "state directory" && !check.ok,
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
