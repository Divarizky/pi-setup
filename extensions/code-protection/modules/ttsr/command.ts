import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { computeRuleStats } from "./log.ts";
import type { TtsrStateManager } from "./state.ts";
import type { Rule } from "./types.ts";

export interface CommandDeps {
  getRules(): Rule[];
  stateManager: TtsrStateManager;
  logPath?: string;
}

export interface CommandOutput {
  text: string;
  level: "info" | "error" | "warning";
}

/**
 * Handler murni perintah /ttsr untuk memfasilitasi pengujian tanpa runtime penuh Pi.
 */
export function handleTtsrCommand(
  rawArgs: string | undefined,
  deps: CommandDeps,
): CommandOutput {
  const trimmed = (rawArgs ?? "").trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();

  const rules = deps.getRules();

  if (!sub || sub === "list") {
    if (rules.length === 0) {
      return {
        text: "Tidak ada rule TTSR yang terdaftar.",
        level: "info",
      };
    }

    const lines: string[] = ["Aturan TTSR terdaftar:"];
    for (const r of rules) {
      const active = deps.stateManager.isEnabled(r.name, r.enabled !== false);
      const statusLabel = active ? "on" : "off";
      lines.push(`- ${r.name} [${r.action}/${r.scope}]: ${statusLabel}`);
    }
    return {
      text: lines.join("\n"),
      level: "info",
    };
  }

  if (sub === "on") {
    const targetName = parts[1]?.trim();
    if (!targetName) {
      return {
        text: "Format salah. Gunakan: /ttsr on <nama-rule>",
        level: "error",
      };
    }

    const rule = rules.find((r) => r.name === targetName);
    if (!rule) {
      return {
        text: `Rule '${targetName}' tidak ditemukan. Jalankan '/ttsr list' untuk melihat daftar rule.`,
        level: "error",
      };
    }

    deps.stateManager.setRuleEnabled(rule.name, true);
    return {
      text: `Rule '${rule.name}' berhasil diaktifkan (on).`,
      level: "info",
    };
  }

  if (sub === "off") {
    const targetName = parts[1]?.trim();
    if (!targetName) {
      return {
        text: "Format salah. Gunakan: /ttsr off <nama-rule>",
        level: "error",
      };
    }

    const rule = rules.find((r) => r.name === targetName);
    if (!rule) {
      return {
        text: `Rule '${targetName}' tidak ditemukan. Jalankan '/ttsr list' untuk melihat daftar rule.`,
        level: "error",
      };
    }

    deps.stateManager.setRuleEnabled(rule.name, false);
    return {
      text: `Rule '${rule.name}' dinonaktifkan (off).`,
      level: "info",
    };
  }

  if (sub === "stats") {
    const stats = computeRuleStats(deps.logPath);
    if (stats.length === 0) {
      return {
        text: "Belum ada catatan pelanggaran TTSR pada log.",
        level: "info",
      };
    }

    const lines: string[] = [
      "Statistik Pelanggaran TTSR (diurutkan berdasarkan retry koreksi):",
    ];
    for (const stat of stats) {
      lines.push(
        `- ${stat.rule}: ${stat.violations} pelanggaran, ${stat.retries} retry koreksi`,
      );
    }
    return {
      text: lines.join("\n"),
      level: "info",
    };
  }

  return {
    text:
      `Perintah '/ttsr ${sub}' tidak dikenal.\n` +
      "Penggunaan: /ttsr [list | on <rule> | off <rule> | stats]",
    level: "error",
  };
}

/**
 * Mendaftarkan perintah /ttsr ke instance ExtensionAPI Pi.
 */
export function registerTtsrCommand(
  pi: ExtensionAPI,
  deps: CommandDeps,
): void {
  pi.registerCommand("ttsr", {
    description: "Kelola status rule dan statistik TTSR (Time-Traveling Stream Rules)",
    handler: async (args, ctx) => {
      try {
        const output = handleTtsrCommand(typeof args === "string" ? args : "", deps);
        if (ctx?.ui?.notify) {
          ctx.ui.notify(output.text, output.level);
        } else {
          console.log(`[ttsr] ${output.text}`);
        }
      } catch (err) {
        console.warn("[ttsr] gagal mengeksekusi perintah /ttsr:", err);
      }
    },
  });
}
