import { existsSync, rmSync, symlinkSync, cpSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const repoRoot = process.cwd();
const agentDir =
  process.env.PI_CODING_AGENT_DIR ||
  process.env.PI_AGENT_DIR ||
  path.join(os.homedir(), ".pi", "agent");

console.log(`Syncing runtime dependencies from ${repoRoot} to ${agentDir}...`);

if (!existsSync(agentDir)) {
  console.error(`Agent directory does not exist: ${agentDir}`);
  process.exit(1);
}

const sourceNodeModules = path.join(repoRoot, "node_modules");
const targetNodeModules = path.join(agentDir, "node_modules");

if (!existsSync(sourceNodeModules)) {
  console.error(
    `Source node_modules not found in ${repoRoot}. Run 'npm ci' first.`,
  );
  process.exit(1);
}

try {
  if (existsSync(targetNodeModules)) {
    console.log(`Removing existing ${targetNodeModules}...`);
    rmSync(targetNodeModules, { recursive: true, force: true });
  }

  if (process.platform === "win32") {
    console.log(
      `Creating directory junction: ${targetNodeModules} -> ${sourceNodeModules}`,
    );
    symlinkSync(sourceNodeModules, targetNodeModules, "junction");
  } else {
    console.log(
      `Creating symlink: ${targetNodeModules} -> ${sourceNodeModules}`,
    );
    symlinkSync(sourceNodeModules, targetNodeModules, "dir");
  }

  console.log("Successfully linked runtime node_modules!");
} catch (err) {
  console.warn(
    "Failed to create symlink/junction, falling back to copy:",
    err.message,
  );
  cpSync(sourceNodeModules, targetNodeModules, { recursive: true });
  console.log("Successfully copied runtime node_modules!");
}
