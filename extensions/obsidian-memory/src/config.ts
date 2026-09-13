import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const DEFAULT_VAULT =
  process.env.PI_VAULT ??
  "/Users/user/Library/CloudStorage/GoogleDrive-divarizky28@gmail.com/My Drive/AGENT-MEMORY/pi-memory";
const AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const CONFIG_PATH =
  process.env.PI_OBSIDIAN_MEMORY_CONFIG ??
  join(AGENT_DIR, "obsidian-memory.json");
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface MemoryConfig {
  readonly vault: string;
  readonly projectMap: Readonly<Record<string, string>>;
  readonly valid: boolean;
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function validSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_PATTERN.test(value);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function defaultConfig(): MemoryConfig {
  const vault = canonicalPath(DEFAULT_VAULT);
  return {
    vault,
    projectMap: {},
    // A missing config may use the documented default, but never create it.
    valid: isDirectory(vault),
  };
}

function invalidConfig(): MemoryConfig {
  return {
    vault: canonicalPath(DEFAULT_VAULT),
    projectMap: {},
    valid: false,
  };
}

function parseConfig(value: unknown): MemoryConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidConfig();
  }

  const input = value as { vault?: unknown; projectMap?: unknown };
  if (typeof input.vault !== "string" || !isAbsolute(input.vault)) {
    return invalidConfig();
  }
  const vault = canonicalPath(input.vault);
  if (!isDirectory(vault)) return invalidConfig();

  const projectMap: Record<string, string> = {};
  if (input.projectMap !== undefined) {
    if (
      !input.projectMap ||
      typeof input.projectMap !== "object" ||
      Array.isArray(input.projectMap)
    ) {
      return invalidConfig();
    }
    for (const [cwd, slug] of Object.entries(input.projectMap)) {
      if (!isAbsolute(cwd) || !validSlug(slug) || !isDirectory(cwd)) {
        return invalidConfig();
      }
      projectMap[canonicalPath(cwd)] = slug;
    }
  }

  return { vault, projectMap, valid: true };
}

export function getMemoryConfigPath(): string {
  return CONFIG_PATH;
}

export function loadMemoryConfig(customPath = CONFIG_PATH): MemoryConfig {
  if (!existsSync(customPath)) return defaultConfig();
  try {
    return parseConfig(JSON.parse(readFileSync(customPath, "utf8")));
  } catch {
    return invalidConfig();
  }
}

export function resolveProjectSlug(
  cwd: string,
  config: MemoryConfig,
): string | null {
  if (!config.valid) return null;
  let current = canonicalPath(cwd);
  const root = resolve(current, "/");

  while (true) {
    const slug = config.projectMap[current];
    if (slug) return slug;
    if (current === root) return null;
    current = resolve(current, "..");
  }
}

export function isValidProjectSlug(value: unknown): value is string {
  return validSlug(value);
}
