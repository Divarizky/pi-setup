import { realpath, stat } from "node:fs/promises";
import path from "node:path";

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Resolve a persisted session file only when it is a regular file inside one
 * of the managed session roots. Missing files are treated as a fresh-session
 * request; existing symlinks are checked by their canonical target.
 */
export async function resolveManagedSessionFile(
  sessionFilePath: string | undefined,
  managedRoots: ReadonlyArray<string>,
): Promise<string | undefined> {
  if (!sessionFilePath) return undefined;
  const candidate = path.resolve(sessionFilePath);
  if (!managedRoots.some((root) => isWithin(path.resolve(root), candidate))) {
    throw new Error(
      "Refusing to reopen an Agent Lead session outside managed session directories.",
    );
  }
  let info;
  try {
    info = await stat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Cannot inspect persisted Agent Lead session: ${String(error)}`,
    );
  }
  if (!info.isFile())
    throw new Error("Persisted Agent Lead session path is not a regular file.");

  const canonicalCandidate = await realpath(candidate);
  for (const root of managedRoots) {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(path.resolve(root));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(
        `Cannot inspect managed Agent Lead session directory: ${String(error)}`,
      );
    }
    if (isWithin(canonicalRoot, canonicalCandidate)) return canonicalCandidate;
  }
  throw new Error(
    "Refusing to reopen an Agent Lead session outside managed session directories.",
  );
}

/** Resolve an existing Agent Lead home beneath the managed leads directory. */
export async function resolveManagedLeadHome(
  homePath: string | undefined,
  leadsRoot: string,
): Promise<string | undefined> {
  if (!homePath) return undefined;
  const candidate = path.resolve(homePath);
  const resolvedRoot = path.resolve(leadsRoot);
  if (!isWithin(resolvedRoot, candidate)) {
    throw new Error(
      "Refusing to reopen an Agent Lead home outside the managed lead directory.",
    );
  }
  let info;
  try {
    info = await stat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Cannot inspect persisted Agent Lead home: ${String(error)}`,
    );
  }
  if (!info.isDirectory())
    throw new Error("Persisted Agent Lead home is not a directory.");
  const canonicalRoot = await realpath(path.resolve(leadsRoot));
  const canonicalCandidate = await realpath(candidate);
  if (!isWithin(canonicalRoot, canonicalCandidate)) {
    throw new Error(
      "Refusing to reopen an Agent Lead home outside the managed lead directory.",
    );
  }
  return canonicalCandidate;
}
