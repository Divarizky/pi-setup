import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import codeSafetyExtension from "../../index.ts";
import { registerTtsr } from "./register.ts";

function createMockPi() {
  const events = new Map<string, Function[]>();
  const commands = new Map<string, unknown>();
  const tools: string[] = [];

  return {
    events,
    commands,
    tools,
    on(event: string, handler: Function) {
      const list = events.get(event) ?? [];
      list.push(handler);
      events.set(event, list);
    },
    registerCommand(name: string, opts: unknown) {
      commands.set(name, opts);
    },
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
  };
}

test("registerTtsr berhasil mendaftarkan hook stream, guard tool, dan perintah ttsr", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ttsr-reg-test-"));
  const mockPi = createMockPi();

  try {
    registerTtsr(mockPi as any, {
      statePath: join(tmp, "ttsr-state.json"),
      logPath: join(tmp, "ttsr-log.jsonl"),
    });

    // Periksa hook yang terdaftar
    assert.ok(mockPi.events.has("message_update"), "Harus mendaftarkan hook message_update");
    assert.ok(mockPi.events.has("tool_call"), "Harus mendaftarkan hook tool_call");
    assert.ok(mockPi.events.has("agent_before_settle"), "Harus mendaftarkan hook agent_before_settle");

    // Periksa perintah /ttsr
    assert.ok(mockPi.commands.has("ttsr"), "Harus mendaftarkan perintah /ttsr");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("AC: Jika registerTtsr melempar error, modul lain di code-safety tetap terdaftar (isolasi index.ts)", () => {
  const mockPi = createMockPi();
  let registerTtsrCallCount = 0;

  // Modifikasi sementara registerCommand untuk melempar error khusus saat ttsr didaftarkan
  const originalRegisterCommand = mockPi.registerCommand;
  mockPi.registerCommand = (name: string, opts: unknown) => {
    if (name === "ttsr") {
      registerTtsrCallCount++;
      throw new Error("Simulasi kegagalan fatal inisialisasi TTSR");
    }
    return originalRegisterCommand.call(mockPi, name, opts);
  };

  // Tangkap peringatan console.warn
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };

  try {
    // Eksekusi entry point utama code-safety
    codeSafetyExtension(mockPi as any);

    // Verifikasi modul ttsr gagal dicatat
    assert.ok(
      warnings.some((w) => w.includes("modul ttsr gagal didaftarkan")),
      "Peringatan kegagalan ttsr harus dicatat",
    );

    // Verifikasi modul-modul lain tetap terdaftar meskipun TTSR melempar error
    // 1. hash-edit mendaftarkan tool hash_edit
    assert.ok(
      mockPi.tools.includes("hash_edit"),
      "Tool hash_edit harus tetap terdaftar",
    );

    // 2. conflict-resolver mendaftarkan tool conflict_resolver
    assert.ok(
      mockPi.tools.includes("conflict_resolver"),
      "Tool conflict_resolver harus tetap terdaftar",
    );

    // 3. failure-recovery mendaftarkan hook tool_result
    assert.ok(
      mockPi.events.has("tool_result"),
      "Hook failure-recovery (tool_result) harus tetap terdaftar",
    );
  } finally {
    console.warn = originalWarn;
  }
});
