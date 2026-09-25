import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const extensionsRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(extensionsRoot, "..");

async function run(command, args, cwd) {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env: { ...process.env, CI: "1" },
      timeout: 30_000,
      maxBuffer: 1_000_000,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    const detail = error && typeof error === "object"
      ? `${error.message ?? ""}\n${error.stderr ?? ""}`
      : String(error);
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}:\n${detail}`);
  }
}

async function importTypeScriptExtension(name) {
  const cwd = join(extensionsRoot, name);
  await run(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    "const extension = await import('./index.ts'); if (typeof extension.default !== 'function') process.exit(1);",
  ], cwd);
}

async function runNpm(args, cwd) {
  if (process.platform === "win32") {
    return run("cmd.exe", ["/d", "/s", "/c", `npm.cmd ${args.join(" ")}`], cwd);
  }
  return run("npm", args, cwd);
}

async function importSubagentsExtension() {
  const cwd = join(extensionsRoot, "subagents");
  const requireFromPackage = createRequire(join(cwd, "package.json"));
  const typescriptEntry = requireFromPackage.resolve("typescript");
  const typeboxEntry = requireFromPackage.resolve("@sinclair/typebox");
  let nodeModulesRoot = dirname(typeboxEntry);
  while (basename(nodeModulesRoot) !== "node_modules") {
    const parent = dirname(nodeModulesRoot);
    if (parent === nodeModulesRoot) throw new Error("node_modules tidak ditemukan untuk subagents.");
    nodeModulesRoot = parent;
  }

  const buildDir = await mkdtemp(join(nodeModulesRoot, ".runtime-smoke-"));
  try {
    const tscPath = resolve(dirname(typescriptEntry), "..", "bin", "tsc");
    await run(process.execPath, [
      tscPath,
      "--project",
      join(cwd, "tsconfig.json"),
      "--outDir",
      buildDir,
    ], cwd);

    const subagentsEntry = await import(pathToFileURL(join(buildDir, "index.js")).href);
    if (typeof subagentsEntry.default !== "function") {
      throw new Error("subagents dist entry tidak mengekspor extension function.");
    }
  } finally {
    await rm(buildDir, { recursive: true, force: true });
  }
}

async function checkSubagentsArtifact() {
  const cwd = join(extensionsRoot, "subagents");
  const output = await runNpm(["pack", "--dry-run", "--json"], cwd);
  const metadata = JSON.parse(output.slice(output.indexOf("[")));
  const files = new Set(metadata[0]?.files?.map((file) => file.path) ?? []);
  for (const required of ["index.ts", "src/index.ts", "package.json"]) {
    if (!files.has(required)) throw new Error(`npm package tidak memuat ${required}`);
  }
}

async function checkSettingsPath() {
  let contents;
  try {
    contents = await readFile(join(workspaceRoot, "settings.json"), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      console.log("runtime smoke: settings.json tidak tersedia; pemeriksaan lokal dilewati.");
      return;
    }
    throw error;
  }

  const settings = JSON.parse(contents);
  if (!settings.packages?.includes("./extensions/subagents")) {
    throw new Error("settings.json harus memakai path lokal POSIX-portable ./extensions/subagents.");
  }
}

async function checkHostExecutables() {
  const isWindows = process.platform === "win32";
  const shell = isWindows ? "cmd.exe" : "/bin/sh";
  const shellArgs = isWindows
    ? ["/d", "/s", "/c", "if \"runtime-smoke\"==\"runtime-smoke\" exit /b 0"]
    : ["-c", "test \"$(printf runtime-smoke)\" = runtime-smoke"];
  await run(shell, shellArgs, extensionsRoot);
  await run(isWindows ? "python" : "python3", ["-c", "assert 'runtime-smoke' == 'runtime-smoke'"], extensionsRoot);
  await run("git", ["--version"], extensionsRoot);
}

await checkSettingsPath();
await checkHostExecutables();
await importTypeScriptExtension("context-manager");
await importTypeScriptExtension("run-summaries");
await importTypeScriptExtension("usage-tracker");

await importSubagentsExtension();
await checkSubagentsArtifact();
console.log(`runtime smoke passed: ${process.platform}, Node ${process.versions.node}`);
