import { afterEach, describe, expect, it } from "vitest";
import {
  getDefaultMaxTurns,
  normalizeMaxTurns,
  setDefaultMaxTurns,
} from "../src/agent-runner.js";

describe("setDefaultMaxTurns / getDefaultMaxTurns", () => {
  afterEach(() => setDefaultMaxTurns(40));

  it("updates the default and accepts unlimited", () => {
    setDefaultMaxTurns(30);
    expect(getDefaultMaxTurns()).toBe(30);
    setDefaultMaxTurns(undefined);
    expect(getDefaultMaxTurns()).toBeUndefined();
  });
});

describe("normalizeMaxTurns", () => {
  it("treats undefined as unlimited", () => {
    expect(normalizeMaxTurns(undefined)).toBeUndefined();
  });

  it("treats 0 as unlimited", () => {
    expect(normalizeMaxTurns(0)).toBeUndefined();
  });

  it("keeps positive values", () => {
    expect(normalizeMaxTurns(7)).toBe(7);
  });

  it("clamps negative values to 1", () => {
    expect(normalizeMaxTurns(-3)).toBe(1);
  });
});
