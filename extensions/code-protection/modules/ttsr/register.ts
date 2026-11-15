import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTtsrCommand } from "./command.ts";
import { registerToolGuard } from "./guards.ts";
import { appendViolationLog } from "./log.ts";
import { loadRules } from "./rule.ts";
import { TtsrStateManager } from "./state.ts";
import { registerStreamGuard } from "./stream.ts";
import type { TtsrDeps } from "./types.ts";

export interface RegisterTtsrOptions {
  rulesDir?: string;
  statePath?: string;
  logPath?: string;
}

/**
 * Merangkai dan mendaftarkan seluruh komponen TTSR ke runtime Pi:
 * - Memuat rule dari direktori berkas markdown
 * - Inisialisasi stateManager untuk status on/off
 * - Inisialisasi logger JSONL
 * - Mendaftarkan guard stream (registerStreamGuard)
 * - Mendaftarkan guard tool dan settle-gate (registerToolGuard)
 * - Mendaftarkan perintah slash /ttsr (registerTtsrCommand)
 */
export function registerTtsr(
  pi: ExtensionAPI,
  options: RegisterTtsrOptions = {},
): void {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const rulesDir = options.rulesDir ?? join(currentDir, "rules");

  const rules = loadRules(rulesDir);
  const stateManager = new TtsrStateManager(options.statePath);

  const deps: TtsrDeps = {
    getRules: () => rules,
    log: (entry) => appendViolationLog(entry, options.logPath),
    isEnabled: (name) => stateManager.isEnabled(name),
  };

  registerStreamGuard(pi, deps);
  registerToolGuard(pi, deps);
  registerTtsrCommand(pi, {
    getRules: () => rules,
    stateManager,
    logPath: options.logPath,
  });
}
