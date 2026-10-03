// agent-memory: injeksi read-only `memory brief` (vault Obsidian bersama
// untuk Pi, Claude Code, Codex) ke system prompt setiap sesi. Tanpa LLM,
// tanpa server, tanpa capture per turn — menulis tetap lewat skill.
//
// Catatan: import hanya untuk tipe TypeScript (dihapus saat kompilasi).
// Kandidat path yang tidak ada otomatis gagal dan dilewati.
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

let briefCache = "";
let briefCwd = "";

function skillScript(): string {
  if (process.env.AGENT_MEMORY_SKILL) return process.env.AGENT_MEMORY_SKILL;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const sep = process.platform === "win32" ? "\\" : "/";
  const j = (...parts: string[]): string => parts.join(sep);
  if (process.platform === "win32") {
    return j("G:", "My Drive", "AGENT-MEMORY", "agent-memory-skill", "memory.py");
  }
  if (process.platform === "darwin") {
    return j(
      home, "Library", "CloudStorage",
      "GoogleDrive-divarizky28@gmail.com", "My Drive",
      "AGENT-MEMORY", "agent-memory-skill", "memory.py",
    );
  }
  return j(home, ".agents", "skills", "agent-memory", "memory.py");
}

async function loadBrief(pi: ExtensionAPI, cwd: string): Promise<string> {
  if (briefCache && briefCwd === cwd) return briefCache;
  const script = skillScript();
  // unix: pakai `memory` di PATH dulu (termasuk hasil install.sh).
  // Windows: Node spawn tanpa shell tidak bisa menjalankan .bat, jadi
  // panggil python langsung dengan path absolut ke memory.py.
  // Folder skill per-OS (~/.agents/skills/...) dicoba juga sebagai fallback.
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const sep = process.platform === "win32" ? "\\" : "/";
  const local = home
    + sep + ".agents" + sep + "skills" + sep + "agent-memory" + sep + "memory.py";
  const attempts: [string, string[]][] =
    process.platform === "win32"
      ? [
          ["py", ["-3", script, "brief", "--max-tokens", "300"]],
          ["python", [script, "brief", "--max-tokens", "300"]],
          ["py", ["-3", local, "brief", "--max-tokens", "300"]],
          ["python", [local, "brief", "--max-tokens", "300"]],
        ]
      : [
          ["memory", ["brief", "--max-tokens", "300"]],
          ["python3", [script, "brief", "--max-tokens", "300"]],
          ["python3", [local, "brief", "--max-tokens", "300"]],
        ];
  for (const [cmd, args] of attempts) {
    try {
      const { stdout, code } = await pi.exec(cmd, args, {
        cwd,
        timeout: 15000,
      });
      if (code === 0 && stdout && stdout.trim()) {
        briefCache = stdout.trim();
        briefCwd = cwd;
        return briefCache;
      }
    } catch {
      // coba cara berikutnya; gagal total = sesi jalan tanpa brief
    }
  }
  return "";
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    await loadBrief(pi, ctx.cwd);
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<BeforeAgentStartEventResult | undefined> => {
    const brief = await loadBrief(pi, ctx.cwd);
    if (!brief) return;
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n## Agent Memory (vault bersama)\n" +
        brief +
        "\n",
    };
  });
}
