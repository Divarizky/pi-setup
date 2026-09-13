import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ci = readFileSync(join(process.cwd(), ".github", "workflows", "ci.yml"), "utf-8");

describe("release CI matrix", () => {
  it("gates Ubuntu Node 22 plus Windows and macOS Node 22/24", () => {
    expect(ci).toContain("os: [ubuntu-latest, windows-latest, macos-latest]");
    expect(ci).toContain("node: [22, 24]");
    expect(ci).toContain("exclude:");
    expect(ci).toContain("os: ubuntu-latest");
    expect(ci).toContain("node: 24");
  });

  it("runs install, lint, typecheck, tests, and build on the matrix", () => {
    expect(ci).toContain("npm ci");
    expect(ci).toContain("npm run lint");
    expect(ci).toContain("npm run typecheck");
    expect(ci).toContain("npm run test");
    expect(ci).toContain("npm run build");
  });
});
