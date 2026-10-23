import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchZenithQuotas } from "./zenith.ts";

const NOW = new Date("2026-10-21T06:00:00.000Z");

/** Payload `/api/quota` bentuk minimal untuk satu koneksi Antigravity. */
function quotaPayload(overrides: Record<string, unknown> = {}): unknown[] {
  return [
    {
      id: 30,
      name: "akun-a",
      provider: "antigravity",
      auth_type: "oauth",
      is_active: 1,
      priority: 1,
      quota: {
        plan: "Google AI Plus",
        updated_at: NOW.getTime(),
        pools: [{ group: "Gemini Models", window: "weekly", label: "Gemini Models · Mingguan", bucketId: "gemini-weekly", remainingPercentage: 0.13, resetAt: "2026-10-24T22:06:11.000Z" }],
        quotas: {
          "gemini-3.8-flash-medium": { used: 999, total: 1000, remainingPercentage: 0.13, resetAt: "2026-10-24T22:06:11.000Z", displayName: "Gemini 3.8 Flash (Medium)" },
        },
      },
      ...overrides,
    },
  ];
}

test("fetchZenithQuotas memetakan pool dan bucket model", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "usage-tracker-zenith-"));
  try {
    const usages = await fetchZenithQuotas({
      now: NOW,
      cacheDir,
      maxAgeMs: 0,
      dbPath: null,
      fetchImpl: (async () => new Response(JSON.stringify(quotaPayload()), { status: 200 })) as unknown as typeof fetch,
    });
    assert.equal(usages.length, 1);
    const usage = usages[0];
    assert.equal(usage?.provider, "antigravity");
    assert.equal(usage?.priority, 1);
    assert.equal(usage?.perModelBuckets, true);
    assert.equal(usage?.quota, "Google AI Plus");
    const keys = (usage?.limits ?? []).map((l) => l.key);
    assert.ok(keys.includes("gemini-weekly"));
    assert.ok(keys.includes("gemini-3.8-flash-medium"));
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("fetchZenithQuotas melewati koneksi yang tidak aktif", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "usage-tracker-zenith-"));
  try {
    const usages = await fetchZenithQuotas({
      now: NOW,
      cacheDir,
      maxAgeMs: 0,
      dbPath: null,
      fetchImpl: (async () => new Response(JSON.stringify(quotaPayload({ is_active: 0 })), { status: 200 })) as unknown as typeof fetch,
    });
    assert.equal(usages.length, 0);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("fetchZenithQuotas mengembalikan array kosong saat endpoint gagal tanpa cache", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "usage-tracker-zenith-"));
  try {
    const usages = await fetchZenithQuotas({
      now: NOW,
      cacheDir,
      maxAgeMs: 0,
      dbPath: null,
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    assert.deepEqual([...usages], []);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("fetchZenithQuotas memakai cache saat endpoint gagal", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "usage-tracker-zenith-"));
  try {
    const ok = (async () => new Response(JSON.stringify(quotaPayload()), { status: 200 })) as unknown as typeof fetch;
    await fetchZenithQuotas({ now: NOW, cacheDir, maxAgeMs: 0, dbPath: null, fetchImpl: ok });
    const fail = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const usages = await fetchZenithQuotas({ now: NOW, cacheDir, maxAgeMs: 0, dbPath: null, fetchImpl: fail });
    assert.equal(usages.length, 1);
    assert.equal(usages[0]?.stale, false);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("file cache yang rusak tidak membuat refresh gagal", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "usage-tracker-zenith-"));
  try {
    writeFileSync(join(cacheDir, "zenith-quota.json"), "{bukan json", "utf8");
    const usages = await fetchZenithQuotas({
      now: NOW,
      cacheDir,
      maxAgeMs: 0,
      dbPath: null,
      fetchImpl: (async () => new Response(JSON.stringify(quotaPayload()), { status: 200 })) as unknown as typeof fetch,
    });
    assert.equal(usages.length, 1);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
