import { relative, sep } from "node:path";

export function isInsideProject(cwd: string, targetPath: string): boolean {
  // ponytail: sandbox cwd sederhana berbasis realpath+relative; upgrade path: openat/fd + jail jika perlu symlink-race hardening.
  const rel = relative(cwd, targetPath);
  if (rel === "" || rel === ".") return true;
  // normalisasi separator agar "/" dan "\" konsisten di kedua platform
  const normalized = rel.replaceAll("/", sep).replaceAll("\\", sep);
  // drive berbeda di Windows -> relative balikin path absolut
  if (process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(normalized)) return false;
  return !normalized.startsWith(`..${sep}`) && normalized !== "..";
}
