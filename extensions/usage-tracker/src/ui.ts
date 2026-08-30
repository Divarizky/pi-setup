import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import type {
  ProviderId,
  ProviderUsage,
  UsageLimit,
  UsageTotals,
} from "./providers.ts";
import { providerName } from "./providers.ts";

export interface UsageTrackerViewData {
  readonly providers: readonly ProviderUsage[];
  readonly emptyMessage?: string;
  readonly session: UsageTotals;
  readonly generatedAt: Date;
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000)
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
}

function pad(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function line(
  theme: Theme,
  left: string,
  right: string,
  width: number,
): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap >= 1) return `${left}${" ".repeat(gap)}${right}`;
  return truncateToWidth(`${left} ${right}`, width);
}

function progressBar(theme: Theme, usedPercent: number, width: number): string {
  const barWidth = Math.max(1, Math.min(40, width));
  const boundedPercent = Math.max(0, Math.min(100, usedPercent));
  const usedWidth = Math.round((boundedPercent / 100) * barWidth);
  const rail =
    usedWidth <= 0
      ? "─".repeat(barWidth)
      : usedWidth >= barWidth
        ? "━".repeat(barWidth)
        : `${"━".repeat(usedWidth - 1)}╸${"─".repeat(barWidth - usedWidth)}`;
  return theme.fg("text", rail);
}

function wrapPlain(text: string, width: number): string[] {
  if (width <= 1) return [text.slice(0, 1)];
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    while (visibleWidth(current) > width) {
      const chunk = current.slice(0, Math.max(1, width));
      lines.push(chunk);
      current = current.slice(chunk.length);
    }
  }
  if (current || lines.length === 0) lines.push(current);
  return lines;
}

function resetInfo(limit: UsageLimit, now: Date): string {
  if (!limit.resetsAt) return "reset tidak diketahui";
  const remainingMs = limit.resetsAt.getTime() - now.getTime();
  if (remainingMs <= 0) return "reset segera";

  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const relative =
    days > 0
      ? `${days} hari ${hours} jam`
      : hours > 0
        ? `${hours} jam ${minutes} menit`
        : `${minutes} menit`;
  const absolute = limit.resetsAt.toLocaleString("id-ID", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const state = limit.usedPercent >= 100 ? "habis · " : "";
  return `${state}reset ${absolute} (${relative} lagi)`;
}

type QuotaLineLayout = {
  readonly labelWidth: number;
  readonly barWidth: number;
  readonly leftSpace: number;
  readonly rightSpace: number;
  readonly rightWidth: number;
};

function limitLines(
  theme: Theme,
  limit: UsageLimit,
  width: number,
  now: Date,
  layout: QuotaLineLayout,
): string[] {
  const used = `${limit.usedPercent.toFixed(0)}%`;
  const rightText = `${used} terpakai`;
  const right = pad(
    theme.fg(limit.usedPercent >= 90 ? "warning" : "text", rightText),
    layout.rightWidth,
  );
  const label = pad(theme.fg("muted", limit.label), layout.labelWidth);
  const bar = progressBar(theme, limit.usedPercent, layout.barWidth);
  const row = `${label}${" ".repeat(layout.leftSpace)}${bar}${" ".repeat(layout.rightSpace)}${right}`;
  return [
    truncateToWidth(row, width),
    theme.fg(
      "dim",
      `${" ".repeat(layout.labelWidth + layout.leftSpace)}${resetInfo(limit, now)}`,
    ),
  ];
}

function quotaLineLayout(
  limits: readonly UsageLimit[],
  width: number,
): QuotaLineLayout {
  const rightWidth = Math.max(
    1,
    ...limits.map((limit) =>
      visibleWidth(`${limit.usedPercent.toFixed(0)}% terpakai`),
    ),
  );
  const longestLabel = Math.max(
    14,
    ...limits.map((limit) => visibleWidth(limit.label)),
  );
  const labelWidth = Math.max(
    1,
    Math.min(longestLabel, width - rightWidth - 7),
  );
  const available = Math.max(1, width - labelWidth - rightWidth);
  const barWidth = Math.max(1, Math.min(40, available - 2));
  const remainingSpace = Math.max(0, available - barWidth);
  const leftSpace = Math.max(1, Math.floor(remainingSpace / 2));
  const rightSpace = Math.max(1, remainingSpace - leftSpace);
  return { labelWidth, barWidth, leftSpace, rightSpace, rightWidth };
}

function providerStatus(usage: ProviderUsage): {
  label: string;
  color: "success" | "accent" | "warning";
} {
  if (usage.source === "9Router lokal" && usage.status === "ok") {
    return { label: "Lokal", color: "accent" };
  }
  if (usage.status !== "ok" || !usage.limits?.length) {
    return { label: "N/A", color: "warning" };
  }

  const highestUsage = Math.max(
    ...usage.limits.map((limit) => limit.usedPercent),
  );
  if (highestUsage >= 100) return { label: "Habis", color: "warning" };
  if (highestUsage >= 90) return { label: "Kritis", color: "warning" };
  if (highestUsage >= 70) return { label: "Tinggi", color: "accent" };
  return { label: "Aman", color: "success" };
}

function providerRows(
  theme: Theme,
  usage: ProviderUsage,
  width: number,
  now: Date,
): string[] {
  const inner = Math.max(1, width);
  const providerStatusValue = providerStatus(usage);
  const status = theme.fg(
    providerStatusValue.color,
    `● ${providerStatusValue.label}`,
  );
  const titleText = usage.label ?? providerName(usage.provider);
  const titleWidth = Math.max(
    1,
    inner - visibleWidth(`● ${providerStatusValue.label}`) - 1,
  );
  const title = theme.fg(
    "accent",
    theme.bold(truncateToWidth(titleText, titleWidth)),
  );
  const rows = [line(theme, title, status, inner)];
  if (
    usage.source === "9Router quota API" ||
    usage.source === "9Router lokal"
  ) {
    rows.push(
      ...wrapPlain(`Sumber: ${usage.source}`, inner).map((value) =>
        theme.fg("dim", value),
      ),
    );
  }
  if (usage.limits?.length) {
    if (usage.quota) {
      rows.push(
        line(
          theme,
          theme.fg("muted", "Plan"),
          theme.fg("text", usage.quota),
          inner,
        ),
      );
    }
    // Codex dan 9Router memakai kolom yang sama. Dengan layout bersama ini,
    // nama model, bar, dan persentase tetap sejajar untuk setiap limit.
    const layout = quotaLineLayout(usage.limits, inner);
    rows.push(
      ...usage.limits.flatMap((limit) =>
        limitLines(theme, limit, inner, now, layout),
      ),
    );
    if (usage.message) rows.push(theme.fg("dim", usage.message));
  } else {
    rows.push(
      line(
        theme,
        theme.fg(
          "muted",
          usage.source?.startsWith("9Router")
            ? "Status koneksi"
            : "Quota / saldo",
        ),
        theme.fg(
          usage.quota || usage.balance ? "text" : "warning",
          usage.quota ?? usage.balance ?? "data tidak tersedia",
        ),
        inner,
      ),
      ...(usage.message ? [theme.fg("dim", usage.message)] : []),
    );
  }
  return rows.map((row) => pad(row, inner));
}

function sessionLine(
  theme: Theme,
  session: UsageTotals,
  width: number,
): string {
  const left = theme.fg("accent", theme.bold("Session Pi"));
  const right = theme.fg(
    "text",
    `${formatTokens(session.total)} tok · ${formatTokens(session.input)} in · ${formatTokens(session.output)} out`,
  );
  return line(theme, left, right, width);
}

export class UsageTrackerDashboard {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly data: UsageTrackerViewData;
  private readonly done: () => void;
  private scrollOffset = 0;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    data: UsageTrackerViewData,
    done: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.data = data;
    this.done = done;
  }

  handleInput(data: string): void {
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      this.keybindings.matches(data, "tui.select.confirm")
    ) {
      this.done();
      return;
    }

    // Banyak provider quota menghasilkan lebih banyak baris daripada tinggi
    // terminal. Jangan biarkan overlay terpotong; izinkan navigasi vertikal.
    const key = data.toLowerCase();
    const isUp = key === "up" || key === "arrowup" || key === "\u001b[a";
    const isDown = key === "down" || key === "arrowdown" || key === "\u001b[b";
    const isPageUp = key === "pageup";
    const isPageDown = key === "pagedown";
    if (isUp || isPageUp) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - (isPageUp ? this.pageSize() : 1),
      );
      this.tui.requestRender();
    } else if (isDown || isPageDown) {
      this.scrollOffset += isPageDown ? this.pageSize() : 1;
      this.tui.requestRender();
    }
  }

  private pageSize(): number {
    return Math.max(1, (this.tui.terminal.rows || 20) - 4);
  }

  render(width: number): string[] {
    const frameWidth = Math.max(4, width);
    const inner = Math.max(1, frameWidth - 4);
    const headerLeft = this.theme.fg(
      "accent",
      this.theme.bold("Usage Tracker"),
    );
    const headerRight = this.theme.fg("muted", "real-time");
    let content = [
      line(this.theme, headerLeft, headerRight, inner),
      this.theme.fg(
        "dim",
        `${this.data.generatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      ),
      "",
    ];

    if (this.data.providers.length === 0) {
      content.push(
        this.theme.fg(
          "warning",
          this.data.emptyMessage ?? "Tidak ada provider yang bisa ditampilkan.",
        ),
        this.theme.fg(
          "muted",
          "Gunakan /login untuk OAuth atau konfigurasi API Key.",
        ),
      );
    } else {
      for (const [index, provider] of this.data.providers.entries()) {
        content.push(
          ...providerRows(this.theme, provider, inner, this.data.generatedAt),
        );
        if (index < this.data.providers.length - 1) {
          content.push(this.theme.fg("border", "─".repeat(inner)));
        }
      }
    }

    content.push(
      this.theme.fg("border", "─".repeat(inner)),
      sessionLine(this.theme, this.data.session, inner),
      this.theme.fg("dim", "in/out session hanya berasal dari session Pi ini"),
      "",
      this.theme.fg("dim", "Enter/Esc tutup"),
    );

    // Isi tinggi terminal seperti dashboard /subagents dan /summary-model,
    // tetapi gunakan viewport untuk quota panjang agar overlay tidak terpotong.
    const terminalRows = this.tui.terminal.rows || content.length + 2;
    const visibleContentRows = Math.max(1, terminalRows - 2);
    const overflow = content.length > visibleContentRows;
    const maxOffset = Math.max(0, content.length - visibleContentRows);
    const offset = Math.min(this.scrollOffset, maxOffset);
    this.scrollOffset = offset;

    if (overflow) {
      const viewport = content.slice(offset, offset + visibleContentRows);
      if (offset > 0) viewport[0] = this.theme.fg("dim", "↑ Gulir ke atas");
      if (offset < maxOffset)
        viewport[viewport.length - 1] = this.theme.fg(
          "dim",
          "↓ Gulir ke bawah",
        );
      content = viewport;
    } else {
      while (content.length < visibleContentRows) content.push("");
    }

    const top = this.theme.fg("border", `╭${"─".repeat(frameWidth - 2)}╮`);
    const bottom = this.theme.fg("border", `╰${"─".repeat(frameWidth - 2)}╯`);
    const framed = content.map(
      (value) =>
        this.theme.fg("border", "│ ") +
        pad(value, inner) +
        this.theme.fg("border", " │"),
    );
    return [top, ...framed, bottom].map((value) =>
      truncateToWidth(value, frameWidth),
    );
  }

  invalidate(): void {
    this.tui.requestRender();
  }
}

export function providerOrder(
  providers: readonly ProviderUsage[],
): readonly ProviderId[] {
  return providers.map((provider) => provider.provider);
}
