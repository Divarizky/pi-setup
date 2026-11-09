import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeSession,
  classifyCacheBreak,
  isCacheBreak,
  summarizeBreaks,
} from "./classify-cache-breaks.mjs";

test("classifyCacheBreak mendeteksi model-switch saat model asisten berganti", () => {
  const prevTurn = {
    type: "message",
    timestamp: "2026-11-01T10:00:00.000Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-3-5",
      usage: { input: 10, cacheRead: 20000, cacheWrite: 0 },
    },
  };

  const currTurn = {
    type: "message",
    timestamp: "2026-11-01T10:01:00.000Z",
    message: {
      role: "assistant",
      model: "gemini-3.8-flash",
      usage: { input: 50, cacheRead: 1000, cacheWrite: 5000 },
    },
  };

  assert.strictEqual(isCacheBreak(prevTurn, currTurn), true);

  const label = classifyCacheBreak({
    prevTurn,
    currTurn,
    intermediateEntries: [{ type: "message", message: { role: "user" } }],
  });

  assert.strictEqual(label, "model-switch");

  // Uji end-to-end via analyzeSession
  const sessionJsonl = [
    JSON.stringify(prevTurn),
    JSON.stringify(currTurn),
  ].join("\n");
  const breaks = analyzeSession(sessionJsonl, "test-sess-model-switch.jsonl");

  assert.strictEqual(breaks.length, 1);
  assert.strictEqual(breaks[0].label, "model-switch");
  assert.strictEqual(breaks[0].model, "gemini-3.8-flash");
  assert.strictEqual(breaks[0].prevModel, "claude-sonnet-3-5");
  assert.strictEqual(breaks[0].retransmittedTokens, 5050); // 50 + 5000
});

test("classifyCacheBreak mendeteksi compaction saat ada entri compaction di antara dua turn", () => {
  const prevTurn = {
    type: "message",
    timestamp: "2026-11-01T10:00:00.000Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-3-5",
      usage: { input: 10, cacheRead: 50000, cacheWrite: 0 },
    },
  };

  const compactionEntry = {
    type: "compaction",
    timestamp: "2026-11-01T10:01:30.000Z",
    summary: "Ringkasan percakapan sebelumnya",
  };

  const currTurn = {
    type: "message",
    timestamp: "2026-11-01T10:02:00.000Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-3-5",
      usage: { input: 1200, cacheRead: 0, cacheWrite: 8000 },
    },
  };

  assert.strictEqual(isCacheBreak(prevTurn, currTurn), true);

  const sessionJsonl = [
    JSON.stringify(prevTurn),
    JSON.stringify(compactionEntry),
    JSON.stringify(currTurn),
  ].join("\n");

  const breaks = analyzeSession(sessionJsonl, "test-sess-compaction.jsonl");

  assert.strictEqual(breaks.length, 1);
  assert.strictEqual(breaks[0].label, "compaction");
  assert.strictEqual(breaks[0].prevCacheRead, 50000);
  assert.strictEqual(breaks[0].currCacheRead, 0);
  assert.strictEqual(breaks[0].retransmittedTokens, 9200); // 1200 + 8000
});

test("classifyCacheBreak mendeteksi prune saat ada entri context-manager-prune di antara dua turn", () => {
  const prevTurn = {
    type: "message",
    timestamp: "2026-11-01T10:00:00.000Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-3-5",
      usage: { input: 10, cacheRead: 30000, cacheWrite: 0 },
    },
  };

  const pruneEntry = {
    type: "custom",
    customType: "context-manager-prune",
    timestamp: "2026-11-01T10:01:00.000Z",
    data: { toolCallIds: ["call-1", "call-2"] },
  };

  const currTurn = {
    type: "message",
    timestamp: "2026-11-01T10:02:00.000Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-3-5",
      usage: { input: 500, cacheRead: 5000, cacheWrite: 4000 },
    },
  };

  assert.strictEqual(isCacheBreak(prevTurn, currTurn), true);

  const sessionJsonl = [
    JSON.stringify(prevTurn),
    JSON.stringify(pruneEntry),
    JSON.stringify(currTurn),
  ].join("\n");

  const breaks = analyzeSession(sessionJsonl, "test-sess-prune.jsonl");

  assert.strictEqual(breaks.length, 1);
  assert.strictEqual(breaks[0].label, "prune");
  assert.strictEqual(breaks[0].prevCacheRead, 30000);
  assert.strictEqual(breaks[0].currCacheRead, 5000);
  assert.strictEqual(breaks[0].retransmittedTokens, 4500); // 500 + 4000
});

test("classifyCacheBreak mendeteksi idle-gap saat selisih waktu antar turn melebihi 5 menit", () => {
  const prevTurn = {
    type: "message",
    timestamp: "2026-11-01T10:00:00.000Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-3-5",
      usage: { input: 10, cacheRead: 40000, cacheWrite: 0 },
    },
  };

  // Selisih 6 menit (> 5 menit)
  const currTurn = {
    type: "message",
    timestamp: "2026-11-01T10:06:00.001Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-3-5",
      usage: { input: 600, cacheRead: 2000, cacheWrite: 30000 },
    },
  };

  assert.strictEqual(isCacheBreak(prevTurn, currTurn), true);

  const sessionJsonl = [
    JSON.stringify(prevTurn),
    JSON.stringify({ type: "message", message: { role: "user" } }),
    JSON.stringify(currTurn),
  ].join("\n");

  const breaks = analyzeSession(sessionJsonl, "test-sess-idle-gap.jsonl");

  assert.strictEqual(breaks.length, 1);
  assert.strictEqual(breaks[0].label, "idle-gap");
  assert.strictEqual(breaks[0].retransmittedTokens, 30600);
});

test("classifyCacheBreak melabeli unknown jika tidak ada pemicu lain dan waktu <= 5 menit", () => {
  const prevTurn = {
    type: "message",
    timestamp: "2026-11-01T10:00:00.000Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-3-5",
      usage: { input: 10, cacheRead: 60000, cacheWrite: 0 },
    },
  };

  // Selisih 2 menit (masih dalam TTL cache 5 menit), model sama, tanpa compaction/prune
  const currTurn = {
    type: "message",
    timestamp: "2026-11-01T10:02:00.000Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-3-5",
      usage: { input: 800, cacheRead: 1000, cacheWrite: 20000 },
    },
  };

  assert.strictEqual(isCacheBreak(prevTurn, currTurn), true);

  const sessionJsonl = [
    JSON.stringify(prevTurn),
    JSON.stringify({ type: "message", message: { role: "user" } }),
    JSON.stringify(currTurn),
  ].join("\n");

  const breaks = analyzeSession(sessionJsonl, "test-sess-unknown.jsonl");

  assert.strictEqual(breaks.length, 1);
  assert.strictEqual(breaks[0].label, "unknown");
  assert.strictEqual(breaks[0].retransmittedTokens, 20800);
});

test("classifyCacheBreak menghormati urutan prioritas klasifikasi", () => {
  // Kasus: model berganti DAN ada compaction -> harus model-switch (prioritas 1 > 2)
  const prevTurn = {
    type: "message",
    timestamp: "2026-11-01T10:00:00.000Z",
    message: {
      role: "assistant",
      model: "model-a",
      usage: { cacheRead: 20000 },
    },
  };

  const currTurn = {
    type: "message",
    timestamp: "2026-11-01T10:10:00.000Z", // > 5 menit juga
    message: {
      role: "assistant",
      model: "model-b", // beda model
      usage: { cacheRead: 0 },
    },
  };

  const intermediate = [
    { type: "compaction" },
    { type: "custom", customType: "context-manager-prune" },
  ];

  const label = classifyCacheBreak({
    prevTurn,
    currTurn,
    intermediateEntries: intermediate,
  });

  assert.strictEqual(label, "model-switch");

  // Kasus: model sama, ada compaction DAN prune -> harus compaction (prioritas 2 > 3)
  const currTurnSameModel = {
    type: "message",
    timestamp: "2026-11-01T10:10:00.000Z",
    message: {
      role: "assistant",
      model: "model-a",
      usage: { cacheRead: 0 },
    },
  };

  const labelCompaction = classifyCacheBreak({
    prevTurn,
    currTurn: currTurnSameModel,
    intermediateEntries: intermediate,
  });

  assert.strictEqual(labelCompaction, "compaction");

  // Kasus: model sama, ada prune DAN idle-gap (> 5 min) -> harus prune (prioritas 3 > 4)
  const labelPrune = classifyCacheBreak({
    prevTurn,
    currTurn: currTurnSameModel,
    intermediateEntries: [
      { type: "custom", customType: "context-manager-prune" },
    ],
  });

  assert.strictEqual(labelPrune, "prune");
});

test("isCacheBreak mengabaikan turn yang bukan cache break", () => {
  const baseTurn = {
    type: "message",
    message: {
      role: "assistant",
      model: "model-a",
      usage: { cacheRead: 10000 },
    },
  };

  // 1. cacheRead >= 0.5 * prevCacheRead (6000 >= 5000)
  const hitTurn = {
    type: "message",
    message: {
      role: "assistant",
      model: "model-a",
      usage: { cacheRead: 6000 },
    },
  };
  assert.strictEqual(isCacheBreak(baseTurn, hitTurn), false);

  // 2. prevCacheRead <= 5000 (tidak memenuhi ambang batas > 5000)
  const lowPrevTurn = {
    type: "message",
    message: {
      role: "assistant",
      model: "model-a",
      usage: { cacheRead: 5000 },
    },
  };
  const dropTurn = {
    type: "message",
    message: {
      role: "assistant",
      model: "model-a",
      usage: { cacheRead: 500 },
    },
  };
  assert.strictEqual(isCacheBreak(lowPrevTurn, dropTurn), false);

  // 3. Bukan asisten atau tidak ada usage
  const userTurn = {
    type: "message",
    message: { role: "user" },
  };
  assert.strictEqual(isCacheBreak(baseTurn, userTurn), false);
});

test("summarizeBreaks menghasilkan agregasi per label, model, dan 5 contoh unknown", () => {
  const mockBreaks = [
    {
      sessionPath: "sess-1.jsonl",
      turnIndex: 1,
      line: 2,
      label: "prune",
      model: "claude-sonnet-3-5",
      prevModel: "claude-sonnet-3-5",
      prevCacheRead: 20000,
      currCacheRead: 5000,
      input: 100,
      cacheWrite: 200,
      retransmittedTokens: 300,
    },
    {
      sessionPath: "sess-2.jsonl",
      turnIndex: 3,
      line: 4,
      label: "unknown",
      model: "claude-sonnet-3-5",
      prevModel: "claude-sonnet-3-5",
      prevCacheRead: 30000,
      currCacheRead: 1000,
      input: 500,
      cacheWrite: 1000,
      retransmittedTokens: 1500,
    },
    {
      sessionPath: "sess-3.jsonl",
      turnIndex: 5,
      line: 6,
      label: "model-switch",
      model: "gemini-3.8-flash",
      prevModel: "claude-sonnet-3-5",
      prevCacheRead: 25000,
      currCacheRead: 0,
      input: 200,
      cacheWrite: 0,
      retransmittedTokens: 200,
    },
  ];

  const summary = summarizeBreaks(mockBreaks, 3);

  assert.strictEqual(summary.sessionsAnalyzed, 3);
  assert.strictEqual(summary.totalBreaks, 3);
  assert.strictEqual(summary.totalRetransmittedTokens, 2000);

  assert.strictEqual(summary.byLabel.prune.count, 1);
  assert.strictEqual(summary.byLabel.prune.retransmittedTokens, 300);
  assert.strictEqual(summary.byLabel["model-switch"].count, 1);
  assert.strictEqual(summary.byLabel["model-switch"].retransmittedTokens, 200);
  assert.strictEqual(summary.byLabel.unknown.count, 1);
  assert.strictEqual(summary.byLabel.unknown.retransmittedTokens, 1500);

  assert.strictEqual(summary.byModel["claude-sonnet-3-5"].count, 2);
  assert.strictEqual(
    summary.byModel["claude-sonnet-3-5"].retransmittedTokens,
    1800,
  );
  assert.strictEqual(summary.byModel["gemini-3.8-flash"].count, 1);
  assert.strictEqual(
    summary.byModel["gemini-3.8-flash"].retransmittedTokens,
    200,
  );

  assert.strictEqual(summary.unknownExamples.length, 1);
  assert.strictEqual(summary.unknownExamples[0].sessionPath, "sess-2.jsonl");
});
