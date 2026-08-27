import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { UsageTotals } from "./src/providers.ts";
import { fetchProviderUsage, type ProviderId } from "./src/providers.ts";
import { UsageTrackerDashboard, type UsageTrackerViewData } from "./src/ui.ts";

const REQUEST_TIMEOUT_MS = 20_000;

function sessionUsage(ctx: ExtensionContext): UsageTotals {
  const totals = { input: 0, output: 0, cached: 0, total: 0, cost: 0 };
  let hasCost = false;

  for (const entry of ctx.sessionManager.getEntries()) {
    const record = entry as {
      message?: { usage?: Record<string, unknown> };
      usage?: Record<string, unknown>;
    };
    const usage = record.message?.usage ?? record.usage;
    if (!usage) continue;

    const input = typeof usage.input === "number" ? usage.input : 0;
    const output = typeof usage.output === "number" ? usage.output : 0;
    const cached =
      (typeof usage.cacheRead === "number" ? usage.cacheRead : 0) +
      (typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0);
    const costRecord = usage.cost as { total?: unknown } | undefined;
    const cost = typeof costRecord?.total === "number" ? costRecord.total : 0;

    totals.input += input;
    totals.output += output;
    totals.cached += cached;
    totals.total += input + output + cached;
    totals.cost += cost;
    hasCost ||= typeof costRecord?.total === "number";
  }

  return hasCost ? totals : { ...totals, cost: undefined };
}

function discoverProviderIds(ctx: ExtensionContext): readonly ProviderId[] {
  const ids = new Set<string>(
    ctx.modelRegistry.getAll().map((model) => model.provider),
  );
  for (const provider of ctx.modelRegistry.getRegisteredProviderIds())
    ids.add(provider);
  return [...ids];
}

async function loadUsage(ctx: ExtensionContext): Promise<UsageTrackerViewData> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const connected = await Promise.all(
      discoverProviderIds(ctx).map(async (provider) => {
        try {
          return {
            provider,
            auth: await ctx.modelRegistry.getProviderAuth(provider),
          };
        } catch {
          return { provider, auth: undefined };
        }
      }),
    );
    const configured = connected.filter((entry) => entry.auth !== undefined);
    const supported = configured.filter(
      ({ provider }) => provider === "openai-codex",
    );
    const fetched = await Promise.all(
      supported.map(({ provider, auth }) =>
        fetchProviderUsage(provider, () => Promise.resolve(auth), {
          signal: controller.signal,
        }),
      ),
    );
    // Hanya provider dengan session usage/rate-limit yang masuk dashboard.
    // API key biasa tidak memiliki endpoint quota subscription yang setara.
    const providers = fetched.filter(
      (provider) => provider.limits && provider.limits.length > 0,
    );
    const emptyMessage =
      configured.length === 0
        ? "Belum ada provider terhubung. Jalankan /login untuk OAuth."
        : providers.length === 0
          ? "Provider terhubung tidak menyediakan session usage yang bisa dipantau."
          : undefined;
    return {
      providers,
      emptyMessage,
      session: sessionUsage(ctx),
      generatedAt: new Date(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export default function usageTrackerExtension(pi: ExtensionAPI) {
  pi.registerCommand("usage-tracker", {
    description: "Show provider quota and session usage",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify("/usage-tracker hanya tersedia di TUI.", "error");
        return;
      }

      const loadingWidgetKey = "usage-tracker-loading";
      ctx.ui.setWidget(
        loadingWidgetKey,
        (_tui, theme) =>
          new Text(
            theme.fg("dim", "Mengambil usage provider secara real-time…"),
            1,
            0,
          ),
        { placement: "aboveEditor" },
      );
      let data: UsageTrackerViewData;
      try {
        data = await loadUsage(ctx);
      } catch {
        ctx.ui.notify(
          "Usage provider gagal diambil; menampilkan data lokal.",
          "warning",
        );
        data = {
          providers: [],
          emptyMessage:
            "Usage provider gagal diambil. Pastikan sudah login OAuth Codex.",
          session: sessionUsage(ctx),
          generatedAt: new Date(),
        };
      }

      if (data.providers.length === 0 && data.emptyMessage) {
        ctx.ui.notify(data.emptyMessage, "warning");
      }

      await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) =>
          new UsageTrackerDashboard(tui, theme, keybindings, data, () =>
            done(),
          ),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "100%",
            maxHeight: "100%",
          },
          onHandle: () => ctx.ui.setWidget(loadingWidgetKey, undefined),
        },
      );
    },
  });
}
