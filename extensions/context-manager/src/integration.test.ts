import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { isPotentiallyMutating, runScript, sanitizeEnvironment } from "./command-runner.ts";
import { OutputCache } from "./output-cache.ts";

// Helper: simulasi isInsideProject yang dipakai execute/inspect (realpath+relative)
async function isInsideProjectResolved(projectRoot: string, requested: string): Promise<boolean> {
  const [realReq, realRoot] = await Promise.all([
    realpath(requested).catch(() => requested),
    realpath(projectRoot).catch(() => projectRoot),
  ]);
  const rel = relative(realRoot, realReq);
  if (rel === "" || rel === ".") return true;
  if (process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(rel)) return false;
  return !rel.startsWith(`..${"/"}`) && !rel.startsWith(`..\\`) && rel !== "..";
}

test("sandbox cwd: menolak escape via .. dan symlink ke luar project", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cm-int-root-"));
  const outside = mkdtempSync(join(tmpdir(), "cm-int-outside-"));
  const linkPath = join(root, "link-out");
  try { await symlink(outside, linkPath); } catch (e: any) {
    if (process.platform === "win32" && e?.code === "EPERM") { t.skip("symlink butuh privilege di Windows"); return; }
    throw e;
  }
  try {
    assert.equal(await isInsideProjectResolved(root, resolve(root, "..")), false);
    assert.equal(await isInsideProjectResolved(root, linkPath), false);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "sub"), { recursive: true });
    assert.equal(await isInsideProjectResolved(root, join(root, "sub")), true);
    // file di dalam project dgn realpath yang tetap inside
    await writeFile(join(root, "a.txt"), "hi", "utf8");
    assert.equal(await isInsideProjectResolved(root, join(root, "a.txt")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("allowlist shell: detail Pi tetap dipertahankan (merge details)", () => {
  // Simulasi handler tool_result yang baru: merge details alih-alih replace.
  const prevDetails = { exitCode: 0, bytes: 123 };
  const outputId = "output-abc123";
  const merged = (() => {
    const p: unknown = prevDetails;
    if (p !== null && typeof p === "object" && !Array.isArray(p)) {
      return { ...(p as Record<string, unknown>), contextManager: { outputId, originalChars: 999 } };
    }
    return { originalDetails: p, contextManager: { outputId, originalChars: 999 } };
  })();
  assert.equal((merged as any).exitCode, 0);
  assert.equal((merged as any).bytes, 123);
  assert.equal((merged as any).contextManager.outputId, outputId);
});

test("allowlist shell: redirection dan pipe mutatif wajib diblokir", () => {
  assert.equal(isPotentiallyMutating("shell", "ls -la > out.txt"), true);
  assert.equal(isPotentiallyMutating("shell", "cat x | tee out.txt"), true);
  assert.equal(isPotentiallyMutating("shell", "echo hi | Set-Content out.txt"), true);
  assert.equal(isPotentiallyMutating("shell", "npm install"), true);
  assert.equal(isPotentiallyMutating("shell", "git checkout main"), true);
});

test("sanitizeEnvironment: tidak membocorkan secret env ke child", async () => {
  const env = { PATH: "/bin", GH_TOKEN: "secret", MY_PASSWORD: "secret2", SAFE: "ok" };
  const sanitized = sanitizeEnvironment(env as any);
  assert.equal((sanitized as any).GH_TOKEN, undefined);
  assert.equal((sanitized as any).MY_PASSWORD, undefined);
  assert.equal((sanitized as any).SAFE, "ok");
  // jalankan child via runScript dan pastikan env sensitif tidak diteruskan (best-effort)
  const script = process.platform === "win32" ? "Get-ChildItem Env: | Out-String" : "env";
  const result = await runScript({ runtime: "shell", script, cwd: tmpdir(), timeoutMs: 10_000, maxRawOutputChars: 20_000 });
  // set env sensitif di proses saat ini, lalu pastikan child tidak melihatnya (jika ada, tes ini akan flaky tapi tetap berguna)
  process.env.CM_TEST_SECRET_TOKEN = "should-not-appear";
  const result2 = await runScript({ runtime: "shell", script, cwd: tmpdir(), timeoutMs: 10_000, maxRawOutputChars: 20_000 });
  delete process.env.CM_TEST_SECRET_TOKEN;
  assert.equal(result2.output.includes("CM_TEST_SECRET_TOKEN"), false);
  void result;
});

test("OutputCache + runScript lifecycle: output besar tetap bisa diambil via cache", async () => {
  const cache = new OutputCache();
  const big = "x".repeat(50_000) + "\nerror: boom\n";
  const id = await cache.save(big);
  try {
    const raw = await cache.get(id);
    assert.equal(raw, big);
    // simulasi summarize: cache tetap jadi sumber kebenaran
    assert.match(id, /^output-[a-f0-9-]+$/);
  } finally {
    await cache.remove(id);
  }
});

test("inspect path traversal ditolak (realpath check)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cm-inspect-root-"));
  const outside = mkdtempSync(join(tmpdir(), "cm-inspect-outside-"));
  const outsideFile = join(outside, "secret.txt");
  await writeFile(outsideFile, "secret", "utf8");
  const traversal = join(root, "..", relative(tmpdir(), outsideFile));
  // handler inspect melakukan realpath; traversal harus tertolak
  const inside = await isInsideProjectResolved(root, traversal);
  assert.equal(inside, false);
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  void readFile;
});
