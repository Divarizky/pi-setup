import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface ReadinessCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly repairable: boolean;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly repaired: boolean;
  readonly checks: ReadonlyArray<ReadinessCheck>;
}

async function commandCheck(
  name: string,
  args: string[],
  shell = false,
): Promise<ReadinessCheck> {
  try {
    const result = await execFile(name, args, {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
      ...(shell ? { shell: true } : {}),
    });
    return {
      name,
      ok: true,
      detail:
        String(result.stdout || result.stderr)
          .trim()
          .split(/\r?\n/)[0] || "available",
      repairable: false,
    };
  } catch (error) {
    return {
      name,
      ok: false,
      detail:
        `${name} is unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          512,
        ),
      repairable: false,
    };
  }
}

export async function runReadinessDoctor(
  rootPath: string,
  autoRepair = false,
): Promise<ReadinessReport> {
  const root = path.resolve(rootPath);
  let repaired = false;
  if (autoRepair) {
    await mkdir(path.join(root, "state"), { recursive: true });
    await mkdir(path.join(root, "sessions"), { recursive: true });
    await mkdir(path.join(root, "projects"), { recursive: true });
    repaired = true;
  }
  const checks: ReadinessCheck[] = [
    await commandCheck("git", ["--version"]),
    await commandCheck("node", ["--version"]),
    process.platform === "win32"
      ? { ...(await commandCheck("where", ["npm"])), name: "npm" }
      : await commandCheck("npm", ["--version"]),
  ];
  for (const [name, relative] of [
    ["state directory", "state"],
    ["session directory", "sessions"],
    ["project directory", "projects"],
  ] as const) {
    try {
      const info = await lstat(path.join(root, relative));
      if (!info.isDirectory()) throw new Error("not a directory");
      checks.push({
        name,
        ok: true,
        detail: path.join(root, relative),
        repairable: true,
      });
    } catch {
      checks.push({
        name,
        ok: false,
        detail: `Missing or unsafe directory ${path.join(root, relative)}`,
        repairable: true,
      });
    }
  }
  return { ready: checks.every((check) => check.ok), repaired, checks };
}

export function formatReadinessReport(report: ReadinessReport): string {
  return [
    `Readiness: ${report.ready ? "ready" : "blocked"}${report.repaired ? " (safe repair applied)" : ""}`,
    ...report.checks.map(
      (check) => `${check.ok ? "ok" : "fail"} ${check.name}: ${check.detail}`,
    ),
  ].join("\n");
}
