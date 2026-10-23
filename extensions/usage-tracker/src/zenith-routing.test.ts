import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findModelBucket } from "./quota-bar.ts";
import { fetchZenithQuotas, readLastServedAccount, servedAccountFromHeaders } from "./zenith.ts";

const NOW = new Date("2026-10-21T06:00:00.000Z");
const LOCKED_UNTIL = NOW.getTime() + 86_400_000;

interface DatabaseSyncLike {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...args: unknown[]) => void };
  close: () => void;
}

/** Database Zenith miniature dengan tabel routing yang relevan. */
function createZenithDb(path: string): void {
  const require2 = createRequire(import.meta.url);
  const { DatabaseSync } = require2("node:sqlite") as { DatabaseSync: new (file: string) => DatabaseSyncLike };
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE connections (
      id INTEGER PRIMARY KEY,
      name TEXT,
      provider TEXT,
      auth_type TEXT,
      is_active INTEGER,
      priority INTEGER,
      cooldown_until INTEGER DEFAULT 0,
      credentials TEXT
    );
    CREATE TABLE connection_model_locks (
      connection_id INTEGER,
      model TEXT,
      locked_until INTEGER
    );
    CREATE TABLE antigravity_account_models (
      connection_id INTEGER,
      model_id TEXT,
      display_name TEXT,
      quota_remaining REAL,
      quota_reset_at INTEGER
    );
  `);
  const insertConnection = db.prepare(
    "INSERT INTO connections (id, name, provider, auth_type, is_active, priority, cooldown_until, credentials) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const quota = JSON.stringify({
    plan: "Google AI Plus",
    updated_at: NOW.getTime(),
    pools: [],
    quotas: {
      "gemini-3.8-flash-medium": { used: 999, total: 1000, remainingPercentage: 0.13, resetAt: "2026-10-24T22:06:11.000Z", displayName: "Gemini 3.8 Flash (Medium)" },
    },
  });
  insertConnection.run(30, "akun-terkunci", "antigravity", "oauth", 1, 1, 0, JSON.stringify({ quota }));
  insertConnection.run(29, "akun-terpakai", "antigravity", "oauth", 1, 2, 0, JSON.stringify({ quota }));

  const insertLock = db.prepare("INSERT INTO connection_model_locks (connection_id, model, locked_until) VALUES (?, ?, ?)");
  insertLock.run(30, "gemini-3.8-flash", LOCKED_UNTIL);

  const insertModel = db.prepare(
    "INSERT INTO antigravity_account_models (connection_id, model_id, display_name, quota_remaining, quota_reset_at) VALUES (?, ?, ?, ?, ?)",
  );
  insertModel.run(30, "gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)", 0.0013, NOW.getTime() + 3 * 86_400_000);
  insertModel.run(29, "gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)", 0.9, NOW.getTime() + 3 * 86_400_000);
  db.close();
}

test("routing data dari database dipakai untuk melewati akun terkunci", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-tracker-db-"));
  const dbPath = join(dir, "zenith.db");
  try {
    createZenithDb(dbPath);
    const usages = await fetchZenithQuotas({
      now: NOW,
      cacheDir: dir,
      maxAgeMs: 0,
      dbPath,
      // Endpoint HTTP tidak tahu soal lock, jadi lock harus datang dari database.
      fetchImpl: (async () =>
        new Response(
          JSON.stringify([
            { id: 30, name: "akun-terkunci", provider: "antigravity", is_active: 1, priority: 1, quota: { plan: "p", updated_at: NOW.getTime(), pools: [], quotas: { "gemini-3.8-flash-medium": { used: 999, total: 1000, remainingPercentage: 0.13, displayName: "Gemini 3.8 Flash (Medium)" } } } },
            { id: 29, name: "akun-terpakai", provider: "antigravity", is_active: 1, priority: 2, quota: { plan: "p", updated_at: NOW.getTime(), pools: [], quotas: { "gemini-3.8-flash-medium": { used: 100, total: 1000, remainingPercentage: 90, displayName: "Gemini 3.8 Flash (Medium)" } } } },
          ]),
          { status: 200 },
        )) as unknown as typeof fetch,
    });

    const locked = usages.find((u) => u.label?.includes("terkunci"));
    const used = usages.find((u) => u.label?.includes("terpakai"));
    assert.equal(locked?.lockedModels?.length, 1);
    assert.equal(locked?.lockedModels?.[0]?.model, "gemini-3.8-flash");
    assert.equal(used?.modelInventory?.length, 1);
    assert.equal(used?.modelInventory?.[0]?.remaining, 0.9);

    const result = findModelBucket({ provider: "zenith", id: "ag/gemini-3.8-flash" }, usages, NOW);
    assert.equal(result?.usage.label, "antigravity · akun-terpakai");
    assert.equal(result?.limit.usedPercent, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("database tanpa tabel routing tetap terbaca", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-tracker-db-"));
  const dbPath = join(dir, "zenith.db");
  try {
    const require2 = createRequire(import.meta.url);
    const { DatabaseSync } = require2("node:sqlite") as { DatabaseSync: new (file: string) => DatabaseSyncLike };
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE connections (
        id INTEGER PRIMARY KEY, name TEXT, provider TEXT, auth_type TEXT,
        is_active INTEGER, priority INTEGER, cooldown_until INTEGER DEFAULT 0, credentials TEXT
      );
    `);
    const quota = JSON.stringify({ plan: "p", updated_at: NOW.getTime(), pools: [], quotas: { "gemini-3.8-flash-medium": { used: 100, total: 1000, remainingPercentage: 90, displayName: "Gemini 3.8 Flash (Medium)" } } });
    db.prepare("INSERT INTO connections (id, name, provider, auth_type, is_active, priority, credentials) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      29, "akun", "antigravity", "oauth", 1, 1, JSON.stringify({ quota }),
    );
    db.close();

    const usages = await fetchZenithQuotas({
      now: NOW,
      cacheDir: dir,
      maxAgeMs: 0,
      dbPath,
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    assert.equal(usages.length, 1);
    assert.equal(usages[0]?.lockedModels, undefined);
    assert.equal(usages[0]?.modelInventory, undefined);
    const result = findModelBucket({ provider: "zenith", id: "ag/gemini-3.8-flash" }, usages, NOW);
    assert.equal(result?.usage.label, "antigravity · akun");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("servedAccountFromHeaders membaca X-Zenith-Account tanpa membedakan huruf besar-kecil", () => {
  const served = servedAccountFromHeaders({ "x-zenith-account": "divarizky28@gmail.com" }, NOW);
  assert.equal(served?.accountName, "divarizky28@gmail.com");
  assert.equal(served?.observedAt, NOW.getTime());
  assert.equal(servedAccountFromHeaders({ "content-type": "application/json" }, NOW), undefined);
});

test("readLastServedAccount mengambil koneksi terbaru untuk provider dan model itu", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-tracker-served-"));
  const dbPath = join(dir, "zenith.db");
  try {
    const require2 = createRequire(import.meta.url);
    const { DatabaseSync } = require2("node:sqlite") as { DatabaseSync: new (file: string) => DatabaseSyncLike };
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE usage_history (id INTEGER PRIMARY KEY AUTOINCREMENT, connection_id INTEGER, provider TEXT, model TEXT, timestamp INTEGER);");
    const insert = db.prepare("INSERT INTO usage_history (connection_id, provider, model, timestamp) VALUES (?, ?, ?, ?)");
    insert.run(30, "antigravity", "gemini-3.8-flash", 1000);
    insert.run(29, "antigravity", "gemini-3.8-flash", 2000);
    insert.run(30, "antigravity", "gemini-4-argon", 3000);
    insert.run(null, "antigravity", "gemini-3.8-flash", 4000);
    db.close();

    assert.deepEqual(readLastServedAccount("antigravity", "gemini-3.8-flash", dbPath), { connectionId: 29, observedAt: 2000 });
    assert.equal(readLastServedAccount("antigravity", "gemini-5", dbPath), undefined);
    assert.equal(readLastServedAccount("antigravity", "gemini-3.8-flash", join(dir, "tidak-ada.db")), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cooldown dari database dan status habis dari payload ikut terbaca", async () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-tracker-cooldown-"));
  const dbPath = join(dir, "zenith.db");
  try {
    const require2 = createRequire(import.meta.url);
    const { DatabaseSync } = require2("node:sqlite") as { DatabaseSync: new (file: string) => DatabaseSyncLike };
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE connections (
        id INTEGER PRIMARY KEY, name TEXT, provider TEXT, auth_type TEXT,
        is_active INTEGER, priority INTEGER, cooldown_until INTEGER DEFAULT 0, credentials TEXT
      );
    `);
    db.prepare("INSERT INTO connections (id, name, provider, auth_type, is_active, priority, cooldown_until, credentials) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      29, "divarizky28@gmail.com", "antigravity", "oauth", 1, 2, NOW.getTime() + 60_000, "{}",
    );
    db.close();

    const usages = await fetchZenithQuotas({
      now: NOW,
      cacheDir: dir,
      maxAgeMs: 0,
      dbPath,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify([
            { id: 29, name: "divarizky28@gmail.com", provider: "antigravity", is_active: 1, priority: 2, quota: { plan: "p", updated_at: NOW.getTime(), pools: [], quotas: { "gemini-3.8-flash-medium": { used: 100, total: 1000, remainingPercentage: 90, displayName: "Gemini 3.8 Flash (Medium)" } } } },
            { id: 30, name: "deepa.rizky@gmail.com", provider: "antigravity", is_active: 1, priority: 1, quota: { plan: "p", updated_at: NOW.getTime(), pools: [], quotas: { "gemini-3.8-flash-medium": { used: 100, total: 1000, remainingPercentage: 90, displayName: "Gemini 3.8 Flash (Medium)" } }, is_exhausted: true } },
          ]),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    const byId = (id: number) => usages.find((usage) => usage.connectionId === id);
    assert.equal(byId(29)?.cooldownUntil, NOW.getTime() + 60_000);
    assert.equal(byId(29)?.accountName, "divarizky28@gmail.com");
    assert.equal(byId(29)?.isExhausted, false);
    assert.equal(byId(30)?.isExhausted, true);
    assert.equal(byId(30)?.cooldownUntil, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
