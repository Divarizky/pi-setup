import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { ProviderUsage, UsageTotals } from "./src/providers.ts";
import { fetchProviderUsage, type ProviderId } from "./src/providers.ts";
import { UsageTrackerDashboard, type UsageTrackerViewData } from "./src/ui.ts";
import {
  fetchNineRouterQuotas,
  readNineRouterUsage,
} from "./src/ninerouter.ts";
import {
  findQuotaForModel,
  parseStandardQuotaHeaders,
  primaryQuotaLimit,
  renderQuotaBar,
  type MatchedQuota,
  type QuotaModelRef,
} from "./src/quota-bar.ts";

const REQUEST_TIMEOUT_MS = 20_000;
const QUOTA_WIDGET_KEY = "usage-tracker-quota-bar";
const QUOTA_REFRESH_INTERVAL_MS = 45_000;
const QUOTA_RENDER_INTERVAL_MS = 1_000;
type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;

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

    // 9Router menyimpan usage lokal semua request yang melewati proxy. Data ini
    // bukan sisa kuota upstream: provider upstream biasanya tidak menyediakan
    // endpoint quota melalui API kompatibel OpenAI.
    const routerEntry = configured.some(
      ({ provider }) => provider === "9router",
    );
    let routerProviders: ProviderUsage[] = [];
    if (routerEntry) {
      let localProviders: ProviderUsage[] = [];
      try {
        localProviders = [...readNineRouterUsage()];
      } catch {
        // Quota API tetap dicoba; DB dapat gagal dibaca secara terpisah.
      }

      const liveQuotaProviders = await fetchNineRouterQuotas(localProviders, {
        signal: controller.signal,
      });
      // Hanya provider dengan quota bar resmi yang ditampilkan
      routerProviders = liveQuotaProviders.filter(
        (provider) => provider.limits && provider.limits.length > 0,
      );
    }

    // Hanya provider dengan session usage/rate-limit yang masuk dashboard,
    // ditambah provider yang usage-nya dibaca dari database lokal 9Router.
    // API key biasa tidak memiliki endpoint quota subscription yang setara.
    const providers = [
      ...fetched.filter(
        (provider) => provider.limits && provider.limits.length > 0,
      ),
      ...routerProviders,
    ];
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

async function fetchActiveQuota(
  ctx: ExtensionContext,
  model: QuotaModelRef,
  signal: AbortSignal,
): Promise<MatchedQuota | undefined> {
  if (model.provider === "openai-codex") {
    const usage = await fetchProviderUsage(
      model.provider,
      () => ctx.modelRegistry.getProviderAuth(model.provider),
      { signal },
    );
    if (!usage.limits?.length) return undefined;
    const limit = primaryQuotaLimit(usage);
    return limit ? { usage, limit } : undefined;
  }

  if (model.provider !== "9router") return undefined;

  let localProviders: ProviderUsage[] = [];
  try {
    localProviders = [...readNineRouterUsage()];
  } catch {
    // Live quota tetap dapat dipakai tanpa agregat usage lokal.
  }

  const liveProviders = await fetchNineRouterQuotas(localProviders, { signal });
  return findQuotaForModel(model, liveProviders);
}

type QuotaBarRuntime = {
  select(model: QuotaModelRef, ctx: ExtensionContext): void;
  updateFromHeaders(
    model: QuotaModelRef,
    headers: Readonly<Record<string, string>>,
    ctx: ExtensionContext,
  ): void;
  setThinkingLevel(level: ThinkingLevel): void;
  refresh(ctx: ExtensionContext, force?: boolean): void;
  dispose(): void;
};

function createQuotaBarRuntime(
  initialCtx: ExtensionContext,
  initialModel: QuotaModelRef | undefined,
): QuotaBarRuntime | undefined {
  if (initialCtx.mode !== "tui") return undefined;

  let activeModel = initialModel;
  let activeMatched: MatchedQuota | undefined;
  let activeModelKey: string | undefined;
  let thinkingLevel: ThinkingLevel = initialCtx.thinkingLevel ?? "off";
  let requestRender: (() => void) | undefined;
  let widgetMounted = false;
  let refreshGeneration = 0;
  let lastRefreshAt = 0;
  let requestController: AbortController | undefined;
  const standardQuotas = new Map<string, MatchedQuota>();

  const modelKey = (model: QuotaModelRef): string =>
    `${model.provider}/${model.id}`;

  const mountWidget = (ctx: ExtensionContext): void => {
    ctx.ui.setWidget(
      QUOTA_WIDGET_KEY,
      (tui, theme) => {
        requestRender = () => tui.requestRender();
        return {
          invalidate() {},
          render(width: number): string[] {
            if (
              !activeMatched ||
              !activeModel ||
              activeModelKey !== modelKey(activeModel)
            )
              return [];
            return renderQuotaBar(
              activeModel,
              activeMatched,
              width,
              theme,
              new Date(),
              theme.getThinkingBorderColor(thinkingLevel),
            );
          },
        };
      },
      { placement: "belowEditor" },
    );
    widgetMounted = true;
  };

  const hideWidget = (ctx: ExtensionContext): void => {
    requestRender = undefined;
    if (widgetMounted) ctx.ui.setWidget(QUOTA_WIDGET_KEY, undefined);
    widgetMounted = false;
  };

  const refresh = async (
    ctx: ExtensionContext,
    force = false,
  ): Promise<void> => {
    if (!activeModel || (!force && Date.now() - lastRefreshAt < 10_000)) return;
    const model = activeModel;
    const generation = ++refreshGeneration;
    lastRefreshAt = Date.now();
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const matched = await fetchActiveQuota(ctx, model, controller.signal);
      if (
        generation !== refreshGeneration ||
        activeModelKey !== modelKey(model)
      )
        return;

      activeMatched = matched;
      if (matched) {
        mountWidget(ctx);
        requestRender?.();
      } else {
        hideWidget(ctx);
      }
    } catch {
      if (
        generation !== refreshGeneration ||
        activeModelKey !== modelKey(model)
      )
        return;
      // A failed refresh must not replace a still-valid snapshot.
      if (activeMatched) {
        requestRender?.();
      } else {
        hideWidget(ctx);
      }
    } finally {
      clearTimeout(timeout);
      if (requestController === controller) requestController = undefined;
    }
  };

  const select = (model: QuotaModelRef, ctx: ExtensionContext): void => {
    activeModel = model;
    activeModelKey = modelKey(model);
    activeMatched =
      model.provider === "openai-codex" || model.provider === "9router"
        ? undefined
        : standardQuotas.get(model.provider);
    lastRefreshAt = 0;
    refreshGeneration++;
    requestController?.abort();
    if (activeMatched) {
      mountWidget(ctx);
      requestRender?.();
    } else {
      hideWidget(ctx);
    }
    void refresh(ctx, true);
  };

  const updateFromHeaders = (
    model: QuotaModelRef,
    headers: Readonly<Record<string, string>>,
    ctx: ExtensionContext,
  ): void => {
    // Provider-specific endpoints remain authoritative for these integrations.
    if (model.provider === "openai-codex" || model.provider === "9router")
      return;
    const matched = parseStandardQuotaHeaders(model.provider, headers);
    if (!matched) return;
    standardQuotas.set(model.provider, matched);
    if (activeModelKey !== modelKey(model)) return;
    activeMatched = matched;
    mountWidget(ctx);
    requestRender?.();
  };

  const setThinkingLevel = (level: ThinkingLevel): void => {
    thinkingLevel = level;
    requestRender?.();
  };

  activeModelKey = activeModel ? modelKey(activeModel) : undefined;
  const refreshTimer = setInterval(() => {
    void refresh(initialCtx);
  }, QUOTA_REFRESH_INTERVAL_MS);
  const renderTimer = setInterval(() => {
    if (activeMatched) requestRender?.();
  }, QUOTA_RENDER_INTERVAL_MS);

  void refresh(initialCtx, true);

  return {
    select,
    updateFromHeaders,
    setThinkingLevel,
    refresh: (ctx, force = false) => void refresh(ctx, force),
    dispose: () => {
      refreshGeneration++;
      requestController?.abort();
      clearInterval(refreshTimer);
      clearInterval(renderTimer);
      hideWidget(initialCtx);
    },
  };
}

export default function usageTrackerExtension(pi: ExtensionAPI) {
  let quotaBar: QuotaBarRuntime | undefined;

  pi.on("session_start", (_event, ctx) => {
    quotaBar?.dispose();
    quotaBar = createQuotaBarRuntime(ctx, ctx.model);
  });

  pi.on("model_select", (event, ctx) => {
    quotaBar?.select(event.model, ctx);
  });

  pi.on("thinking_level_select", (event) => {
    quotaBar?.setThinkingLevel(event.level);
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (!ctx.model) return;
    quotaBar?.updateFromHeaders(ctx.model, event.headers, ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    quotaBar?.refresh(ctx);
  });

  pi.on("session_shutdown", () => {
    quotaBar?.dispose();
    quotaBar = undefined;
  });

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
            0,
            0,
          ),
        { placement: "belowEditor" },
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
