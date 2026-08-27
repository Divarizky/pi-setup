// @orca-managed-pi-extension
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    if (!process.env.ORCA_PANE_KEY) return;
    if (event.reason !== "startup") return;
    const prefill = process.env.ORCA_PI_PREFILL;
    if (!prefill) return;
    delete process.env.ORCA_PI_PREFILL;
    try {
      ctx.ui.setEditorText(prefill);
    } catch {}
  });
}
