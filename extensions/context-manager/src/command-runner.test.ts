import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildPowerShellCommand,
  buildShellCommand,
  findBash,
  formatElapsed,
  looksLikePowerShell,
  LiveOutputBuffer,
  OutputCollector,
  runScript,
  sanitizeEnvironment,
} from "./command-runner.ts";

test("runScript executes a cross-platform shell and captures output", async () => {
  const script = "echo hello";
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

test("looksLikePowerShell detects common cmdlets and syntax", () => {
  assert.equal(looksLikePowerShell("Get-ChildItem -Path ."), true);
  assert.equal(looksLikePowerShell("1..10 | ForEach-Object { $_ }"), true);
  assert.equal(looksLikePowerShell("$LASTEXITCODE"), true);
  assert.equal(looksLikePowerShell("[Console]::Out.WriteLine('hi')"), true);
  assert.equal(looksLikePowerShell("ls | Out-String"), true);
  assert.equal(looksLikePowerShell("Test-Path ./file.txt"), true);
  assert.equal(looksLikePowerShell("echo 'hello world' && ls -la"), false);
  assert.equal(looksLikePowerShell("grep -rn 'test' ."), false);
});

test("buildShellCommand auto-routes to powershell when script contains PS syntax", () => {
  const command = buildShellCommand("Get-ChildItem -Path .", "/usr/bin/bash", "win32");
  assert.equal(command.command, "powershell.exe");
  assert.match(command.args.at(-1) ?? "", /Get-ChildItem/);
});

test("runScript executes explicit powershell runtime on Windows", { skip: process.platform !== "win32" }, async () => {
  const result = await runScript({
    runtime: "powershell",
    script: "Write-Output 'from-powershell'",
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxRawOutputChars: 1_000,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /from-powershell/);
});

test("runScript auto-routes powershell syntax through shell runtime on Windows", { skip: process.platform !== "win32" }, async () => {
  const result = await runScript({
    runtime: "shell",
    script: "Get-Process -Id $PID | Select-Object -ExpandProperty Id",
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxRawOutputChars: 1_000,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /\d+/);
});

test("runScript executes explicit bash runtime when available", { skip: !findBash() }, async () => {
  const result = await runScript({
    runtime: "bash",
    script: "echo bash-explicit && echo ok",
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxRawOutputChars: 1_000,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /bash-explicit/);
});

test("buildShellCommand prefers bash when it is available", () => {
  assert.deepEqual(buildShellCommand("echo a && echo b", "/usr/bin/bash", "win32"), {
    command: "/usr/bin/bash",
    args: ["-c", "echo a && echo b"],
  });
});

test("buildShellCommand keeps the script exit code under PowerShell", () => {
  const command = buildShellCommand("exit 7", undefined, "win32");
  assert.equal(command.command, "powershell.exe");
  assert.equal(command.args.at(-1), "exit 7\nexit $LASTEXITCODE");
});

test("runScript shell reports the real exit code", async () => {
  const result = await runScript({
    runtime: "shell",
    script: "exit 7",
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxRawOutputChars: 1_000,
  });
  assert.equal(result.exitCode, 7);
});

test("runScript shell accepts bash syntax when bash is available", { skip: !findBash() }, async () => {
  const result = await runScript({
    runtime: "shell",
    script: "echo a && echo b",
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxRawOutputChars: 1_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.replace(/\r\n/g, "\n").trim(), "a\nb");
});

test("runScript enforces the raw output limit", async () => {
  const result = await runScript({
    runtime: "javascript",
    script: "process.stdout.write('x'.repeat(5000))",
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxRawOutputChars: 1_000,
  });

  assert.equal(result.truncated, true);
  assert.ok(result.output.length <= 1_100);
});

test("sanitizeEnvironment removes common secret variables", () => {
  const sanitized = sanitizeEnvironment({ PATH: "/bin", API_KEY: "hidden", SAFE_VALUE: "ok" });
  assert.deepEqual(sanitized, { PATH: "/bin", SAFE_VALUE: "ok" });
});

test("sanitizeEnvironment keeps git identity and ssh agent while dropping auth secrets", () => {
  const sanitized = sanitizeEnvironment({
    GIT_AUTHOR_NAME: "a",
    GIT_AUTHOR_EMAIL: "a@x",
    GIT_COMMITTER_NAME: "c",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    AUTHOR: "keep",
    AUTH: "x",
    AUTH_HEADER: "x",
    OAUTH_CLIENT: "x",
    BASIC_AUTH: "x",
    HTTP_AUTHORIZATION: "x",
    GH_TOKEN: "x",
  });
  assert.deepEqual(Object.keys(sanitized).sort(), [
    "AUTHOR",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_NAME",
    "GIT_COMMITTER_NAME",
    "SSH_AUTH_SOCK",
  ]);
});

test("OutputCollector bounds output in linear time", () => {
  const collector = new OutputCollector(10 * 1024 * 1024);
  const chunk = "a".repeat(4096);
  const startedAt = Date.now();
  let reachedLimit = false;
  for (let i = 0; i < 3_000 && !reachedLimit; i++) reachedLimit = collector.append(chunk);
  assert.equal(reachedLimit, true);
  assert.equal(collector.truncated, true);
  assert.equal(collector.toString().length, 10 * 1024 * 1024);
  assert.ok(Date.now() - startedAt < 1_000, "pengumpulan 10 MB tidak boleh kuadratik");
  assert.equal(collector.append("more"), true);
  assert.equal(collector.toString().length, 10 * 1024 * 1024);
});

test("runScript keeps multi-byte characters split across chunks intact", async () => {
  // Tulis byte UTF-8 "é" (0xC3 0xA9) dalam dua write terpisah dengan jeda.
  const script = [
    "process.stdout.write(Buffer.from([0xc3]));",
    "setTimeout(() => process.stdout.write(Buffer.from([0xa9, 0x0a])), 50);",
  ].join("");
  const result = await runScript({
    runtime: "javascript",
    script,
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxRawOutputChars: 1_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "\u00e9\n");
});

test("runScript lets the process finish when raw output is truncated", async () => {
  // Exit code 3 hanya muncul kalau proses tidak dibunuh setelah output melewati batas.
  const result = await runScript({
    runtime: "javascript",
    script: "process.stdout.write('x'.repeat(5000)); setTimeout(() => { process.exitCode = 3; }, 200);",
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxRawOutputChars: 1_000,
  });
  assert.equal(result.truncated, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 3);
});

test("runScript returns the stderr tail for a failing script", async () => {
  const result = await runScript({
    runtime: "javascript",
    script: "console.log('stdout-line'); console.error('boom-one'); console.error('boom-two'); process.exit(2);",
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxRawOutputChars: 1_000,
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.stderrTail, "boom-one\nboom-two");
});

test("formatElapsed otomatis ms->s->m", () => {
  assert.equal(formatElapsed(50), "50ms");
  assert.equal(formatElapsed(1500), "1.5s");
  assert.equal(formatElapsed(125000), "2m 5s");
});

test("LiveOutputBuffer replaces carriage-return progress and bounds retained lines", () => {
  const preview = new LiveOutputBuffer();
  preview.append("Downloading 10%\r");
  assert.equal(preview.snapshot(), "Downloading 10%");
  preview.append("Downloading 20%\rDownloading 100%\nDone\n");
  assert.equal(preview.snapshot(), "Downloading 100%\nDone");

  const manyLines = new LiveOutputBuffer();
  manyLines.append(Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n") + "\n");
  const lines = manyLines.snapshot().split("\n");
  assert.equal(lines.length, 9);
  assert.equal(lines[0], "… 4 earlier lines omitted");
  assert.equal(lines[1], "line-5");
  assert.equal(lines.at(-1), "line-12");

  const longLine = new LiveOutputBuffer();
  longLine.append("x".repeat(600) + "tail");
  const longLinePreview = longLine.snapshot();
  assert.equal(longLinePreview.length, 501);
  assert.ok(longLinePreview.startsWith("…"));
  assert.ok(longLinePreview.endsWith("tail"));

  const terminalControls = new LiveOutputBuffer();
  terminalControls.append("\x1b]52;c;clipboard\x07hello\x1b[31mred\x1b[0m");
  assert.equal(terminalControls.snapshot().includes("\x1b"), false);
  assert.equal(terminalControls.snapshot().includes("\x07"), false);
  assert.equal(terminalControls.snapshot(), "hellored");

  const c1TerminalControls = new LiveOutputBuffer();
  c1TerminalControls.append("\u009d52;c;secret\u0007hello\u009b31mred\u009c");
  assert.equal(c1TerminalControls.snapshot(), "52;c;secrethello31mred");
});

test("runScript emits the first output preview without waiting for the progress tick", async () => {
  let sawInitialOutput = false;
  const result = await runScript({
    runtime: "shell",
    script: "echo quick-output",
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxRawOutputChars: 1_000,
    onOutput: (_elapsedMs, outputPreview) => {
      if (outputPreview.includes("quick-output")) sawInitialOutput = true;
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(sawInitialOutput, true);
});

test("runScript coalesces rapid output preview updates", async () => {
  const script = "(async () => { for (let i = 1; i <= 30; i++) { console.log('line-' + i); await new Promise((r) => setTimeout(r, 10)); } })()";
  const outputUpdates: Array<{ elapsedMs: number; preview: string }> = [];
  const result = await runScript({
    runtime: "javascript",
    script,
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxRawOutputChars: 10_000,
    onOutput: (elapsedMs, preview) => outputUpdates.push({ elapsedMs, preview }),
  });

  assert.equal(result.exitCode, 0);
  assert.ok(outputUpdates.length >= 2, "expected multiple coalesced previews");
  assert.match(outputUpdates.at(-1)?.preview ?? "", /line-30/);
  for (let index = 1; index < outputUpdates.length - 1; index++) {
    assert.ok(outputUpdates[index].elapsedMs - outputUpdates[index - 1].elapsedMs >= 80);
  }
});

test("runScript stops progress updates after cancellation", async () => {
  const controller = new AbortController();
  let progressCalls = 0;

  await assert.rejects(
    runScript({
      runtime: "javascript",
      script: "setTimeout(() => {}, 5000)",
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxRawOutputChars: 1_000,
      signal: controller.signal,
      onProgress: () => {
        progressCalls++;
        controller.abort();
      },
    }),
    /Eksekusi dibatalkan/,
  );
  assert.equal(progressCalls, 1);
});

test("runScript waits for the process tree to stop when cancelled", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cm-cancel-tree-"));
  const marker = join(cwd, "orphan-ran.txt");
  const controller = new AbortController();
  const descendantScript = `process.on("SIGTERM", () => {}); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "orphan"), 700);`;
  const script = `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore" }); process.stdout.write("before-cancel\\n"); setTimeout(() => {}, 5_000);`;

  try {
    await assert.rejects(
      runScript({
        runtime: "javascript",
        script,
        cwd,
        timeoutMs: 10_000,
        maxRawOutputChars: 1_000,
        signal: controller.signal,
        onOutput: (_elapsedMs, preview) => {
          if (preview.includes("before-cancel")) controller.abort();
        },
      }),
      (error: unknown) => {
        const cancelled = error as { name?: string; message?: string; result?: { output?: string; durationMs?: number } };
        assert.equal(cancelled.name, "ScriptCancelledError");
        assert.match(cancelled.result?.output ?? "", /before-cancel/);
        assert.equal(cancelled.message, "Eksekusi dibatalkan.");
        if (process.platform !== "win32") assert.ok((cancelled.result?.durationMs ?? 0) >= 250);
        return true;
      },
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 800));
    assert.equal(existsSync(marker), false, "descendant process must not survive cancellation");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runScript does not start a process when its signal is already aborted", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cm-pre-aborted-"));
  const marker = join(cwd, "started.txt");
  const controller = new AbortController();
  controller.abort();

  try {
    await assert.rejects(
      runScript({
        runtime: "javascript",
        script: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`,
        cwd,
        timeoutMs: 10_000,
        maxRawOutputChars: 1_000,
        signal: controller.signal,
      }),
      (error: unknown) => {
        assert.equal((error as { name?: string }).name, "ScriptCancelledError");
        return true;
      },
    );
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runScript treats progress callback failures as non-fatal", async () => {
  const result = await runScript({
    runtime: "javascript",
    script: "setTimeout(() => {}, 50)",
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxRawOutputChars: 1_000,
    onProgress: () => { throw new Error("render failure"); },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});

test("runScript exposes output in progress updates before the process exits", async () => {
  let processFinished = false;
  let sawOutputWhileRunning = false;
  const result = await runScript({
    runtime: "javascript",
    script: "console.log('before'); setTimeout(() => console.log('after'), 350);",
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxRawOutputChars: 1_000,
    onProgress: (_elapsedMs, outputPreview) => {
      if (!processFinished && typeof outputPreview === "string" && outputPreview.includes("before")) {
        sawOutputWhileRunning = true;
      }
    },
  });
  processFinished = true;
  assert.equal(result.timedOut, false);
  assert.equal(sawOutputWhileRunning, true);
  assert.match(result.output, /before[\s\S]*after/);
});
