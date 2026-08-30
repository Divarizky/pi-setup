import assert from "node:assert/strict";
import test from "node:test";
import {
  isPotentiallyMutating,
  runScript,
  sanitizeEnvironment,
} from "./command-runner.ts";
import { formatExecutionApproval } from "../index.ts";

test("runScript executes a cross-platform shell and captures output", async () => {
  const script =
    process.platform === "win32" ? "Write-Output hello" : "printf hello";
  const result = await runScript({
    runtime: "shell",
    script,
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxRawOutputChars: 1_000,
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /hello/);
  assert.equal(result.timedOut, false);
});

test("runScript enforces the raw output limit", async () => {
  const script =
    process.platform === "win32"
      ? "Write-Output ('x' * 5000)"
      : "printf 'x%.0s' $(seq 1 5000)";
  const result = await runScript({
    runtime: "shell",
    script,
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxRawOutputChars: 1_000,
  });

  assert.equal(result.truncated, true);
  assert.ok(result.output.length <= 1_100);
});

test("mutation detection protects non-shell scripts and write commands", () => {
  assert.equal(
    isPotentiallyMutating("javascript", "console.log('read')"),
    true,
  );
  assert.equal(isPotentiallyMutating("shell", "git status --short"), false);
  assert.equal(isPotentiallyMutating("shell", "npm test"), false);
  assert.equal(isPotentiallyMutating("shell", "git reset --hard"), true);
  assert.equal(
    isPotentiallyMutating("shell", "./custom-project-script.sh"),
    true,
  );
  assert.equal(
    isPotentiallyMutating("shell", "echo hello > output.txt"),
    false,
  );
  assert.equal(isPotentiallyMutating("shell", "custom-project-command"), false);
});

test("execution approval clearly identifies the command and its scope", () => {
  const message = formatExecutionApproval(
    "shell",
    "C:/project",
    "Remove-Item ./temp.txt",
  );
  assert.match(message, /memerlukan persetujuan/);
  assert.match(message, /Runtime: shell/);
  assert.match(message, /Direktori kerja: C:\/project/);
  assert.match(message, /Script yang akan dijalankan:/);
  assert.match(message, /Remove-Item \.\/temp\.txt/);
  assert.match(message, /Jalankan script ini\?/);
});

test("sanitizeEnvironment removes common secret variables", () => {
  const sanitized = sanitizeEnvironment({
    PATH: "/bin",
    API_KEY: "hidden",
    SAFE_VALUE: "ok",
  });
  assert.deepEqual(sanitized, { PATH: "/bin", SAFE_VALUE: "ok" });
});
