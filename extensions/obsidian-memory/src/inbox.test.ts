import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildInboxNote,
  writeInboxEntry,
  type MemoryInboxPayload,
} from "./inbox.ts";

function payload(): MemoryInboxPayload {
  return {
    cwd: "/tmp/project",
    sessionId: "session-123",
    runKey: "entry-a,entry-b",
    recap: "- Memperbarui config\n- Test lulus",
    next: "Review diff",
    projectSlug: "my-project",
    date: "2026-09-13",
  };
}

test("writes a bounded inbox note with exactly one TL;DR and backlinks", async () => {
  const vault = mkdtempSync(join(tmpdir(), "obsidian-memory-inbox-"));
  const result = await writeInboxEntry(payload(), vault);
  const note = readFileSync(result.path, "utf8");

  assert.equal(result.created, true);
  assert.match(note, /type: pi-memory-inbox/);
  assert.equal((note.match(/^## TL;DR$/gm) ?? []).length, 1);
  assert.match(note, /\[\[knowledge\/vault-memory-system\]\]/);
  assert.match(note, /\[\[projects\/my-project\/overview\]\]/);
});

test("uses a stable path for duplicate delivery and does not overwrite content", async () => {
  const vault = mkdtempSync(join(tmpdir(), "obsidian-memory-inbox-"));
  const first = await writeInboxEntry(payload(), vault);
  const second = await writeInboxEntry(
    { ...payload(), recap: "different" },
    vault,
  );

  assert.equal(second.path, first.path);
  assert.equal(second.created, false);
  assert.match(readFileSync(first.path, "utf8"), /Memperbarui config/);
});

test("concurrent duplicate delivery creates one complete note", async () => {
  const vault = mkdtempSync(join(tmpdir(), "obsidian-memory-inbox-"));
  const [first, second] = await Promise.all([
    writeInboxEntry(payload(), vault),
    writeInboxEntry({ ...payload(), recap: "different" }, vault),
  ]);

  assert.equal([first.created, second.created].filter(Boolean).length, 1);
  const note = readFileSync(first.path, "utf8");
  assert.match(note, /Memperbarui config|different/);
  assert.equal((note.match(/^## TL;DR$/gm) ?? []).length, 1);
  assert.match(note, /\[\[knowledge\/vault-memory-system\]\]/);
  assert.deepEqual(
    readdirSync(join(vault, "inbox", payload().date)).filter((name) =>
      name.endsWith(".md"),
    ).length,
    1,
  );
});

test("does not create an unavailable vault", async () => {
  const parent = mkdtempSync(join(tmpdir(), "obsidian-memory-inbox-"));
  const vault = join(parent, "missing-vault");

  await assert.rejects(writeInboxEntry(payload(), vault), /unavailable/);
  assert.equal(existsSync(vault), false);
});

test("does not include credentials from model output", () => {
  const note = buildInboxNote({
    ...payload(),
    recap: "Bearer secret-value sk-1234567890123456",
  });
  assert.doesNotMatch(note, /secret-value|sk-1234567890123456/);
  assert.match(note, /REDACTED/);
});
