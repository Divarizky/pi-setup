import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cleanCommand,
  extractRunner,
  hasValidationSmell,
  isPathOrUniqueArg,
  isReadOnlyCommand,
  mineValidationCandidates,
  splitSegments,
} from "./mine-validation-candidates.mjs";

const SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "mine-validation-candidates.mjs",
);

function runCli(args) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [SCRIPT_PATH, ...args],
      (err, stdout, stderr) => {
        if (err) {
          reject(Object.assign(err, { stdout, stderr }));
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

describe("mine-validation-candidates unit helpers", () => {
  it("isReadOnlyCommand mendeteksi perintah baca-saja", () => {
    assert.equal(isReadOnlyCommand("echo test"), true);
    assert.equal(isReadOnlyCommand("cat tests/a.js"), true);
    assert.equal(isReadOnlyCommand("ls -la"), true);
    assert.equal(isReadOnlyCommand("grep -rn foo"), true);
    assert.equal(isReadOnlyCommand("git status"), true);
    assert.equal(isReadOnlyCommand("git log -n 5"), true);
    assert.equal(isReadOnlyCommand("git diff HEAD"), true);
    assert.equal(isReadOnlyCommand("custom-runner test"), false);
  });

  it("isPathOrUniqueArg mendeteksi berkas, flag nilai, dan tanda path", () => {
    assert.equal(isPathOrUniqueArg("test.js"), true);
    assert.equal(isPathOrUniqueArg("src/foo.py"), true);
    assert.equal(isPathOrUniqueArg("--target=unit"), true);
    assert.equal(isPathOrUniqueArg("test"), false);
    assert.equal(isPathOrUniqueArg("--check"), false);
    assert.equal(isPathOrUniqueArg("run"), false);
  });

  it("extractRunner mengambil dua token pertama tanpa path unik", () => {
    assert.equal(
      extractRunner("custom-runner test --verbose"),
      "custom-runner test",
    );
    assert.equal(
      extractRunner("./scripts/run-checks.sh foo.js"),
      "run-checks.sh",
    );
    assert.equal(extractRunner("node --test tests/foo.test.js"), "node --test");
    assert.equal(extractRunner("node --check src/app.js"), "node --check");
  });

  it("hasValidationSmell mengenali kata kunci validasi dan mengecualikan non-validasi", () => {
    assert.equal(hasValidationSmell("custom-runner test"), true);
    assert.equal(hasValidationSmell("node --check"), true);
    assert.equal(hasValidationSmell("cargo clippy"), false);
    assert.equal(hasValidationSmell("cargo check"), true);
    assert.equal(hasValidationSmell("git checkout"), false);
    assert.equal(hasValidationSmell("test -z"), false);
    assert.equal(hasValidationSmell("test"), false);
  });

  it("splitSegments menangani heredoc dan pemisah perintah", () => {
    const cmd = "cat > file.txt <<'EOF'\ntest line\nEOF\nmy-runner check";
    const segs = splitSegments(cmd);
    assert.ok(segs.some((s) => s.includes("my-runner check")));
    assert.ok(!segs.some((s) => s.trim() === "test line"));
  });
});

describe("mineValidationCandidates integration fixtures", () => {
  it("Runner tak dikenal yang sukses muncul sebagai kandidat", async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mine-val-unknown-"),
    );
    try {
      const logPath = path.join(tempDir, "task-judge.log");
      const sessionsDir = path.join(tempDir, "sessions", "test-project");
      await fs.mkdir(sessionsDir, { recursive: true });

      const sessionId = "session-unknown-runner-01";
      const logEntry = {
        timestamp: "2026-11-01T10:00:00.000Z",
        sessionId,
        decision: "tidak_terverifikasi",
        editCount: 2,
        hasSuccessfulValidation: false,
        mode: "warn",
      };
      await fs.writeFile(logPath, `${JSON.stringify(logEntry)}\n`, "utf8");

      const sessionFile = path.join(
        sessionsDir,
        `2026-11-01T10-00-00-000Z_${sessionId}.jsonl`,
      );
      const sessionLines = [
        JSON.stringify({
          type: "message",
          timestamp: "2026-11-01T10:01:00.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_abc123",
                name: "bash",
                arguments: { command: "custom-tester test --all" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-11-01T10:01:05.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call_abc123",
            toolName: "bash",
            isError: false,
            content: [{ type: "text", text: "all tests passed" }],
          },
        }),
      ];
      await fs.writeFile(sessionFile, `${sessionLines.join("\n")}\n`, "utf8");

      const results = await mineValidationCandidates({ sessionsDir, logPath });
      assert.equal(results.length, 1);
      assert.equal(results[0].runner, "custom-tester test");
      assert.equal(results[0].count, 1);
      assert.equal(results[0].sessions, 1);
      assert.deepEqual(results[0].examples, ["custom-tester test --all"]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("Perintah yang sudah dikenali (npm run test) tidak muncul", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mine-val-known-"));
    try {
      const logPath = path.join(tempDir, "task-judge.log");
      const sessionsDir = path.join(tempDir, "sessions", "test-project");
      await fs.mkdir(sessionsDir, { recursive: true });

      const sessionId = "session-known-runner-02";
      const logEntry = {
        timestamp: "2026-11-01T10:00:00.000Z",
        sessionId,
        decision: "tidak_terverifikasi",
        editCount: 1,
        hasSuccessfulValidation: false,
        mode: "warn",
      };
      await fs.writeFile(logPath, `${JSON.stringify(logEntry)}\n`, "utf8");

      const sessionFile = path.join(
        sessionsDir,
        `2026-11-01T10-00-00-000Z_${sessionId}.jsonl`,
      );
      const sessionLines = [
        JSON.stringify({
          type: "message",
          timestamp: "2026-11-01T10:02:00.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_npm_test",
                name: "bash",
                arguments: { command: "npm run test" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-11-01T10:02:05.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call_npm_test",
            toolName: "bash",
            isError: false,
            content: [{ type: "text", text: "ok" }],
          },
        }),
      ];
      await fs.writeFile(sessionFile, `${sessionLines.join("\n")}\n`, "utf8");

      const results = await mineValidationCandidates({ sessionsDir, logPath });
      assert.deepEqual(results, []);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("echo test tidak muncul", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mine-val-echo-"));
    try {
      const logPath = path.join(tempDir, "task-judge.log");
      const sessionsDir = path.join(tempDir, "sessions", "test-project");
      await fs.mkdir(sessionsDir, { recursive: true });

      const sessionId = "session-echo-03";
      const logEntry = {
        timestamp: "2026-11-01T10:00:00.000Z",
        sessionId,
        decision: "tidak_terverifikasi",
        editCount: 1,
        hasSuccessfulValidation: false,
        mode: "warn",
      };
      await fs.writeFile(logPath, `${JSON.stringify(logEntry)}\n`, "utf8");

      const sessionFile = path.join(
        sessionsDir,
        `2026-11-01T10-00-00-000Z_${sessionId}.jsonl`,
      );
      const sessionLines = [
        JSON.stringify({
          type: "message",
          timestamp: "2026-11-01T10:03:00.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_echo",
                name: "bash",
                arguments: { command: "echo test" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-11-01T10:03:02.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call_echo",
            toolName: "bash",
            isError: false,
            content: [{ type: "text", text: "test" }],
          },
        }),
      ];
      await fs.writeFile(sessionFile, `${sessionLines.join("\n")}\n`, "utf8");

      const results = await mineValidationCandidates({ sessionsDir, logPath });
      assert.deepEqual(results, []);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("Tidak ada log atau sesi -> output [], exit 0", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mine-val-empty-"));
    try {
      const nonExistentLog = path.join(tempDir, "missing.log");
      const nonExistentSessions = path.join(tempDir, "missing-sessions");

      const results = await mineValidationCandidates({
        sessionsDir: nonExistentSessions,
        logPath: nonExistentLog,
      });
      assert.deepEqual(results, []);

      // Validasi lewat CLI
      const { stdout } = await runCli([
        "--log",
        nonExistentLog,
        "--sessions-dir",
        nonExistentSessions,
      ]);
      assert.equal(stdout.trim(), "[]");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("Perintah yang gagal (isError: true) tidak dikumpulkan", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mine-val-fail-"));
    try {
      const logPath = path.join(tempDir, "task-judge.log");
      const sessionsDir = path.join(tempDir, "sessions", "test-project");
      await fs.mkdir(sessionsDir, { recursive: true });

      const sessionId = "session-failed-04";
      const logEntry = {
        timestamp: "2026-11-01T10:00:00.000Z",
        sessionId,
        decision: "tidak_terverifikasi",
        editCount: 1,
        hasSuccessfulValidation: false,
        mode: "warn",
      };
      await fs.writeFile(logPath, `${JSON.stringify(logEntry)}\n`, "utf8");

      const sessionFile = path.join(
        sessionsDir,
        `2026-11-01T10-00-00-000Z_${sessionId}.jsonl`,
      );
      const sessionLines = [
        JSON.stringify({
          type: "message",
          timestamp: "2026-11-01T10:05:00.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_failed_test",
                name: "bash",
                arguments: { command: "custom-tester test" },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-11-01T10:05:02.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call_failed_test",
            toolName: "bash",
            isError: true,
            content: [{ type: "text", text: "Command exited with code 1" }],
          },
        }),
      ];
      await fs.writeFile(sessionFile, `${sessionLines.join("\n")}\n`, "utf8");

      const results = await mineValidationCandidates({ sessionsDir, logPath });
      assert.deepEqual(results, []);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("Opsi --output menulis hasil ke berkas dan --since menyaring log", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mine-val-cli-"));
    try {
      const logPath = path.join(tempDir, "task-judge.log");
      const sessionsDir = path.join(tempDir, "sessions", "p1");
      const outputPath = path.join(tempDir, "out", "result.json");
      await fs.mkdir(sessionsDir, { recursive: true });

      const sOld = "sess-old";
      const sNew = "sess-new";

      const logLines = [
        JSON.stringify({
          timestamp: "2026-10-01T00:00:00.000Z",
          sessionId: sOld,
          decision: "tidak_terverifikasi",
        }),
        JSON.stringify({
          timestamp: "2026-11-05T00:00:00.000Z",
          sessionId: sNew,
          decision: "tidak_terverifikasi",
        }),
      ];
      await fs.writeFile(logPath, `${logLines.join("\n")}\n`, "utf8");

      const fileOld = path.join(sessionsDir, `2026-10-01_${sOld}.jsonl`);
      const fileNew = path.join(sessionsDir, `2026-11-05_${sNew}.jsonl`);

      const makeSession = (cmd) => [
        JSON.stringify({
          type: "message",
          timestamp: "2026-11-05T01:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "c1",
                name: "bash",
                arguments: { command: cmd },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-11-05T01:00:01.000Z",
          message: {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "bash",
            isError: false,
          },
        }),
      ];

      await fs.writeFile(
        fileOld,
        `${makeSession("old-runner test").join("\n")}\n`,
        "utf8",
      );
      await fs.writeFile(
        fileNew,
        `${makeSession("new-runner check").join("\n")}\n`,
        "utf8",
      );

      await runCli([
        "--log",
        logPath,
        "--sessions-dir",
        sessionsDir,
        "--output",
        outputPath,
        "--since",
        "2026-11-01T00:00:00.000Z",
      ]);

      const saved = JSON.parse(await fs.readFile(outputPath, "utf8"));
      assert.equal(saved.length, 1);
      assert.equal(saved[0].runner, "new-runner check");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
