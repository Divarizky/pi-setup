import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderUsage, UsageLimit } from "./providers.ts";
import { findModelBucket, findQuotaForModel, quotaProviderId } from "./quota-bar.ts";

const NOW = new Date("2026-10-21T06:00:00.000Z");

function limit(key: string, usedPercent: number, options: { pool?: boolean; resetsAt?: string } = {}): UsageLimit {
  return {
    label: options.pool ? `${key} pool` : key,
    key,
    pool: options.pool,
    usedPercent,
    resetsAt: options.resetsAt ? new Date(options.resetsAt) : undefined,
  };
}

function usage(overrides: Partial<ProviderUsage> & { limits?: readonly UsageLimit[] }): ProviderUsage {
  return {
    provider: "antigravity",
    status: "ok",
    today: { period: "today", status: "unavailable" },
    billing: { period: "billing", status: "unavailable" },
    perModelBuckets: true,
    ...overrides,
  };
}

test("quotaProviderId memetakan prefix router ke provider upstream", () => {
  assert.equal(quotaProviderId({ provider: "zenith", id: "ag/gemini-3.8-flash" }), "antigravity");
  assert.equal(quotaProviderId({ provider: "zenith", id: "cx/gpt-6.1-sol" }), "codex");
  assert.equal(quotaProviderId({ provider: "zenith", id: "cc/claude-sonnet-4-6" }), "claude");
  assert.equal(quotaProviderId({ provider: "anthropic", id: "claude-sonnet-4-6" }), "anthropic");
});

test("batas paling ketat pada akun yang dipakai, pool ikut dihitung", () => {
  const result = findModelBucket(
    { provider: "zenith", id: "ag/gemini-3.8-flash" },
    [
      usage({
        label: "antigravity · a",
        limits: [
          limit("gemini-weekly", 55, { pool: true }),
          limit("gemini-3.8-flash-medium", 10.3),
        ],
      }),
    ],
    NOW,
  );
  assert.equal(result?.limit.key, "gemini-weekly");
  assert.equal(result?.limit.usedPercent, 55);
});

test("pool grup dipakai bila tidak ada bucket model pada akun", () => {
  const result = findModelBucket(
    { provider: "zenith", id: "ag/gemini-3.8-flash" },
    [usage({ label: "antigravity · a", limits: [limit("gemini-weekly", 55, { pool: true })] })],
    NOW,
  );
  assert.equal(result?.limit.key, "gemini-weekly");
});

test("akun terkunci router dilewati dan akun lain dipakai", () => {
  const result = findModelBucket(
    { provider: "zenith", id: "ag/gemini-3.8-flash" },
    [
      usage({
        label: "antigravity · terkunci",
        priority: 1,
        lockedModels: [{ model: "gemini-3.8-flash", lockedUntil: NOW.getTime() + 86_400_000 }],
        limits: [limit("gemini-3.8-flash-medium", 99.9)],
      }),
      usage({
        label: "antigravity · tersedia",
        priority: 2,
        limits: [limit("gemini-3.8-flash-medium", 10.3)],
      }),
    ],
    NOW,
  );
  assert.equal(result?.usage.label, "antigravity · tersedia");
  assert.equal(result?.limit.usedPercent, 10.3);
});

test("lock yang sudah kedaluwarsa tidak lagi menutupi akun", () => {
  const result = findModelBucket(
    { provider: "zenith", id: "ag/gemini-3.8-flash" },
    [
      usage({
        label: "antigravity · a",
        priority: 1,
        lockedModels: [{ model: "gemini-3.8-flash", lockedUntil: NOW.getTime() - 1_000 }],
        limits: [limit("gemini-3.8-flash-medium", 25)],
      }),
    ],
    NOW,
  );
  assert.equal(result?.usage.label, "antigravity · a");
});

test("lock untuk tier lain tidak menutupi model yang diminta", () => {
  const result = findModelBucket(
    { provider: "zenith", id: "ag/gemini-3.8-flash" },
    [
      usage({
        label: "antigravity · terkunci",
        priority: 1,
        lockedModels: [{ model: "gemini-3.8-flash-high", lockedUntil: NOW.getTime() + 60_000 }],
        limits: [limit("gemini-3.8-flash-medium", 10)],
      }),
      usage({ label: "antigravity · b", priority: 2, limits: [limit("gemini-3.8-flash-medium", 20)] }),
    ],
    NOW,
  );
  assert.equal(result?.usage.label, "antigravity · terkunci");
});

test("inventory menandai akun habis walau persentase agregat belum penuh", () => {
  const result = findModelBucket(
    { provider: "zenith", id: "ag/gemini-3.8-flash" },
    [
      usage({
        label: "antigravity · habis",
        priority: 1,
        modelInventory: [{ model: "gemini-3.8-flash-medium", remaining: 0, resetsAt: NOW.getTime() + 60_000 }],
        limits: [limit("gemini-3.8-flash-medium", 99.9)],
      }),
      usage({
        label: "antigravity · ada",
        priority: 2,
        modelInventory: [{ model: "gemini-3.8-flash-medium", remaining: 0.9 }],
        limits: [limit("gemini-3.8-flash-medium", 10)],
      }),
    ],
    NOW,
  );
  assert.equal(result?.usage.label, "antigravity · ada");
});

test("inventory habis dengan reset yang sudah lewat tidak menutupi akun", () => {
  const result = findModelBucket(
    { provider: "zenith", id: "ag/gemini-3.8-flash" },
    [
      usage({
        label: "antigravity · a",
        priority: 1,
        modelInventory: [{ model: "gemini-3.8-flash-medium", remaining: 0, resetsAt: NOW.getTime() - 1_000 }],
        limits: [limit("gemini-3.8-flash-medium", 99.9)],
      }),
    ],
    NOW,
  );
  assert.equal(result?.usage.label, "antigravity · a");
});

test("akun tanpa bucket model yang cocok dibuang", () => {
  const result = findModelBucket(
    { provider: "zenith", id: "ag/gemini-4-argon" },
    [
      usage({
        label: "antigravity · tanpa argon",
        priority: 1,
        limits: [limit("gemini-3.8-flash-medium", 10)],
      }),
      usage({
        label: "antigravity · dengan argon",
        priority: 2,
        limits: [limit("gemini-4-argon-low", 52.7)],
      }),
    ],
    NOW,
  );
  assert.equal(result?.usage.label, "antigravity · dengan argon");
});

test("urutan prioritas mengikuti router: priority kecil lebih dulu", () => {
  const result = findModelBucket(
    { provider: "zenith", id: "ag/gemini-3.8-flash" },
    [
      usage({ label: "antigravity · p2", priority: 2, limits: [limit("gemini-3.8-flash-medium", 10)] }),
      usage({ label: "antigravity · p1", priority: 1, limits: [limit("gemini-3.8-flash-medium", 20)] }),
    ],
    NOW,
  );
  assert.equal(result?.usage.label, "antigravity · p1");
});

test("tier yang tidak dikenal tidak ikut tertangkap", () => {
  const result = findModelBucket(
    { provider: "zenith", id: "ag/gemini-3.8-flash" },
    [
      usage({
        label: "antigravity · a",
        limits: [limit("gemini-3.8-flash-lite-high", 90), limit("gemini-3.8-flash-medium", 10)],
      }),
    ],
    NOW,
  );
  assert.equal(result?.limit.key, "gemini-3.8-flash-medium");
});

test("model tanpa bucket yang cocok tidak menghasilkan bar", () => {
  const result = findQuotaForModel(
    { provider: "zenith", id: "ag/gemini-3.9-flash" },
    [usage({ label: "antigravity · a", limits: [limit("gemini-3.8-flash-medium", 10)] })],
    NOW,
  );
  assert.equal(result, undefined);
});

function account(label: string, connectionId: number, priority: number, extra: Partial<ProviderUsage> = {}): ProviderUsage {
  return usage({
    label,
    connectionId,
    accountName: label.replace("antigravity · ", ""),
    priority,
    limits: [limit("gemini-3.8-flash-medium", 20)],
    ...extra,
  });
}

test("akun yang melayani request terakhir dipakai walau urutan router berbeda", () => {
  const usages = [account("antigravity · p1", 30, 1), account("antigravity · p2", 29, 2)];
  const result = findModelBucket({ provider: "zenith", id: "ag/gemini-3.8-flash" }, usages, NOW, {
    connectionId: 29,
    observedAt: NOW.getTime(),
  });
  assert.equal(result?.usage.connectionId, 29);
});

test("akun terakhir dicocokkan lewat nama dari header", () => {
  const usages = [account("antigravity · p1", 30, 1), account("antigravity · p2", 29, 2)];
  const result = findModelBucket({ provider: "zenith", id: "ag/gemini-3.8-flash" }, usages, NOW, {
    accountName: "p2",
    observedAt: NOW.getTime(),
  });
  assert.equal(result?.usage.connectionId, 29);
});

test("akun terakhir yang sedang terkunci untuk model ini tidak dipakai", () => {
  const usages = [
    account("antigravity · p1", 30, 1),
    account("antigravity · p2", 29, 2, {
      lockedModels: [{ model: "gemini-3.8-flash", lockedUntil: NOW.getTime() + 60_000 }],
    }),
  ];
  const result = findModelBucket({ provider: "zenith", id: "ag/gemini-3.8-flash" }, usages, NOW, {
    connectionId: 29,
    observedAt: NOW.getTime(),
  });
  assert.equal(result?.usage.connectionId, 30);
});

test("akun terakhir yang sedang cooldown tidak dipakai", () => {
  const usages = [account("antigravity · p1", 30, 1, { cooldownUntil: NOW.getTime() + 60_000 }), account("antigravity · p2", 29, 2)];
  const result = findModelBucket({ provider: "zenith", id: "ag/gemini-3.8-flash" }, usages, NOW, {
    connectionId: 30,
    observedAt: NOW.getTime(),
  });
  assert.equal(result?.usage.connectionId, 29);
});

test("akun terakhir yang ditandai habis oleh router tidak dipakai", () => {
  const usages = [account("antigravity · p1", 30, 1), account("antigravity · p2", 29, 2, { isExhausted: true })];
  const result = findModelBucket({ provider: "zenith", id: "ag/gemini-3.8-flash" }, usages, NOW, {
    connectionId: 29,
    observedAt: NOW.getTime(),
  });
  assert.equal(result?.usage.connectionId, 30);
});

test("riwayat yang tidak cocok dengan akun manapun memakai urutan router", () => {
  const usages = [account("antigravity · p1", 30, 1), account("antigravity · p2", 29, 2)];
  const result = findModelBucket({ provider: "zenith", id: "ag/gemini-3.8-flash" }, usages, NOW, {
    connectionId: 999,
    observedAt: NOW.getTime(),
  });
  assert.equal(result?.usage.connectionId, 30);
});

test("cooldown dan status habis melewati akun dalam urutan router", () => {
  const usages = [
    account("antigravity · p1", 30, 1, { cooldownUntil: NOW.getTime() + 60_000 }),
    account("antigravity · p2", 29, 2, { isExhausted: true }),
    account("antigravity · p3", 28, 3),
  ];
  const result = findModelBucket({ provider: "zenith", id: "ag/gemini-3.8-flash" }, usages, NOW);
  assert.equal(result?.usage.connectionId, 28);
});

test("priority yang sama diurutkan menurut id koneksi terkecil", () => {
  const usages = [account("antigravity · b", 31, 1), account("antigravity · a", 29, 1)];
  const result = findModelBucket({ provider: "zenith", id: "ag/gemini-3.8-flash" }, usages, NOW);
  assert.equal(result?.usage.connectionId, 29);
});
