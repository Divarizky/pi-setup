import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();
const extensionsDir = path.join(root, "extensions");
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmArgsPrefix =
  process.platform === "win32"
    ? [
        path.join(
          process.env.ProgramFiles ?? "C:/Program Files",
          "nodejs/node_modules/npm/bin/npm-cli.js",
        ),
      ]
    : [];

function runCheck(directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      npmCommand,
      [...npmArgsPrefix, "--prefix", directory, "run", "check"],
      {
        cwd: root,
        stdio: "inherit",
      },
    );
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal)
        reject(
          new Error(
            `${path.basename(directory)} check terminated by ${signal}`,
          ),
        );
      else if (code === 0) resolve();
      else
        reject(
          new Error(
            `${path.basename(directory)} check exited with code ${code}`,
          ),
        );
    });
  });
}

const extensionNames = (await readdir(extensionsDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const name of extensionNames) {
  const directory = path.join(extensionsDir, name);
  const packagePath = path.join(directory, "package.json");
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw new Error(
      `Cannot read ${path.relative(root, packagePath)}: ${error.message}`,
    );
  }
  if (!packageJson.scripts?.check) continue;
  await runCheck(directory);
}
