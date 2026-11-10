import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerConflictResolver } from "./modules/conflict-resolver/register.ts";
import { registerFailureRecovery } from "./modules/failure-recovery/register.ts";
import { registerHashEdit } from "./modules/hash-edit/register.ts";

// Tiap modul didaftarkan dalam try/catch sendiri. Kegagalan satu modul dicatat
// dan tidak menghentikan pendaftaran modul lain.
export default function codeSafetyExtension(pi: ExtensionAPI): void {
  try {
    registerFailureRecovery(pi);
  } catch (error) {
    console.warn("[code-safety] modul failure-recovery gagal didaftarkan:", error);
  }

  try {
    registerHashEdit(pi);
  } catch (error) {
    console.warn("[code-safety] modul hash-edit gagal didaftarkan:", error);
  }

  try {
    registerConflictResolver(pi);
  } catch (error) {
    console.warn("[code-safety] modul conflict-resolver gagal didaftarkan:", error);
  }
}
