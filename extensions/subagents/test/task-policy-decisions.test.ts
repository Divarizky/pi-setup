import { describe, expect, it } from "vitest";
import {
  decideScopeOverlap,
  getRetentionDecision,
  planIntegrationValidation,
  planValidationCommands,
  rejectedBranchDecision,
} from "../src/task-control/policy-decisions.js";

describe("Agent Control delivery policy decisions", () => {
  describe("validation commands", () => {
    it("accepts one command and runs it sequentially with fail-fast semantics", () => {
      expect(planValidationCommands(["npm test"])).toEqual({
        accepted: true,
        commands: ["npm test"],
        execution: "sequential-fail-fast",
      });
    });

    it("accepts at most five commands and rejects a sixth command", () => {
      expect(planValidationCommands(["one", "two", "three", "four", "five", "six"])).toEqual({
        accepted: false,
        commands: ["one", "two", "three", "four", "five", "six"],
        execution: "sequential-fail-fast",
        reason: "A ship task may define at most five validation commands.",
      });
    });
  });

  describe("scope overlap", () => {
    it("blocks overlapping ship scopes by default", () => {
      expect(decideScopeOverlap({ overlaps: true, humanOverride: false })).toEqual({
        decision: "blocked",
        reason: "Overlapping ship scopes require an explicit human override.",
      });
    });

    it("allows an overlap only when a human explicitly overrides it", () => {
      expect(decideScopeOverlap({ overlaps: true, humanOverride: true })).toEqual({
        decision: "allowed-with-human-override",
        reason: "Overlap was explicitly approved by the human operator.",
      });
    });
  });

  describe("integration validation", () => {
    it("reuses the candidate validation commands instead of a separate project command", () => {
      expect(planIntegrationValidation(["npm test", "npm run lint"])).toEqual({
        accepted: true,
        commands: ["npm test", "npm run lint"],
        source: "candidate-validation",
        execution: "sequential-fail-fast",
      });
    });

    it("rejects an integration plan when the candidate validation plan is invalid", () => {
      expect(planIntegrationValidation(["one", "two", "three", "four", "five", "six"])).toEqual({
        accepted: false,
        commands: ["one", "two", "three", "four", "five", "six"],
        source: "candidate-validation",
        execution: "sequential-fail-fast",
        reason: "A ship task may define at most five validation commands.",
      });
    });
  });

  describe("retention", () => {
    it("retains task metadata without automatic expiry", () => {
      expect(getRetentionDecision("task")).toEqual({
        artifact: "task",
        automaticExpiry: false,
        action: "retain",
        cleanup: "explicit-administrative-action",
      });
    });

    it("retains event history and candidate metadata without automatic pruning", () => {
      expect(getRetentionDecision("event")).toEqual({
        artifact: "event",
        automaticExpiry: false,
        action: "retain",
        cleanup: "explicit-administrative-action",
      });
      expect(getRetentionDecision("candidate")).toEqual({
        artifact: "candidate",
        automaticExpiry: false,
        action: "retain",
        cleanup: "explicit-administrative-action",
      });
    });
  });

  describe("rejected branches", () => {
    it("preserves a rejected branch and disables UI deletion in the MVP", () => {
      expect(rejectedBranchDecision()).toEqual({
        action: "preserve",
        uiDeletion: false,
        cleanup: "explicit-administrative-action",
      });
    });

    it("does not turn rejection into an implicit destructive cleanup", () => {
      const decision = rejectedBranchDecision();
      expect(decision.action).not.toBe("delete");
      expect(decision.cleanup).toBe("explicit-administrative-action");
    });
  });
});
