import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { Rule, TtsrDeps, ViolationEntry } from "./types.ts";

/**
 * Pola perintah bash yang dianggap sebagai verifikasi/validasi.
 * Cocok dengan test, check, build, tsc, lint, dan git diff (FR-9).
 */
export const VERIFICATION_COMMAND_REGEX =
  /(?:^|[;&|\s])(?:npm\s+(?:run\s+)?(?:test|check|build|lint)|pnpm\s+(?:run\s+)?(?:test|check|build|lint)|yarn\s+(?:run\s+)?(?:test|check|build|lint)|bun\s+(?:run\s+)?(?:test|check|build|lint)|vitest|jest|mocha|pytest|cargo\s+test|go\s+test|tsc\b|eslint\b|biome\s+check|git\s+diff\b)/i;

/**
 * Daftar tool yang diklasifikasikan sebagai mutasi (FR-9).
 */
export const MUTATION_TOOLS = new Set([
  "edit",
  "write",
  "hash_edit",
  "conflict_resolver",
]);

export interface SettleGateState {
  hasMutation: boolean;
  hasVerification: boolean;
  settleRejectedCount: number;
}

export function createSettleGateState(): SettleGateState {
  return {
    hasMutation: false,
    hasVerification: false,
    settleRejectedCount: 0,
  };
}

/**
 * Mengekstrak teks dari pesan user terakhir. Mendukung struktur pesan
 * array atau string biasa, baik dari sessionManager, event prompt, atau context.
 */
export function extractLastUserText(ctx: ExtensionContext): string {
  try {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (!entry) continue;

      // Bentuk 1: entry bertipe 'message' dengan message.role === 'user'
      const maybeMsg = (entry as { message?: { role?: string; content?: unknown } }).message;
      if (maybeMsg && maybeMsg.role === "user") {
        const c = maybeMsg.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) {
          return c
            .map((part: unknown) => {
              if (typeof part === "string") return part;
              if (part && typeof part === "object" && "text" in part) {
                return String((part as { text?: unknown }).text ?? "");
              }
              return "";
            })
            .join(" ");
        }
      }

      // Bentuk 2: entry bertipe user_prompt / sejenisnya
      const directRole = (entry as { role?: string; text?: unknown; prompt?: unknown }).role;
      if (directRole === "user") {
        const text =
          (entry as { text?: unknown }).text ??
          (entry as { prompt?: unknown }).prompt;
        if (typeof text === "string") return text;
      }
    }
  } catch {
    // Fail-open jika sessionManager tidak tersedia
  }
  return "";
}

/**
 * Memeriksa apakah pesan user cocok dengan salah satu pola `unlessUserSays`.
 */
export function matchesUnlessUserSays(
  rule: Rule,
  userText: string,
): boolean {
  if (!rule.compiledUnlessUserSays || rule.compiledUnlessUserSays.length === 0) {
    if (!rule.unlessUserSays || rule.unlessUserSays.length === 0) {
      return false;
    }
    return rule.unlessUserSays.some((pattern) => {
      try {
        return new RegExp(pattern, rule.flags || "i").test(userText);
      } catch {
        return false;
      }
    });
  }

  return rule.compiledUnlessUserSays.some((regex) => {
    try {
      regex.lastIndex = 0;
      return regex.test(userText);
    } catch {
      return false;
    }
  });
}

/**
 * Memeriksa apakah argumen tool cocok dengan condition rule.
 */
export function matchToolCondition(
  rule: Rule,
  serializedInput: string,
): { matched: boolean; excerpt?: string } {
  const conditions =
    rule.compiledConditions && rule.compiledConditions.length > 0
      ? rule.compiledConditions
      : (rule.condition || []).map((c) => new RegExp(c, rule.flags || "i"));

  for (const regex of conditions) {
    try {
      regex.lastIndex = 0;
      const match = regex.exec(serializedInput);
      if (match) {
        return {
          matched: true,
          excerpt: match[0],
        };
      }
    } catch {
      // Regex gagal diabaikan sesuai NFR-2
    }
  }

  return { matched: false };
}

/**
 * Memotong kutipan log maksimal 120 karakter.
 * Rule dengan nama 'secret-in-write' DILARANG memuat excerpt sama sekali (FR-10).
 */
export function sanitizeExcerpt(
  ruleName: string,
  rawExcerpt?: string,
): string | undefined {
  if (ruleName === "secret-in-write") {
    return undefined;
  }
  if (!rawExcerpt) return undefined;
  if (rawExcerpt.length <= 120) return rawExcerpt;
  return rawExcerpt.slice(0, 120);
}

/**
 * Mendaftarkan guard tool (FR-7) dan settle-gate (FR-9) ke runtime Pi.
 * Dibungkus penangkap error di setiap hook sesuai NFR-2 agar tidak pernah menjatuhkan sesi.
 */
export function registerToolGuard(pi: ExtensionAPI, deps: TtsrDeps): void {
  let settleState: SettleGateState = createSettleGateState();
  let lastUserPromptFromStart = "";

  // Reset settle-gate per run baru, dan tangkap prompt user jika tersedia
  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    try {
      settleState = createSettleGateState();
      if (event && "messageType" in event && event.messageType === "user") {
        lastUserPromptFromStart = typeof event.prompt === "string" ? event.prompt : "";
      }
    } catch (error) {
      console.warn("[ttsr] error di handler before_agent_start:", error);
    }
  });

  // FR-7: Guard pra-eksekusi pada tool_call
  pi.on(
    "tool_call",
    (event: ToolCallEvent, ctx: ExtensionContext): ToolCallEventResult | void => {
      try {
        const toolName = event.toolName;

        // Pelacakan mutasi dan verifikasi untuk settle-gate (FR-9)
        if (MUTATION_TOOLS.has(toolName)) {
          settleState.hasMutation = true;
        }

        if (toolName === "bash" || toolName === "powershell") {
          const command =
            typeof (event.input as { command?: unknown })?.command === "string"
              ? (event.input as { command: string }).command
              : "";
          if (VERIFICATION_COMMAND_REGEX.test(command)) {
            settleState.hasVerification = true;
          }
        }

        const serializedInput = JSON.stringify(event.input ?? {});
        const rules = deps.getRules();
        const expectedScope = `tool:${toolName}`;

        for (const rule of rules) {
          if (!rule.enabled) continue;
          if (!deps.isEnabled(rule.name)) continue;

          // Scope harus cocok dengan tool saat ini atau wildcard tool:*
          const isScoped =
            rule.scope === expectedScope ||
            rule.scope === "tool:*" ||
            (rule.scope.startsWith("tool:") &&
              rule.scope.slice(5) === toolName);

          if (!isScoped) continue;

          const matchResult = matchToolCondition(rule, serializedInput);
          if (!matchResult.matched) continue;

          // Rule bertipe 'log': hanya mencatat, tidak memblokir (FR-8)
          if (rule.action === "log") {
            try {
              const entry: ViolationEntry = {
                ts: Date.now(),
                rule: rule.name,
                action: "log",
                scope: expectedScope,
                retry: false,
                excerpt: sanitizeExcerpt(rule.name, matchResult.excerpt),
              };
              deps.log(entry);
            } catch (err) {
              console.warn("[ttsr] gagal mencatat log pelanggaran rule:", err);
            }
            continue;
          }

          // Rule bertipe 'block': cek pengecualian unlessUserSays
          if (rule.action === "block") {
            const userText =
              lastUserPromptFromStart || extractLastUserText(ctx);

            if (matchesUnlessUserSays(rule, userText)) {
              // Diizinkan oleh instruksi eksplisit user
              continue;
            }

            // Catat pemblokiran ke log (FR-10)
            try {
              const entry: ViolationEntry = {
                ts: Date.now(),
                rule: rule.name,
                action: "block",
                scope: expectedScope,
                retry: false,
                excerpt: sanitizeExcerpt(rule.name, matchResult.excerpt),
              };
              deps.log(entry);
            } catch (err) {
              console.warn("[ttsr] gagal mencatat log pemblokiran rule:", err);
            }

            // Kembalikan pemblokiran dengan alasan teks koreksi (FR-7)
            const reason =
              rule.correctionText && rule.correctionText.trim().length > 0
                ? rule.correctionText.trim()
                : `Eksekusi tool ${toolName} diblokir oleh rule keselamatan '${rule.name}'.`;

            return {
              block: true,
              reason,
            };
          }
        }
      } catch (error) {
        // NFR-2: Penanganan fail-safe, kegagalan guard tidak boleh mematikan sesi
        console.warn("[ttsr] error di handler tool_call:", error);
      }
    },
  );

  // FR-9: Settle-gate untuk memastikan mutasi diverifikasi sebelum giliran selesai
  pi.on(
    "agent_before_settle",
    (
      event: AgentBeforeSettleEvent,
      _ctx: ExtensionContext,
    ): AgentBeforeSettleEventResult | void => {
      try {
        if (event.outcome === "aborted") return;

        // Tanpa mutasi: settle-gate tidak melakukan apa-apa
        if (!settleState.hasMutation) {
          return;
        }

        // Sudah ada verifikasi: lolos
        if (settleState.hasVerification) {
          return;
        }

        // Ada mutasi tanpa verifikasi: tolak penutupan SATU KALI per run
        if (settleState.settleRejectedCount === 0) {
          settleState.settleRejectedCount += 1;

          const existingEntries = Array.isArray(event.entries)
            ? event.entries
            : [];

          const promptText =
            "Terdapat perubahan berkas (mutasi) yang belum diverifikasi. " +
            "Jalankan pengujian atau verifikasi yang relevan (misal: test, check, build, lint, git diff) " +
            "sebelum menyelesaikan respons.";

          return {
            entries: [
              ...existingEntries,
              {
                type: "custom_message",
                customType: "ttsr-settle-gate",
                content: promptText,
                display: false,
              },
            ],
            continue: true,
          };
        }

        // Penolakan kedua dan seterusnya: lolos agar tidak terjadi loop tanpa akhir
        return;
      } catch (error) {
        // NFR-2: Fail-open pada error
        console.warn("[ttsr] error di handler agent_before_settle:", error);
      }
    },
  );
}
