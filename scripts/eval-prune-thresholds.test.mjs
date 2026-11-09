import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateTokens,
  formatEvaluationReport,
  getModelContextWindow,
  runEvaluation,
  SCENARIOS,
  simulateSession,
} from "./eval-prune-thresholds.mjs";

test("getModelContextWindow recognizes known models and falls back appropriately", () => {
  assert.equal(getModelContextWindow("ag/gemini-3.8-flash"), 1_000_000);
  assert.equal(getModelContextWindow("cc/claude-sonnet-5-5"), 200_000);
  assert.equal(getModelContextWindow("oc/deepseek-v4.1-flash-free"), 64_000);
  assert.equal(getModelContextWindow("custom-gemini-model"), 1_000_000);
  assert.equal(getModelContextWindow("custom-claude-model"), 200_000);
  assert.equal(getModelContextWindow("custom-unknown-model"), 128_000);
  assert.equal(getModelContextWindow(""), null);
});

test("estimateTokens calculates ceil(length / 4)", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("a".repeat(1000)), 250);
});

test("simulateSession tracks tool results and detects prune cache breaks", () => {
  const entries = [
    {
      type: "session",
      id: "test-session",
    },
    // ToolResult 1: 8,000 karakter (~2,000 token)
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: "x".repeat(8000),
      },
    },
    // Assistant 1
    {
      type: "message",
      message: {
        role: "assistant",
        model: "cc/claude-sonnet-5-5",
        usage: {
          input: 3000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    },
    // ToolResult 2: 12,000 karakter (>8k, disummarize ke 1900 -> ~475 token)
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call_2",
        toolName: "bash",
        content: "y".repeat(12000),
      },
    },
    // Assistant 2
    {
      type: "message",
      message: {
        role: "assistant",
        model: "cc/claude-sonnet-5-5",
        usage: {
          input: 500,
          output: 100,
          cacheRead: 5000,
          cacheWrite: 0,
        },
      },
    },
  ];

  const config = {
    name: "Test Config",
    budgetTokens: 24_000,
    watermark: 0.5,
    charThreshold: 8_000,
    lineThreshold: 300,
    looseWindowProtection: false,
  };

  const sim = simulateSession(entries, config);
  // Belum melampaui budget 24k token, jadi pruneEvents = 0
  assert.equal(sim.pruneEvents, 0);
  assert.equal(sim.cacheBreaks, 0);
  assert.ok(sim.peakLiveTokens > 0);
});

test("simulateSession triggers pruning and detects subsequent cache break when budget is exceeded", () => {
  const entries = [];
  // Tambah tool results besar berturut-turut untuk melampaui budget 4k token
  for (let i = 0; i < 5; i++) {
    entries.push({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: `call_${i}`,
        toolName: "read",
        content: "z".repeat(6000), // ~1500 token tiap tool
      },
    });
  }

  // Assistant turn di mana pruning terjadi
  entries.push({
    type: "message",
    message: {
      role: "assistant",
      model: "cc/claude-sonnet-5-5",
      usage: {
        input: 1000,
        output: 100,
        cacheRead: 10000,
        cacheWrite: 0,
      },
    },
  });

  // Assistant turn berikutnya yang terkena dampak cache break
  entries.push({
    type: "message",
    message: {
      role: "assistant",
      model: "cc/claude-sonnet-5-5",
      usage: {
        input: 11000,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
      },
    },
  });

  const config = {
    name: "Small Budget Test",
    budgetTokens: 4_000,
    watermark: 0.5,
    charThreshold: 8_000,
    lineThreshold: 300,
    looseWindowProtection: false,
  };

  const sim = simulateSession(entries, config);
  assert.ok(sim.pruneEvents > 0, "harus ada prune event karena melebihi budget");
  assert.ok(sim.cacheBreaks > 0, "harus mendeteksi cache break pada turn berikutnya");
  assert.ok(sim.retransmittedTokens > 0);
  assert.ok(sim.tokensSavedInContext > 0);
});

test("formatEvaluationReport generates formatted markdown table", () => {
  const mockData = {
    sessionsAnalyzed: 5,
    results: [
      {
        scenario: "Test 1",
        pruneEvents: 10,
        cacheBreaks: 8,
        retransmittedTokens: 50000,
        tokensSavedInContext: 10000,
        netTokenCost: 40000,
        tradeOffRatio: "5.00",
        peakLiveTokens: 25000,
      },
    ],
  };

  const report = formatEvaluationReport(mockData);
  assert.match(report, /Total Sesi Dianalisis: 5/);
  assert.match(report, /\| Test 1 \| 10 \| 8 \| 50\.000 \| 10\.000 \| \+40\.000 \| 5\.00x \| 25\.000 \|/);
});
