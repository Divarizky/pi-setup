import assert from "node:assert/strict";
import test from "node:test";
import {
  groupDashboardByProject,
  reconcileDashboardSelection,
  type DashboardSelection,
} from "../src/ui/takeover.ts";
import type { SubagentSnapshot } from "../src/domain.ts";

const snapshot = (id: string, cwd: string) =>
  ({
    id,
    cwd,
    meta: { backend: "pi" as const },
  }) as unknown as SubagentSnapshot;

test("dashboard groups snapshots by repository or source directory", () => {
  const groups = groupDashboardByProject([
    snapshot("docs-1", "/workspace/docs"),
    snapshot("api-1", "/workspace/api"),
    snapshot("docs-2", "/workspace/docs"),
  ]);
  assert.deepEqual(
    groups.map((group) => ({
      label: group.label,
      ids: group.snapshots.map((snap) => snap.id),
    })),
    [
      { label: "docs", ids: ["docs-1", "docs-2"] },
      { label: "api", ids: ["api-1"] },
    ],
  );
});

test("dashboard selection follows its subagent id and falls back by row", () => {
  const selection: DashboardSelection = { id: "sa-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "sa-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `sa-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "sa-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `sa-${index + 1}` })),
    { id: "sa-8" },
    { id: "sa-9" },
  ]);
  assert.deepEqual(selection, { id: "sa-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "sa-1" }, { id: "sa-2" }]);
  assert.deepEqual(selection, { id: "sa-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});
