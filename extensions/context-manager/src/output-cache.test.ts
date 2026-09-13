import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { OutputCache, projectHashForDir } from "./output-cache.ts";

test("OutputCache stores and retrieves raw output by outputId", async () => {
  const cache = new OutputCache();
  const raw = "database timeout\nrequest failed";
  const outputId = await cache.save(raw);

  assert.match(outputId, /^output-[a-f0-9-]+$/);
  assert.equal(await cache.get(outputId), raw);
  assert.equal(await cache.get("output-does-not-exist"), null);

  await cache.remove(outputId);
  await cache.cleanup();
});

test("OutputCache enforces project and session ownership", async () => {
  const first = new OutputCache();
  first.setProjectDir("C:/project-a");
  first.setSessionId("session-a");
  const outputId = await first.save("private output");

  const sameSession = new OutputCache();
  sameSession.setProjectDir("C:/project-a");
  sameSession.setSessionId("session-a");
  assert.equal(await sameSession.get(outputId), "private output");

  const otherSession = new OutputCache();
  otherSession.setProjectDir("C:/project-a");
  otherSession.setSessionId("session-b");
  assert.equal(await otherSession.get(outputId), null);

  const otherProject = new OutputCache();
  otherProject.setProjectDir("C:/project-b");
  otherProject.setSessionId("session-a");
  assert.equal(await otherProject.get(outputId), null);

  await first.remove(outputId);
});

test("OutputCache keeps session-owned entries across instances and cleanup", async () => {
  const storage = await mkdtemp(join(tmpdir(), "cm-cache-"));
  try {
    const project = "C:/project-reference-kept";
    const first = new OutputCache();
    first.setProjectDir(project, storage);
    first.setSessionId("session-kept");
    const outputId = await first.save("durable output");
    const filePath = join(storage, projectHashForDir(resolve(project)), `${outputId}.json`);
    await utimes(filePath, new Date(0), new Date(0));

    const second = new OutputCache();
    second.setProjectDir(project, storage);
    second.setSessionId("session-kept");
    await second.cleanup();
    assert.equal(await second.get(outputId), "durable output");
    assert.ok((await readdir(join(storage, projectHashForDir(resolve(project))))).includes(`${outputId}.json`));
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test("OutputCache reference index aman untuk save concurrent antar-instance", async () => {
  const storage = await mkdtemp(join(tmpdir(), "cm-cache-concurrent-"));
  try {
    const project = "C:/project-reference-concurrent";
    const a = new OutputCache();
    const b = new OutputCache();
    for (const cache of [a, b]) {
      cache.setProjectDir(project, storage);
      cache.setSessionId("session-concurrent");
    }
    const [idA, idB] = await Promise.all([a.save("a"), b.save("b")]);
    const reader = new OutputCache();
    reader.setProjectDir(project, storage);
    reader.setSessionId("session-concurrent");
    assert.equal(await reader.get(idA), "a");
    assert.equal(await reader.get(idB), "b");
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test("OutputCache GC menghapus entry bersession setelah referensinya dihapus", async () => {
  const storage = await mkdtemp(join(tmpdir(), "cm-cache-gc-"));
  try {
    const project = "C:/project-reference-gc";
    const cache = new OutputCache();
    cache.setProjectDir(project, storage);
    cache.setSessionId("session-gc");
    const outputId = await cache.save("unreferenced output");
    await cache.syncSessionReferences("session-gc", []);
    const filePath = join(storage, projectHashForDir(resolve(project)), `${outputId}.json`);
    await utimes(filePath, new Date(0), new Date(0));

    const otherInstance = new OutputCache();
    otherInstance.setProjectDir(project, storage);
    otherInstance.setSessionId("session-gc");
    await otherInstance.cleanup();
    assert.equal(await otherInstance.get(outputId), null);
    assert.equal((await readdir(join(storage, projectHashForDir(resolve(project))))).includes(`${outputId}.json`), false);
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test("OutputCache GC membersihkan referensi session yang file-nya terhapus", async () => {
  const storage = await mkdtemp(join(tmpdir(), "cm-cache-session-gc-"));
  try {
    const project = "C:/project-session-file-gc";
    const cache = new OutputCache();
    cache.setProjectDir(project, storage);
    cache.setSessionId("session-file-gc");
    const outputId = await cache.save("stale session output");
    await cache.syncSessionReferences("session-file-gc", [outputId], join(storage, "deleted-session.json"));

    await cache.cleanup();
    assert.equal(await cache.get(outputId), null);
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test("OutputCache fail-safe saat reference index rusak", async () => {
  const storage = await mkdtemp(join(tmpdir(), "cm-cache-corrupt-index-"));
  try {
    const project = "C:/project-corrupt-index";
    const cache = new OutputCache();
    cache.setProjectDir(project, storage);
    cache.setSessionId("session-corrupt-index");
    const outputId = await cache.save("must keep");
    const directory = join(storage, projectHashForDir(resolve(project)));
    await writeFile(join(directory, "references.json"), "null", "utf8");
    await cache.cleanup();
    assert.equal(await cache.get(outputId), "must keep");
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test("OutputCache mengamankan permission cache (0600 file, 0700 dir)", async (t) => {
  if (process.platform === "win32") { t.skip("permission bit tidak berlaku di Windows"); return; }
  const cache = new OutputCache();
  const outputId = await cache.save("secret");
  try {
    const dirStat = await stat(join(tmpdir(), "pi-context-manager"));
    assert.equal(dirStat.mode & 0o777, 0o700);
    const fileStat = await stat(join(tmpdir(), "pi-context-manager", `${outputId}.json`));
    assert.equal(fileStat.mode & 0o777, 0o600);
    // chmod manual tidak boleh merusak get
    await chmod(join(tmpdir(), "pi-context-manager", `${outputId}.json`), 0o600);
    assert.equal(await cache.get(outputId), "secret");
  } finally {
    await cache.remove(outputId);
  }
});
