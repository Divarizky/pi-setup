import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveAgentDir } from "./log.ts";

export interface TtsrStateData {
  /** Map nama rule ke status aktif (true = on, false = off). */
  rules: Record<string, boolean>;
}

export function resolveStatePath(agentDir?: string): string {
  return join(agentDir ?? resolveAgentDir(), "ttsr-state.json");
}

export class TtsrStateManager {
  private filePath: string;
  private state: TtsrStateData;

  constructor(filePath?: string) {
    this.filePath = filePath ?? resolveStatePath();
    this.state = this.readFromDisk();
  }

  /**
   * Membaca berkas state dari disk. Mengembalikan state kosong jika
   * berkas belum ada atau data korup.
   */
  private readFromDisk(): TtsrStateData {
    if (!existsSync(this.filePath)) {
      return { rules: {} };
    }

    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<TtsrStateData>;
      if (parsed && typeof parsed === "object") {
        if (parsed.rules && typeof parsed.rules === "object") {
          return { rules: { ...parsed.rules } };
        }
        // Kompatibilitas jika disimpan sebagai array disabledRules
        if (Array.isArray((parsed as { disabledRules?: unknown[] }).disabledRules)) {
          const rules: Record<string, boolean> = {};
          for (const name of (parsed as { disabledRules: string[] }).disabledRules) {
            if (typeof name === "string") rules[name] = false;
          }
          return { rules };
        }
      }
      return { rules: {} };
    } catch {
      return { rules: {} };
    }
  }

  /**
   * Menyimpan status saat ini ke disk.
   */
  save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(
        this.filePath,
        JSON.stringify(this.state, null, 2),
        "utf8",
      );
    } catch (err) {
      console.warn(`[ttsr] gagal menyimpan state ke '${this.filePath}':`, err);
    }
  }

  /**
   * Memuat ulang state dari disk.
   */
  reload(): void {
    this.state = this.readFromDisk();
  }

  /**
   * Memeriksa apakah suatu rule aktif. Bila belum pernah diatur eksplisit,
   * mengikuti status bawaan (defaultEnabled, default true).
   */
  isEnabled(ruleName: string, defaultEnabled = true): boolean {
    const explicit = this.state.rules[ruleName];
    if (explicit !== undefined) {
      return explicit;
    }
    return defaultEnabled;
  }

  /**
   * Mengatur status on/off untuk rule dan menyimpannya langsung ke disk.
   */
  setRuleEnabled(ruleName: string, enabled: boolean): void {
    this.state.rules[ruleName] = enabled;
    this.save();
  }

  /**
   * Mengambil snapshot state semua rule yang tersimpan.
   */
  getAllRules(): Record<string, boolean> {
    return { ...this.state.rules };
  }
}
