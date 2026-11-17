/**
 * context.test.ts — Parent conversation context extraction for inherit_context spawns.
 *
 * buildParentContext shapes what a subagent sees from its parent; silent bugs
 * here would feed wrong context into spawns. Tests use realistic SessionEntry
 * shapes and a minimal ExtensionContext stub — no mocking beyond the one
 * getBranch() call the function actually reads.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  MAX_PARENT_CONTEXT_CHARS,
  TRUNCATION_INDICATOR,
  buildParentContext,
  extractText,
} from "../src/context.js";

function makeCtx(entries: unknown[]): ExtensionContext {
  return { sessionManager: { getBranch: () => entries } } as unknown as ExtensionContext;
}

function userMsg(content: string | unknown[]) {
  return { type: "message", message: { role: "user", content } };
}

function assistantMsg(blocks: unknown[]) {
  return { type: "message", message: { role: "assistant", content: blocks } };
}

describe("extractText", () => {
  it("joins multiple text blocks with newlines", () => {
    expect(extractText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  });

  it("filters out non-text blocks (tool_use, etc.)", () => {
    expect(
      extractText([
        { type: "text", text: "keep" },
        { type: "tool_use", name: "x", input: {} },
        { type: "text", text: "also keep" },
      ]),
    ).toBe("keep\nalso keep");
  });

  it("treats a text block with missing text field as empty", () => {
    expect(extractText([{ type: "text" }, { type: "text", text: "x" }])).toBe("\nx");
  });

  it("returns empty string for an empty content array", () => {
    expect(extractText([])).toBe("");
  });
});

describe("buildParentContext", () => {
  it("returns empty string for an empty branch", () => {
    expect(buildParentContext(makeCtx([]))).toBe("");
  });

  it("returns empty string when no entries produce extractable content", () => {
    // toolResult is skipped, empty-summary compaction is skipped
    const out = buildParentContext(
      makeCtx([
        { type: "message", message: { role: "tool_result", content: "..." } },
        { type: "compaction", summary: "" },
      ]),
    );
    expect(out).toBe("");
  });

  it("wraps a user+assistant exchange with the parent-context header and task footer", () => {
    const out = buildParentContext(
      makeCtx([userMsg("hello"), assistantMsg([{ type: "text", text: "hi back" }])]),
    );
    expect(out).toContain("# Parent Conversation Context");
    expect(out).toContain("[User]: hello");
    expect(out).toContain("[Assistant]: hi back");
    expect(out).toMatch(/# Your Task \(below\)\n$/);
    // Entries are joined with a blank line, preserving conversation order
    expect(out).toContain("[User]: hello\n\n[Assistant]: hi back");
  });

  it("accepts user messages whose content is content-blocks (not just a string)", () => {
    const out = buildParentContext(makeCtx([userMsg([{ type: "text", text: "from blocks" }])]));
    expect(out).toContain("[User]: from blocks");
  });

  it("includes compaction summaries inline in their original position", () => {
    const out = buildParentContext(
      makeCtx([
        userMsg("orig question"),
        { type: "compaction", summary: "we discussed X" },
        assistantMsg([{ type: "text", text: "follow-up" }]),
      ]),
    );
    expect(out.indexOf("[User]: orig question"))
      .toBeLessThan(out.indexOf("[Summary]: we discussed X"));
    expect(out.indexOf("[Summary]: we discussed X"))
      .toBeLessThan(out.indexOf("[Assistant]: follow-up"));
  });

  it("skips tool_result messages — they're too verbose for inherited context", () => {
    const out = buildParentContext(
      makeCtx([
        userMsg("real user"),
        { type: "message", message: { role: "tool_result", content: "noisy tool output" } },
        assistantMsg([{ type: "text", text: "real assistant" }]),
      ]),
    );
    expect(out).not.toContain("noisy tool output");
    expect(out).toContain("[User]: real user");
    expect(out).toContain("[Assistant]: real assistant");
  });

  it("trims and skips whitespace-only messages", () => {
    const out = buildParentContext(
      makeCtx([userMsg("   \n  "), assistantMsg([{ type: "text", text: "non-empty" }])]),
    );
    expect(out).not.toMatch(/\[User\]:/);
    expect(out).toContain("[Assistant]: non-empty");
  });

  it("ignores assistant messages whose only content is non-text blocks", () => {
    // Assistant emitted only a tool_use — nothing extractable, so it shouldn't appear
    const out = buildParentContext(
      makeCtx([
        userMsg("question"),
        assistantMsg([{ type: "tool_use", name: "x", input: {} }]),
      ]),
    );
    expect(out).toContain("[User]: question");
    expect(out).not.toContain("[Assistant]:");
  });

  describe("truncation and budget enforcement", () => {
    it("exports MAX_PARENT_CONTEXT_CHARS as 12000 and TRUNCATION_INDICATOR", () => {
      expect(MAX_PARENT_CONTEXT_CHARS).toBe(12000);
      expect(TRUNCATION_INDICATOR).toBe("...(truncated earlier messages)...");
    });

    it("does not truncate histories within the character budget", () => {
      const entries = [
        userMsg("short prompt"),
        assistantMsg([{ type: "text", text: "short reply" }]),
      ];
      const out = buildParentContext(makeCtx(entries));
      expect(out).not.toContain(TRUNCATION_INDICATOR);
      expect(out).toContain("[User]: short prompt");
      expect(out).toContain("[Assistant]: short reply");
    });

    it("truncates earlier messages when total size exceeds MAX_PARENT_CONTEXT_CHARS", () => {
      // Create 20 messages of 1000 characters each (~20,000 chars total)
      const entries = [];
      for (let i = 0; i < 20; i++) {
        const pad = `msg-${i.toString().padStart(2, "0")}-` + "x".repeat(980);
        entries.push(userMsg(pad));
      }

      const out = buildParentContext(makeCtx(entries));

      // Indicator should be present
      expect(out).toContain(TRUNCATION_INDICATOR);
      // Oldest messages must have been dropped
      expect(out).not.toContain("msg-00-");
      expect(out).not.toContain("msg-01-");
      // Most recent messages must be preserved
      expect(out).toContain("msg-18-");
      expect(out).toContain("msg-19-");
      // Prepending indicator comes before the preserved recent messages
      expect(out.indexOf(TRUNCATION_INDICATOR)).toBeLessThan(out.indexOf("msg-18-"));
    });

    it("preserves the latest compaction summary when truncating long histories", () => {
      const summaryText = "Architectural decision: Use SQLite for local storage and indexed files.";
      const entries = [
        userMsg("old message 1: " + "a".repeat(4000)),
        assistantMsg([{ type: "text", text: "old reply 1: " + "b".repeat(4000) }]),
        { type: "compaction", summary: summaryText },
        userMsg("recent message 1: " + "c".repeat(4000)),
        assistantMsg([{ type: "text", text: "recent reply 1: " + "d".repeat(4000) }]),
        userMsg("most recent command"),
      ];

      const out = buildParentContext(makeCtx(entries));

      // The compaction summary must be preserved
      expect(out).toContain(`[Summary]: ${summaryText}`);
      // Truncation note must be present
      expect(out).toContain(TRUNCATION_INDICATOR);
      // Older messages should have been dropped to stay within budget
      expect(out).not.toContain("old message 1");
      // Most recent messages should be preserved
      expect(out).toContain("most recent command");
      // Order: Summary first, then truncation note, then recent messages
      expect(out.indexOf(`[Summary]: ${summaryText}`)).toBeLessThan(out.indexOf(TRUNCATION_INDICATOR));
      expect(out.indexOf(TRUNCATION_INDICATOR)).toBeLessThan(out.indexOf("most recent command"));
    });

    it("keeps only the latest compaction summary if multiple summaries exist", () => {
      const entries = [
        { type: "compaction", summary: "First summary that was superseded" },
        userMsg("intermediate message: " + "x".repeat(5000)),
        { type: "compaction", summary: "Second and latest active summary" },
        userMsg("recent message: " + "y".repeat(6000)),
        assistantMsg([{ type: "text", text: "latest reply: " + "z".repeat(3000) }]),
      ];

      const out = buildParentContext(makeCtx(entries));

      expect(out).toContain("[Summary]: Second and latest active summary");
      expect(out).not.toContain("First summary that was superseded");
      expect(out).toContain(TRUNCATION_INDICATOR);
      expect(out).toContain("latest reply:");
    });

    it("supports custom maxChars budget parameter", () => {
      const entries = [
        userMsg("early message 1"),
        assistantMsg([{ type: "text", text: "early message 2" }]),
        userMsg("recent message 3"),
        assistantMsg([{ type: "text", text: "recent message 4" }]),
      ];

      // Total text is ~110 chars. Setting budget to 75 fits recent message 4 and truncation note,
      // but truncates earlier messages.
      const out = buildParentContext(makeCtx(entries), 75);

      expect(out).toContain(TRUNCATION_INDICATOR);
      expect(out).not.toContain("early message 1");
      expect(out).not.toContain("recent message 3");
      expect(out).toContain("recent message 4");
    });

    it("handles a single massive message exceeding maxChars budget safely", () => {
      const hugeMsg = "z".repeat(20000);
      const out = buildParentContext(makeCtx([userMsg(hugeMsg)]), 500);

      expect(out).toContain(TRUNCATION_INDICATOR);
      expect(out).toContain("# Parent Conversation Context");
      // Extract the body between header and footer
      const body = out
        .replace(/^# Parent Conversation Context[\s\S]*?so far\.\n\n/, "")
        .replace(/\n\n---\n# Your Task \(below\)\n$/, "");
      expect(body.length).toBeLessThanOrEqual(500);
    });
  });
});
