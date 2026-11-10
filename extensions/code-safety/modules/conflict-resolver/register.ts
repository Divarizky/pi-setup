import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  parseConflictMarkers,
  applyConflictResolutions,
  type HunkResolution,
  type ConflictResolutionChoice,
} from "./core.ts";

const ConflictResolutionItemSchema = Type.Object({
  hunkId: Type.Integer({
    minimum: 1,
    description: "ID potongan konflik (1-indexed).",
  }),
  choice: Type.Union(
    [
      Type.Literal("ours"),
      Type.Literal("theirs"),
      Type.Literal("both"),
      Type.Literal("custom"),
    ],
    {
      description: "Pilihan resolusi: 'ours', 'theirs', 'both', atau 'custom'.",
    }
  ),
  customContent: Type.Optional(
    Type.String({
      description: "Konten pengganti khusus bila choice adalah 'custom'.",
    })
  ),
});

const ResolveConflictInputSchema = Type.Object({
  path: Type.String({
    description: "Jalur berkas yang sedang mengalami konflik merge.",
  }),
  action: Type.Union([Type.Literal("inspect"), Type.Literal("resolve")], {
    description: "'inspect' untuk melihat daftar potongan konflik, 'resolve' untuk menerapkan penyelesaian.",
  }),
  resolutions: Type.Optional(
    Type.Array(ConflictResolutionItemSchema, {
      description: "Daftar resolusi per hunk ID (wajib jika action adalah 'resolve').",
    })
  ),
});

type ResolveConflictInput = Static<typeof ResolveConflictInputSchema>;

export function registerConflictResolver(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "conflict_resolver",
    label: "Conflict Resolver",
    description:
      "Memeriksa dan menyelesaikan konflik merge Git secara terstruktur per blok (hunk) dengan opsi 'ours', 'theirs', 'both', atau 'custom'.",
    parameters: ResolveConflictInputSchema,
    execute: async (_toolCallId, params: ResolveConflictInput, _signal, _onUpdate, ctx) => {
      const targetPath = path.isAbsolute(params.path)
        ? params.path
        : path.resolve(ctx.cwd, params.path);

      let content: string;
      try {
        content = await fs.readFile(targetPath, "utf8");
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Gagal membaca berkas ${params.path}: ${err.message}`,
            },
          ],
          details: { error: err.message },
          isError: true,
        };
      }

      const parsed = parseConflictMarkers(content);

      if (params.action === "inspect") {
        if (!parsed.hasConflicts) {
          return {
            content: [
              {
                type: "text",
                text: `Berkas '${params.path}' bersih, tidak ditemukan penanda konflik merge Git.`,
              },
            ],
            details: { hasConflicts: false, hunksCount: 0 },
          };
        }

        const summary = parsed.hunks.map((h) => {
          return [
            `--- Hunk #${h.id} (baris ${h.startLine}-${h.endLine}) ---`,
            `<<< OURS (${h.ours.length} baris):`,
            ...h.ours.map((l) => `  ${l}`),
            h.base ? `||| BASE (${h.base.length} baris):\n${h.base.map((l) => `  ${l}`).join("\n")}` : "",
            `>>> THEIRS (${h.theirs.length} baris):`,
            ...h.theirs.map((l) => `  ${l}`),
          ]
            .filter(Boolean)
            .join("\n");
        });

        return {
          content: [
            {
              type: "text",
              text: `Ditemukan ${parsed.hunks.length} blok konflik pada '${params.path}':\n\n${summary.join("\n\n")}`,
            },
          ],
          details: {
            hasConflicts: true,
            hunksCount: parsed.hunks.length,
            hunks: parsed.hunks,
          },
        };
      }

      // Action: resolve
      const resolutions = (params.resolutions || []) as HunkResolution[];
      if (resolutions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Parameter 'resolutions' wajib diisi untuk action 'resolve'.`,
            },
          ],
          details: { error: "missing_resolutions" },
          isError: true,
        };
      }

      const outcome = applyConflictResolutions(content, resolutions);

      try {
        await fs.writeFile(targetPath, outcome.resolvedContent, "utf8");
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Gagal menyimpan resolusi ke berkas '${params.path}': ${err.message}`,
            },
          ],
          details: { error: err.message },
          isError: true,
        };
      }

      const statusMsg = outcome.remainingConflicts === 0
        ? `Seluruh konflik pada '${params.path}' berhasil diselesaikan.`
        : `Resolusi diterapkan. Masih tersisa ${outcome.remainingConflicts} blok konflik yang belum terselesaikan.`;

      return {
        content: [{ type: "text", text: statusMsg }],
        details: {
          success: outcome.success,
          remainingConflicts: outcome.remainingConflicts,
        },
      };
    },
  });
}
