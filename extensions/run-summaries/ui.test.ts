import assert from "node:assert/strict";
import test from "node:test";
import { renderRecap } from "./src/ui.ts";

const dummyTheme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
} as any;

test("renderRecap produces valid Card box and renders without crashing", () => {
  const recap = renderRecap(
    {
      recap: "Completed task safely",
      next: "No further action required.",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      reasoning: "medium",
    },
    true,
    dummyTheme,
  );

  const lines = (recap as any).render(80);
  assert.ok(Array.isArray(lines));
  assert.ok(lines.length > 0);
});

test("renderRecap handles missing data with warning", () => {
  const recap = renderRecap(undefined, false, dummyTheme);
  assert.ok(recap);
});
