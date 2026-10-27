import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { JudgeMode } from "./config.ts";
import type { JudgeDecision } from "./judge.ts";

export interface DecisionLogEntry {
  timestamp: string;
  sessionId?: string;
  decision: JudgeDecision;
  editCount: number;
  hasSuccessfulValidation: boolean;
  mode: JudgeMode;
  error?: string;
}

export function resolveAgentDir(): string {
  try {
    return getAgentDir();
  } catch {
    return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  }
}

export function getTaskJudgeLogPath(): string {
  return join(resolveAgentDir(), "task-judge.log");
}

export function appendJudgeLog(
  entry: DecisionLogEntry,
  customPath?: string,
): void {
  try {
    const targetPath = customPath ?? getTaskJudgeLogPath();
    mkdirSync(dirname(targetPath), { recursive: true });
    appendFileSync(targetPath, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
    });
  } catch (err) {
    // Fail-safe: penulisan log tidak boleh melempar error yang mengganggu Pi
    console.warn(`task-judge: gagal menulis log — ${(err as Error).message}`);
  }
}
