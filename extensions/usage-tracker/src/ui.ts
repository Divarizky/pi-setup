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

function formatMoney(value: number | undefined): string {
  return value === undefined ? "—" : `$${value.toFixed(2)}`;
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
  const barWidth = Math.max(10, Math.min(40, width));
  const usedWidth = Math.round((usedPercent / 100) * barWidth);
  const used = "■".repeat(usedWidth);
  const remaining = "-".repeat(barWidth - usedWidth);
  return theme.fg("text", `[${used}${remaining}]`);
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

function limitLines(
  theme: Theme,
  limit: UsageLimit,
  width: number,
  now: Date,
): string[] {
  const used = `${limit.usedPercent.toFixed(0)}%`;
  const bar = progressBar(theme, limit.usedPercent, Math.max(10, width - 32));
  const left = theme.fg("muted", limit.label.padEnd(14)) + bar;
  const right = theme.fg(
    limit.usedPercent >= 90 ? "warning" : "text",
    `${used} terpakai`,
  );
  return [
    line(theme, left, right, width),
    theme.fg("dim", `              ${resetInfo(limit, now)}`),
  ];
}

function periodLine(
  theme: Theme,
  label: string,
  usage: ProviderUsage["today"],
): string {
  const title = label === "today" ? "Hari ini" : "Billing cycle";
  if (!usage.totals) {
    return `${theme.fg("muted", title.padEnd(14))}${theme.fg("warning", usage.message ?? "data tidak tersedia")}`;
  }
  const totals = usage.totals;
  return `${theme.fg("muted", title.padEnd(14))}${formatTokens(totals.total)} tok · ${formatTokens(totals.input)} in · ${formatTokens(totals.output)} out · ${formatMoney(totals.cost)}`;
}

function providerStatus(usage: ProviderUsage): {
  label: string;
  color: "success" | "accent" | "warning";
} {
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
  const title = theme.fg("accent", theme.bold(providerName(usage.provider)));
  const rows = [line(theme, title, status, inner)];
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
    rows.push(
      ...usage.limits.flatMap((limit) => limitLines(theme, limit, inner, now)),
    );
  } else {
    rows.push(
      line(
        theme,
        theme.fg("muted", "Quota / saldo"),
        theme.fg(
          usage.quota || usage.balance ? "text" : "warning",
          usage.quota ?? usage.balance ?? "data tidak tersedia",
        ),
        inner,
      ),
      periodLine(theme, "today", usage.today),
      periodLine(theme, "billing", usage.billing),
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
    }
  }

  render(width: number): string[] {
    const frameWidth = Math.max(4, width);
    const inner = Math.max(1, frameWidth - 4);
    const headerLeft = this.theme.fg(
      "accent",
      this.theme.bold("Usage Tracker"),
    );
    const headerRight = this.theme.fg("muted", "real-time");
    const content = [
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
    // bukan hanya tinggi konten aktual.
    const terminalRows = this.tui.terminal.rows || content.length + 2;
    const targetContentRows = Math.max(content.length, terminalRows - 2);
    while (content.length < targetContentRows) content.push("");

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
