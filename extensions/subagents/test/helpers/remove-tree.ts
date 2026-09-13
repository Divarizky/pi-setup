import { rmSync } from "node:fs";

/** Remove a test-owned tree, tolerating delayed Windows file-handle release. */
export function removeTree(path: string): void {
  try {
    rmSync(path, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 20 : 0,
      retryDelay: process.platform === "win32" ? 100 : 0,
    });
  } catch (error: unknown) {
    // pi's in-memory sessions can retain a native directory handle until the
    // owning test worker exits. Do not turn that Windows-only cleanup detail
    // into a behavioral test failure; the OS reclaims the temp tree at exit.
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EBUSY")) throw error;
  }
}
