import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendViolationLog,
  computeRuleStats,
  readViolationLogs,
  resolveAgentDir,
  resolveLogPath,
  sanitizeExcerpt,
} from "./log.ts";
import type { ViolationEntry } from "./types.ts";

test("resolveAgentDir dan resolveLogPath mematuhi environment variable atau default", () => {
  const originalEnv = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = "/custom/agent/dir";
    assert.equal(resolveAgentDir(), "/custom/agent/dir");
    assert.equal(
      resolveLogPath(),
      join("/custom/agent/dir", "ttsr-log.jsonl"),
    );

    delete process.env.PI_CODING_AGENT_DIR;
    assert.match(resolveAgentDir(), /\.pi[/\\]agent$/);
    assert.equal(
      resolveLogPath("/custom/override"),
      join("/custom/override", "ttsr-log.jsonl"),
    );
  } finally {
    if (originalEnv !== undefined) {
      process.env.PI_CODING_AGENT_DIR = originalEnv;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  }
});

test("sanitizeExcerpt memotong 120 karakter dan menghapus excerpt untuk secret-in-write", () => {
  // secret-in-write dilarang memuat excerpt
  assert.equal(sanitizeExcerpt("secret-in-write", "API_KEY=12345"), undefined);
  assert.equal(sanitizeExcerpt("secret-in-write", undefined), undefined);

  // Rule lain: excerpt pendek tidak dipotong
  assert.equal(sanitizeExcerpt("empty-validation", "You are right"), "You are right");

  // Rule lain: excerpt > 120 karakter dipotong ke 120
  const longText = "a".repeat(150);
  const truncated = sanitizeExcerpt("ai-vocabulary", longText);
  assert.equal(truncated?.length, 120);
  assert.equal(truncated, "a".repeat(120));
});

test("appendViolationLog menulis satu baris JSON valid per pelanggaran", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ttsr-log-test-"));
  const logPath = join(tmp, "ttsr-log.jsonl");

  try {
    const entry1: ViolationEntry = {
      ts: 1000,
      rule: "empty-validation",
      action: "log",
      scope: "text",
      retry: false,
      excerpt: "You're absolutely right!",
    };

    const entry2: ViolationEntry = {
      ts: 2000,
      rule: "secret-in-write",
      action: "block",
      scope: "tool:write",
      retry: false,
      excerpt: "sk-proj-supersecret1234567890",
    };

    const entry3: ViolationEntry = {
      ts: 3000,
      rule: "ai-vocabulary",
      action: "abort",
      scope: "text",
      retry: true,
      excerpt: "z".repeat(150),
    };

    appendViolationLog(entry1, logPath);
    appendViolationLog(entry2, logPath);
    appendViolationLog(entry3, logPath);

    const raw = readFileSync(logPath, "utf8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 3);

    const parsed1 = JSON.parse(lines[0]);
    assert.deepEqual(parsed1, {
      ts: 1000,
      rule: "empty-validation",
      action: "log",
      scope: "text",
      retry: false,
      excerpt: "You're absolutely right!",
    });

    const parsed2 = JSON.parse(lines[1]);
    // secret-in-write tidak boleh ada excerpt
    assert.equal(parsed2.excerpt, undefined);
    assert.equal(parsed2.rule, "secret-in-write");
    assert.equal(parsed2.action, "block");

    const parsed3 = JSON.parse(lines[2]);
    assert.equal(parsed3.retry, true);
    assert.equal(parsed3.excerpt?.length, 120);

    const readBack = readViolationLogs(logPath);
    assert.equal(readBack.length, 3);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("computeRuleStats menghitung pelanggaran dan retry koreksi serta mengurutkan berdasarkan retry tertinggi", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ttsr-stats-test-"));
  const logPath = join(tmp, "ttsr-log.jsonl");

  try {
    // Tulis baris valid dan satu baris korup
    const content = [
      JSON.stringify({ ts: 1, rule: "rule-a", action: "log", scope: "text", retry: false }),
      JSON.stringify({ ts: 2, rule: "rule-a", action: "log", scope: "text", retry: false }),
      JSON.stringify({ ts: 3, rule: "rule-b", action: "abort", scope: "text", retry: true }),
      JSON.stringify({ ts: 4, rule: "rule-b", action: "abort", scope: "text", retry: true }),
      JSON.stringify({ ts: 5, rule: "rule-c", action: "abort", scope: "text", retry: true }),
      JSON.stringify({ ts: 6, rule: "rule-c", action: "log", scope: "text", retry: false }),
      "ini-baris-korup-yang-harus-diabaikan",
      JSON.stringify({ ts: 7, rule: "rule-c", action: "log", scope: "text", retry: false }),
    ].join("\n");

    writeFileSync(logPath, `${content}\n`, "utf8");

    const stats = computeRuleStats(logPath);
    // rule-b: retry 2, violations 2
    // rule-c: retry 1, violations 3
    // rule-a: retry 0, violations 2
    assert.equal(stats.length, 3);
    assert.equal(stats[0].rule, "rule-b");
    assert.equal(stats[0].retries, 2);
    assert.equal(stats[0].violations, 2);

    assert.equal(stats[1].rule, "rule-c");
    assert.equal(stats[1].retries, 1);
    assert.equal(stats[1].violations, 3);

    assert.equal(stats[2].rule, "rule-a");
    assert.equal(stats[2].retries, 0);
    assert.equal(stats[2].violations, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
