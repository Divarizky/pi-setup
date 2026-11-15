import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerConflictResolver } from "./modules/conflict-resolver/register.ts";
import { registerFailureRecovery } from "./modules/failure-recovery/register.ts";
import { registerHashEdit } from "./modules/hash-edit/register.ts";
import { registerTtsr } from "./modules/ttsr/register.ts";

// Tiap modul didaftarkan dalam try/catch sendiri. Kegagalan satu modul dicatat
// dan tidak menghentikan pendaftaran modul lain.
export default function codeProtectionExtension(pi: ExtensionAPI): void {
  try {
    registerFailureRecovery(pi);
  } catch (error) {
    console.warn("[code-protection] modul failure-recovery gagal didaftarkan:", error);
  }

  try {
    registerHashEdit(pi);
  } catch (error) {
    console.warn("[code-protection] modul hash-edit gagal didaftarkan:", error);
  }

  try {
    registerConflictResolver(pi);
  } catch (error) {
    console.warn("[code-protection] modul conflict-resolver gagal didaftarkan:", error);
  }

  try {
    registerTtsr(pi);
  } catch (error) {
    console.warn("[code-protection] modul ttsr gagal didaftarkan:", error);
  }

}

