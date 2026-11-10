import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  applyHashEditToText,
  computeLineHash,
  type LineAnchor,
} from "./core.ts";

const LineAnchorSchema = Type.Object(
  {
    line: Type.Integer({
      minimum: 1,
      description: "Nomor baris target (1-indexed).",
    }),
    hash: Type.String({
      minLength: 6,
      maxLength: 6,
      description: "6 karakter hex hasil hash SHA-256 dari baris yang dinormalisasi.",
    }),
  },
  { description: "Anchor penanda posisi baris dan hash kontennya." }
);

const HashEditInputSchema = Type.Object({
  path: Type.String({
    description: "Jalur berkas relatif terhadap direktori kerja proyek.",
  }),
  startAnchor: LineAnchorSchema,
  endAnchor: LineAnchorSchema,
  newContent: Type.String({
    description: "Teks baru pengganti blok dari startAnchor hingga endAnchor.",
  }),
});

type HashEditInput = Static<typeof HashEditInputSchema>;

export default function registerHashEdit(pi: ExtensionAPI) {
  pi.registerTool({
    name: "hash_edit",
    label: "Hash Edit",
    description:
      "Memodifikasi blok baris berkas menggunakan verifikasi hash anchor (line + sha256:6hex) ala Oh My Pi. Tahan terhadap pergeseran baris (delta drift ±15 baris) dan variasi spasi/newline.",
    parameters: HashEditInputSchema,
    execute: async (_toolCallId, params: HashEditInput, _signal, _onUpdate, ctx) => {
      const targetPath = path.isAbsolute(params.path)
        ? params.path
        : path.resolve(ctx.cwd, params.path);

      let originalContent: string;
      try {
        originalContent = await fs.readFile(targetPath, "utf8");
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

      const result = applyHashEditToText(
        originalContent,
        params.startAnchor,
        params.endAnchor,
        params.newContent
      );

      if (!result.success) {
        const errorDetails = [
          `Gagal menerapkan hash_edit pada '${params.path}':`,
          result.reason,
          "",
          result.contextSnippet
            ? `Cuplikan baris aktual di sekitar target:\n${result.contextSnippet}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");

        return {
          content: [{ type: "text", text: errorDetails }],
          details: { error: result.reason },
          isError: true,
        };
      }

      try {
        await fs.writeFile(targetPath, result.resultContent, "utf8");
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Gagal menulis perubahan ke berkas '${params.path}': ${err.message}`,
            },
          ],
          details: { error: err.message },
          isError: true,
        };
      }

      const driftNote =
        result.drift !== 0
          ? ` (terdeteksi pergeseran baris sejauh ${result.drift > 0 ? "+" : ""}${result.drift} baris)`
          : "";

      return {
        content: [
          {
            type: "text",
            text: `Berhasil mengubah '${params.path}' pada rentang baris ${result.appliedRange.startLine}-${result.appliedRange.endLine}${driftNote}.`,
          },
        ],
        details: {
          appliedRange: result.appliedRange,
          drift: result.drift,
        },
      };
    },
  });
}
