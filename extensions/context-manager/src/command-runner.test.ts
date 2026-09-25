import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatElapsed,
  isPotentiallyMutating,
  LiveOutputBuffer,
  runScript,
  sanitizeEnvironment,
} from "./command-runner.ts";

test("runScript executes a cross-platform shell and captures output", async () => {
  const script = process.platform === "win32" ? "Write-Output hello" : "printf hello";
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
  const script = process.platform === "win32"
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

test("mutation detection allowlist: read-only lolos, mutatif diblokir", () => {
  // js/ts/py read-only lolos; yang menulis/IO butuh confirm
  assert.equal(isPotentiallyMutating("javascript", "console.log('read')"), false);
  assert.equal(isPotentiallyMutating("python", "print('hi')"), false);
  assert.equal(isPotentiallyMutating("typescript", "1 + 2"), false);
  assert.equal(isPotentiallyMutating("javascript", "require('fs').unlinkSync('x')"), true);
  assert.equal(isPotentiallyMutating("python", "open('x', 'w').write('hi')"), true);
  assert.equal(isPotentiallyMutating("typescript", "Deno.removeSync('x')"), true);
  // read-only yang diizinkan
  assert.equal(isPotentiallyMutating("shell", "git status --short"), false);
  assert.equal(isPotentiallyMutating("shell", "git diff --stat"), false);
  assert.equal(isPotentiallyMutating("shell", "git log --oneline -n 5"), false);
  assert.equal(isPotentiallyMutating("shell", "git remote -v"), false);
  assert.equal(isPotentiallyMutating("shell", "git tag -l"), false);
  assert.equal(isPotentiallyMutating("shell", "ls -la"), false);
  assert.equal(isPotentiallyMutating("shell", "cat README.md"), false);
  assert.equal(isPotentiallyMutating("shell", "grep -R foo ."), false);
  assert.equal(isPotentiallyMutating("shell", "npm test"), true);
  assert.equal(isPotentiallyMutating("shell", "npm ls"), false);
  assert.equal(isPotentiallyMutating("shell", "echo hello"), false);
  assert.equal(isPotentiallyMutating("shell", "ls -la && cat package.json"), false);
  // Jalur di luar workspace tidak boleh lolos sebagai read-only.
  assert.equal(isPotentiallyMutating("shell", "cat /etc/passwd"), true);
  assert.equal(isPotentiallyMutating("shell", "cat ../secrets.txt"), true);
  assert.equal(isPotentiallyMutating("shell", "cat $HOME/.ssh/id_rsa"), true);
  assert.equal(isPotentiallyMutating("shell", "cat C:\\Users\\Public\\secret.txt"), true);
  // mutatif / tidak di-allowlist
  assert.equal(isPotentiallyMutating("shell", "git reset --hard"), true);
  assert.equal(isPotentiallyMutating("shell", "git commit -m hi"), true);
  assert.equal(isPotentiallyMutating("shell", "git remote add origin https://example.com/repo.git"), true);
  assert.equal(isPotentiallyMutating("shell", "git tag v1"), true);
  assert.equal(isPotentiallyMutating("shell", "git diff --output=report.txt"), true);
  assert.equal(isPotentiallyMutating("shell", "./custom-project-script.sh"), true);
  assert.equal(isPotentiallyMutating("shell", "echo hello > output.txt"), true);
  assert.equal(isPotentiallyMutating("shell", "cat x | tee out.txt"), true);
  assert.equal(isPotentiallyMutating("shell", "rm -rf ./dist"), true);
  assert.equal(isPotentiallyMutating("shell", "npm install"), true);
  assert.equal(isPotentiallyMutating("shell", "custom-project-command"), true);
  assert.equal(isPotentiallyMutating("shell", ""), true);
  // P1: varian mutatif yang sebelumnya lolos allowlist harus diblokir
  assert.equal(isPotentiallyMutating("shell", "git branch -D feature"), true);
  assert.equal(isPotentiallyMutating("shell", "npm audit fix"), true);
  assert.equal(isPotentiallyMutating("shell", "echo $(Remove-Item ./target -Recurse)"), true);
  assert.equal(isPotentiallyMutating("shell", "echo `rm -rf /tmp/x`"), true);
  assert.equal(isPotentiallyMutating("shell", "echo ${HOME}"), true);
  assert.equal(isPotentiallyMutating("shell", "env rm -rf ./target"), true);
  assert.equal(isPotentiallyMutating("shell", "command rm -rf ./target"), true);
  assert.equal(isPotentiallyMutating("shell", "timeout 1 rm -rf ./target"), true);
  assert.equal(isPotentiallyMutating("shell", "find . -exec rm {} \\;"), true);
  assert.equal(isPotentiallyMutating("shell", "awk 'BEGIN { system(\"rm -rf ./target\") }'"), true);
  assert.equal(isPotentiallyMutating("shell", "awk '{ print > \"target\" }'"), true);
  assert.equal(isPotentiallyMutating("shell", "sed -i 's/a/b/' file.txt"), true);
  assert.equal(isPotentiallyMutating("shell", "node --version -e \"process.exit(1)\""), true);
  assert.equal(isPotentiallyMutating("shell", "git branch"), false);
  assert.equal(isPotentiallyMutating("shell", "git branch -a"), false);
});

test("sanitizeEnvironment removes common secret variables", () => {
  const sanitized = sanitizeEnvironment({ PATH: "/bin", API_KEY: "hidden", SAFE_VALUE: "ok" });
  assert.deepEqual(sanitized, { PATH: "/bin", SAFE_VALUE: "ok" });
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
    script: process.platform === "win32" ? "Write-Output quick-output" : "printf 'quick-output\\n'",
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
  const script = process.platform === "win32"
    ? "1..30 | ForEach-Object { [Console]::Out.WriteLine(\"line-$_\"); Start-Sleep -Milliseconds 10 }"
    : "for i in $(seq 1 30); do printf 'line-%s\\n' \"$i\"; sleep 0.01; done";
  const outputUpdates: Array<{ elapsedMs: number; preview: string }> = [];
  const result = await runScript({
    runtime: "shell",
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
      runtime: "shell",
      script: process.platform === "win32" ? "Start-Sleep -Seconds 5" : "sleep 5",
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
    runtime: "shell",
    script: process.platform === "win32" ? "Start-Sleep -Milliseconds 50" : "sleep 0.05",
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
    runtime: "shell",
    script: process.platform === "win32"
      ? "Write-Output before; Start-Sleep -Milliseconds 350; Write-Output after"
      : "printf 'before\\n'; sleep 0.35; printf 'after\\n'",
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
