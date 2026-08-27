// @orca-managed-pi-extension
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const BRAILLE_FRAMES = [
  "\u280b",
  "\u2819",
  "\u2839",
  "\u2838",
  "\u283c",
  "\u2834",
  "\u2826",
  "\u2827",
  "\u2807",
  "\u280f",
];

function getBaseTitle(pi: ExtensionAPI): string {
  const cwd =
    process.cwd().split(/[\\/]/).filter(Boolean).at(-1) || process.cwd();
  const session = pi.getSessionName();
  return session ? `\u03c0 - ${session} - ${cwd}` : `\u03c0 - ${cwd}`;
}

export default function (pi: ExtensionAPI): void {
  if (!process.env.ORCA_PANE_KEY) return;
  let timer: ReturnType<typeof setInterval> | null = null;
  let frameIndex = 0;

  function stopAnimation(ctx: ExtensionContext): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    frameIndex = 0;
    ctx.ui.setTitle(getBaseTitle(pi));
  }

  function startAnimation(ctx: ExtensionContext): void {
    stopAnimation(ctx);
    timer = setInterval(() => {
      const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
      const cwd =
        process.cwd().split(/[\\/]/).filter(Boolean).at(-1) || process.cwd();
      const session = pi.getSessionName();
      const title = session
        ? `${frame} \u03c0 - ${session} - ${cwd}`
        : `${frame} \u03c0 - ${cwd}`;
      ctx.ui.setTitle(title);
      frameIndex++;
    }, 80);
  }

  pi.on("agent_start", async (_event, ctx) => {
    startAnimation(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    stopAnimation(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopAnimation(ctx);
  });
}
