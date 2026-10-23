import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  hyperlink,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  emptyGitInfoState,
  emptyModelInfoState,
  GIT_INFO_CHANNEL,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
  isGitInfoState,
  isModelInfoState,
} from "../dashboard-state/dashboard-state.ts";

/** Protokol footer-chain: ui-customization publish factory footer custom agar extension lain (mis. fleet subagents) bisa membungkusnya, bukan menimpanya. */
export const CUSTOM_FOOTER_CHAIN_KEY = "__piCustomFooterFactory";
export const CUSTOM_FOOTER_CHAIN_EVENT = "ui-customization:footer";

import type { Model } from "@earendil-works/pi-ai";
import { installWorkingMessage } from "./src/working.ts";
import { installThinkingDisplay } from "./src/thinking.ts";
import { installToolRendering } from "./src/tool-render.ts";
import { bindUi } from "./src/ui-binding.ts";

type Rgb = [number, number, number];
interface RenderableNode {
  children?: RenderableNode[];
  invalidate(): void;
  render(width: number): string[];
}

interface DashboardTui extends RenderableNode {
  requestRender(force?: boolean): void;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const PALETTE: Rgb[] = [
  [22, 83, 189],
  [48, 129, 247],
  [93, 171, 255],
  [151, 205, 255],
  [93, 171, 255],
  [48, 129, 247],
];

function ansiToRgb(ansi: string): Rgb | undefined {
  const truecolor = ansi.match(/^\x1b\[38;2;(\d+);(\d+);(\d+)m$/);
  if (truecolor) {
    return [Number(truecolor[1]), Number(truecolor[2]), Number(truecolor[3])];
  }
  const indexed = ansi.match(/^\x1b\[38;5;(\d+)m$/);
  if (!indexed) return undefined;
  const index = Number(indexed[1]);
  if (index < 16) return undefined; // basic ANSI, terminal-dependent
  if (index < 232) {
    const value = index - 16;
    const cube = [0, 95, 135, 175, 215, 255];
    return [
      cube[Math.floor(value / 36)],
      cube[Math.floor(value / 6) % 6],
      cube[value % 6],
    ] satisfies Rgb;
  }
  const gray = 8 + (index - 232) * 10;
  return [gray, gray, gray];
}

// Gradient ramp diambil dari token theme aktif, biar ngikut tema.
const GRADIENT_TOKENS: ThemeColor[] = [
  "accent",
  "mdHeading",
  "mdLink",
  "thinkingMedium",
  "thinkingLow",
  "toolTitle",
];

function paletteFromTheme(theme: Theme): Rgb[] {
  const palette: Rgb[] = [];
  for (const token of GRADIENT_TOKENS) {
    const rgb = ansiToRgb(theme.getFgAnsi(token));
    if (rgb) palette.push(rgb);
  }
  return palette.length >= 2 ? palette : PALETTE;
}
const TITLE_LINES = [
  "  ██████╗  ██╗ ",
  "  ██╔══██╗ ██║ ",
  "  ██████╔╝ ██║ ",
  "  ██╔═══╝  ██║ ",
  "  ██║      ██║ ",
  "  ╚═╝      ╚═╝ ",
];
const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";
const MCP_CONNECTED: Rgb = [34, 197, 94];
const MCP_DIM: Rgb = [100, 116, 139];

interface McpServerState {
  name: string;
  status: string;
  toolCount: number;
  disabled: boolean;
}

interface McpSnapshot {
  servers: McpServerState[];
}

function loadInitialMcpSnapshot(): McpSnapshot | undefined {
  try {
    const agentDir = fileURLToPath(new URL("../..", import.meta.url));
    const config = JSON.parse(
      readFileSync(join(agentDir, "mcp.json"), "utf8"),
    ) as { mcpServers?: Record<string, { disabled?: boolean }> };
    const servers = Object.entries(config.mcpServers ?? {})
      .filter(([, definition]) => !definition?.disabled)
      .map(([name]) => ({
        name,
        status: "not-connected",
        toolCount: 0,
        disabled: false,
      }));
    return servers.length > 0 ? { servers } : undefined;
  } catch {
    return undefined;
  }
}

function usageBar(percent: number, theme: Theme, width = 10) {
  const filled = Math.min(
    width,
    Math.max(0, Math.round((percent / 100) * width)),
  );
  const color: ThemeColor =
    percent >= 90 ? "error" : percent >= 70 ? "warning" : "text";
  const filledStr = theme.fg(color, "█".repeat(filled));
  const emptyStr = theme.fg("dim", "░".repeat(width - filled));
  return `${filledStr}${emptyStr}${RESET}`;
}

function renderMcpLine(snapshot: McpSnapshot | undefined, width: number) {
  if (!snapshot) return "";
  const enabled = snapshot.servers.filter((server) => !server.disabled);
  if (enabled.length === 0) return "";
  const connected = enabled.filter(
    (server) => server.status === "connected",
  ).length;
  return truncateToWidth(
    foreground(
      connected > 0 ? MCP_CONNECTED : MCP_DIM,
      `MCP: ${connected}/${enabled.length}`,
    ),
    width,
  );
}

const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

function sanitizeTerminalLabel(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function mix(a: number, b: number, amount: number) {
  return Math.round(a + (b - a) * amount);
}

function sampleGradient(position: number, palette: Rgb[]) {
  const wrapped = ((position % 1) + 1) % 1;
  const scaled = wrapped * palette.length;
  const index = Math.floor(scaled);
  const nextIndex = (index + 1) % palette.length;
  const amount = scaled - index;
  const start = palette[index]!;
  const end = palette[nextIndex]!;

  return [
    mix(start[0], end[0], amount),
    mix(start[1], end[1], amount),
    mix(start[2], end[2], amount),
  ] satisfies Rgb;
}

function foreground([red, green, blue]: Rgb, text: string) {
  return `\x1b[38;2;${red};${green};${blue}m${text}${RESET}`;
}

function gradientText(text: string, phase: number, palette: Rgb[] = PALETTE) {
  const characters = [...text];
  const span = Math.max(characters.length - 1, 1);

  return characters
    .map((character, index) =>
      character === " "
        ? character
        : foreground(sampleGradient(index / span + phase, palette), character),
    )
    .join("");
}

function formatTokens(tokens: number) {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}K`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function sessionUsage(ctx: ExtensionContext) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let cacheHitRate: number | undefined;

  for (const entry of ctx.sessionManager.getEntries()) {
    const record = entry as {
      message?: { role?: string; usage?: any };
      usage?: any;
    };
    const usage = record.message?.usage ?? record.usage;
    if (!usage) continue;

    totals.input += typeof usage.input === "number" ? usage.input : 0;
    totals.output += typeof usage.output === "number" ? usage.output : 0;
    totals.cacheRead +=
      typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
    totals.cacheWrite +=
      typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
    totals.cost += typeof usage.cost?.total === "number" ? usage.cost.total : 0;

    if (record.message?.role === "assistant") {
      const promptTokens =
        (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      if (promptTokens > 0) {
        cacheHitRate = ((usage.cacheRead ?? 0) / promptTokens) * 100;
      }
    }
  }

  return { totals, cacheHitRate };
}

function formatCost(cost: number) {
  return `$${cost.toFixed(3)}`;
}

function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  const display = cwd.startsWith(`${home}/`) ? `~/${relative(home, cwd)}` : cwd;
  return sanitizeTerminalLabel(display);
}

function center(text: string, width: number) {
  const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return truncateToWidth(`${" ".repeat(padding)}${text}`, width);
}

function columns(left: string, right: string, width: number) {
  if (!right) return truncateToWidth(left, width);

  const naturalGap = width - visibleWidth(left) - visibleWidth(right);
  if (naturalGap >= 1) return `${left}${" ".repeat(naturalGap)}${right}`;

  const leftWidth = Math.max(1, Math.floor(width * 0.45));
  const rightWidth = Math.max(1, width - leftWidth - 1);
  const fittedLeft = truncateToWidth(left, leftWidth);
  const fittedRight = truncateToWidth(right, rightWidth);
  const gap = Math.max(
    1,
    width - visibleWidth(fittedLeft) - visibleWidth(fittedRight),
  );
  return truncateToWidth(
    `${fittedLeft}${" ".repeat(gap)}${fittedRight}`,
    width,
  );
}

export default function uiCustomization(pi: ExtensionAPI) {
  installWorkingMessage(pi);
  installThinkingDisplay(pi);
  installToolRendering(pi);
  let title = "pi";
  let modelInfo = emptyModelInfoState();
  let gitInfo = emptyGitInfoState();
  let requestRender: (() => void) | undefined;
  let activeTui: DashboardTui | undefined;
  let mcpSnapshot = loadInitialMcpSnapshot();

  const stopModelListener = pi.events.on(MODEL_INFO_CHANNEL, (value) => {
    if (!isModelInfoState(value)) return;
    modelInfo = value;
    requestRender?.();
  });

  const stopGitListener = pi.events.on(GIT_INFO_CHANNEL, (value) => {
    if (!isGitInfoState(value)) return;
    gitInfo = value;
    requestRender?.();
  });

  // MCP server status, published by pi-mcp-adapter.
  pi.events.on(MCP_STATUS_EVENT, (value) => {
    if (typeof value !== "object" || value === null) return;
    const data = value as { servers?: unknown[] };
    if (!Array.isArray(data.servers)) return;
    const servers = data.servers
      .filter(
        (server): server is Record<string, unknown> =>
          typeof server === "object" && server !== null,
      )
      .map((server) => ({
        name: typeof server.name === "string" ? server.name : "?",
        status:
          typeof server.status === "string" ? server.status : "not-connected",
        toolCount: typeof server.toolCount === "number" ? server.toolCount : 0,
        disabled: server.disabled === true,
      }));
    mcpSnapshot = servers.length > 0 ? { servers } : undefined;
    requestRender?.();
  });

  // Handle model selection changes
  pi.on("model_select", (_event, ctx) => {
    const model = _event.model;
    if (!model) return;
    updateModelInfo(ctx, model, modelInfo.thinking);
  });

  // Handle thinking level changes
  pi.on("thinking_level_select", (_event, ctx) => {
    updateModelInfo(ctx, ctx.model, _event.level);
  });

  function updateModelInfo(
    ctx: ExtensionContext,
    model: Model<any> | undefined,
    thinking: string,
  ) {
    if (!model) return;
    const info = {
      provider: model.provider,
      modelId: model.id,
      modelName: model.name,
      thinking,
      contextTokens: null,
      contextWindow: model.contextWindow,
      contextPercent: null,
      cost: 0,
      tokensPerSecond: null,
      generating: false,
    };
    pi.events.emit(MODEL_INFO_CHANNEL, info);
  }

  function install(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((tui, theme) => {
      activeTui = tui;
      bindUi({
        mode: () => (tui as { mode?: unknown }).mode,
        theme,
        requestRender: () => tui.requestRender(),
      });
      requestRender = () => tui.requestRender();

      return {
        render(width: number) {
          const palette = paletteFromTheme(theme);
          const art = TITLE_LINES.map((line, row) =>
            center(gradientText(line, row * 0.045, palette), width),
          );
          const subtitle = center(
            `${BOLD}${gradientText(title, 0.18, palette)}${RESET}`,
            width,
          );
          return ["", ...art, subtitle, ""];
        },
        invalidate() {},
      };
    });

    const footerFactory = createFooterFactory(ctx);
    ctx.ui.setFooter(footerFactory);
    publishFooterFactory(footerFactory);

    function createFooterFactory(ctx: ExtensionContext) {
      return (
        tui: DashboardTui,
        theme: Theme,
        footerData: ReadonlyFooterDataProvider,
      ) => {
        requestRender = () => tui.requestRender();

        return {
          invalidate() {},
          render(width: number) {
            return renderCustomFooter(ctx, footerData, width, theme);
          },
        };
      };
    }

    function renderCustomFooter(
      ctx: ExtensionContext,
      footerData: ReadonlyFooterDataProvider,
      width: number,
      theme: Theme,
    ): string[] {
      const sessionName = ctx.sessionManager.getSessionName?.();
      const directoryLabel = sessionName
        ? `${formatDirectory(ctx.cwd)} • ${sessionName}`
        : formatDirectory(ctx.cwd);
      const directory = theme.fg("text", directoryLabel);
      const fileLabel = gitInfo.changedFiles === 1 ? "file" : "files";
      let git = gitInfo.branch
        ? `${gitInfo.branch} · ${gitInfo.changedFiles} ${fileLabel}`
        : "";

      if (gitInfo.pullRequest) {
        const prLabel = `PR #${gitInfo.pullRequest.number}`;
        const linkedPr = getCapabilities().hyperlinks
          ? hyperlink(prLabel, gitInfo.pullRequest.url)
          : prLabel;
        git += ` · ${linkedPr}`;
      }

      const contextUsage = ctx.getContextUsage();
      const percent = contextUsage?.percent ?? null;
      const contextWindow = contextUsage?.contextWindow ?? 0;
      const contextDisplay =
        percent === null
          ? `?/${formatTokens(contextWindow)}`
          : `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
      const { totals, cacheHitRate } = sessionUsage(ctx);
      const cacheDisplay =
        totals.cacheRead > 0 && cacheHitRate !== undefined
          ? `${formatTokens(totals.cacheRead)}/${cacheHitRate.toFixed(1)}%`
          : "—/—%";
      const stats = `${contextDisplay} · ${formatCost(totals.cost)} · ${cacheDisplay}`;
      const model = modelInfo.provider
        ? `${modelInfo.provider}/${modelInfo.modelId} · ${modelInfo.thinking}`
        : modelInfo.modelId;
      const mcp = renderMcpLine(mcpSnapshot, width).replace(
        /\x1b\[[0-9;]*m/g,
        "",
      );
      const external = mcp || "MCP: 0/0";

      const lines = [
        columns(directory, theme.fg("muted", git), width),
        columns(theme.fg("muted", stats), theme.fg("muted", model), width),
        truncateToWidth(
          theme.fg("dim", external),
          width,
          theme.fg("dim", "..."),
        ),
      ];

      // Keep dynamic extension statuses such as subagent activity and summarizing.
      const statuses = footerData.getExtensionStatuses();
      for (const [, text] of statuses) {
        for (const statusLine of text.split("\n")) {
          lines.push(
            truncateToWidth(statusLine, width, theme.fg("dim", "...")),
          );
        }
      }

      return lines;
    }

    function publishFooterFactory(factory: unknown) {
      (globalThis as any)[CUSTOM_FOOTER_CHAIN_KEY] = factory;
      pi.events.emit(CUSTOM_FOOTER_CHAIN_EVENT, { factory });
    }

    ctx.ui.setTitle(`pi · ${title}`);
    pi.events.emit(REFRESH_CHANNEL, undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    title = formatDirectory(ctx.cwd);
    modelInfo = emptyModelInfoState();
    gitInfo = emptyGitInfoState();
    if (ctx.model) {
      updateModelInfo(ctx, ctx.model, ctx.thinkingLevel ?? "off");
    }
    install(ctx);
  });

  pi.on("session_info_changed", (_event) => {
    requestRender?.();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopModelListener();
    stopGitListener();
    activeTui = undefined;
    requestRender = undefined;
    bindUi(undefined);
    if (ctx.mode === "tui") {
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
    }
  });
}
