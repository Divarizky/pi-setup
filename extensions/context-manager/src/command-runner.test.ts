import assert from "node:assert/strict";
import test from "node:test";
import {
  formatElapsed,
  isPotentiallyMutating,
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

test("runScript memanggil onProgress dengan elapsed", async () => {
  const seen: number[] = [];
  const result = await runScript({
    runtime: "shell",
    script: process.platform === "win32" ? "Start-Sleep -Milliseconds 350" : "sleep 0.35",
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxRawOutputChars: 1_000,
    onProgress: (ms) => { seen.push(ms); },
  });
  assert.equal(result.timedOut, false);
  assert.ok(seen.length >= 2);
  assert.ok(seen.at(-1)! >= 0);
});
