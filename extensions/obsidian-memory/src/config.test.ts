import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMemoryConfig, resolveProjectSlug } from "./config.ts";

test("loads an explicit cwd-to-project mapping and resolves child cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-memory-config-"));
  const project = join(root, "project");
  const vault = join(root, "vault");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(vault);
  const configPath = join(root, "obsidian-memory.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      vault,
      projectMap: { [project]: "my-project" },
    }),
  );

  const config = loadMemoryConfig(configPath);
  assert.equal(config.valid, true);
  assert.equal(config.vault, realpathSync(vault));
  assert.equal(resolveProjectSlug(join(project, "src"), config), "my-project");
});

test("fails closed for relative paths and unsafe project slugs", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-memory-config-"));
  const vault = join(root, "vault");
  const unsafe = join(root, "unsafe");
  mkdirSync(vault);
  mkdirSync(unsafe);
  const configPath = join(root, "obsidian-memory.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      vault,
      projectMap: {
        relative: "valid-project",
        [unsafe]: "../escape",
      },
    }),
  );

  const config = loadMemoryConfig(configPath);
  assert.equal(config.valid, false);
  assert.equal(resolveProjectSlug(join(root, "unsafe"), config), null);
  assert.equal(
    resolveProjectSlug(join(root, "unsafe"), {
      vault,
      projectMap: { [unsafe]: "safe-project" },
      valid: false,
    }),
    null,
  );
});

test("fails closed for a missing configured vault", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-memory-config-"));
  const configPath = join(root, "obsidian-memory.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      vault: join(root, "missing-vault"),
      projectMap: {},
    }),
  );

  const config = loadMemoryConfig(configPath);
  assert.equal(config.valid, false);
});

test("fails closed for malformed JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-memory-config-"));
  const configPath = join(root, "obsidian-memory.json");
  writeFileSync(configPath, "{not-json");

  const config = loadMemoryConfig(configPath);
  assert.equal(config.valid, false);
});
