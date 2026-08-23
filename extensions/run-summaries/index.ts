import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadSummaryConfig, saveSummaryConfig } from "./src/config.ts";
import { summarizeRun } from "./src/summarizer.ts";
import { SummaryQueue } from "./src/summary-queue.ts";
import {
  buildFallbackRecap,
  createRunBoundary,
  getRunEntries,
  serializeRunTranscript,
} from "./src/transcript.ts";
import {
  openModelPicker,
  openReasoningPicker,
  renderRecap,
  type RecapEntryData,
} from "./src/ui.ts";

const RECAP_ENTRY_TYPE = "summary-recap";
const STATUS_KEY = "summaries";
const SHUTDOWN_WAIT_MS = 1_000;
const SUMMARY_CONCURRENCY = 1;

async function waitForCancellation(
  tasks: readonly Promise<void>[],
  timeoutMs: number,
) {
  if (tasks.length === 0) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export default function (pi: ExtensionAPI) {
  const runBoundary = createRunBoundary();
  const activeSummaries = new Map<AbortController, Promise<void>>();
  const scheduledRunKeys = new Set<string>();
  let sessionActive = false;
  let sessionGeneration = 0;
  let statusContext: ExtensionContext | undefined;

  const updateStatus = () => {
    const pending = summaryQueue?.pendingCount ?? 0;
    const active = activeSummaries.size;
    const label = active > 0
      ? pending > 0
        ? `▪ summarizing run… (${pending} queued)`
        : "▪ summarizing run…"
      : undefined;
    statusContext?.ui.setStatus(
      STATUS_KEY,
      label ? statusContext.ui.theme.fg("muted", label) : undefined,
    );
  };
  const summaryQueue = new SummaryQueue({
    concurrency: SUMMARY_CONCURRENCY,
    onChange: updateStatus,
  });

  pi.registerEntryRenderer<RecapEntryData>(
    RECAP_ENTRY_TYPE,
    (entry, { expanded }, theme) => renderRecap(entry.data, expanded, theme),
  );

  pi.on("session_start", (_event, ctx) => {
    scheduledRunKeys.clear();
    sessionActive = ctx.mode === "tui";
    sessionGeneration++;
    statusContext = ctx;
    summaryQueue.reopen();
    runBoundary.reset();
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    runBoundary.begin(ctx.sessionManager.getLeafId());
  });

  pi.on("agent_settled", (_event, ctx) => {
    const run = runBoundary.settle();
    if (!run || ctx.mode !== "tui" || !sessionActive) return;

    const entries = getRunEntries(
      ctx.sessionManager.getBranch(),
      run.baselineLeafId,
    );
    if (entries.length === 0) return;

    // Entry IDs are stable for a run and distinguish consecutive runs even
    // when they share the same baseline leaf.
    const runKey = entries.map((entry) => entry.id).join(",");
    const branchAlreadyHasRecap = ctx.sessionManager.getBranch().some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === RECAP_ENTRY_TYPE &&
        typeof entry.data === "object" &&
        entry.data !== null &&
        "runKey" in entry.data &&
        entry.data.runKey === runKey,
    );
    if (branchAlreadyHasRecap || scheduledRunKeys.has(runKey)) return;
    scheduledRunKeys.add(runKey);

    const config = loadSummaryConfig();
    const generation = sessionGeneration;
    statusContext = ctx;
    summaryQueue.enqueue(async () => {
      if (!sessionActive || generation !== sessionGeneration) return;
      const controller = new AbortController();
      const task = (async () => {
        let recap: RecapEntryData;
        try {
          const generated = await summarizeRun({
            modelRegistry: ctx.modelRegistry,
            config,
            transcript: serializeRunTranscript(entries),
            signal: controller.signal,
          });
          recap = { ...generated, ...config };
        } catch (error) {
          if (
            controller.signal.aborted ||
            !sessionActive ||
            generation !== sessionGeneration
          ) return;

          const currentModel = ctx.model;
          if (
            currentModel &&
            (currentModel.provider !== config.provider ||
              currentModel.id !== config.model)
          ) {
            try {
              const fallbackConfig = {
                ...config,
                provider: currentModel.provider,
                model: currentModel.id,
              };
              const generated = await summarizeRun({
                modelRegistry: ctx.modelRegistry,
                config: fallbackConfig,
                transcript: serializeRunTranscript(entries),
                signal: controller.signal,
              });
              recap = { ...generated, ...fallbackConfig, fallbackModel: true };
              ctx.ui.notify(
                `Summary model failed; fell back to session model (${currentModel.provider}/${currentModel.id}).`,
                "info",
              );
            } catch {
              recap = {
                ...buildFallbackRecap(entries),
                ...config,
                fallback: true,
              };
              ctx.ui.notify(
                "The summary model failed; showing a concise local fallback.",
                "warning",
              );
            }
          } else {
            recap = {
              ...buildFallbackRecap(entries),
              ...config,
              fallback: true,
            };
            ctx.ui.notify(
              "The summary model failed; showing a concise local fallback.",
              "warning",
            );
          }
        }

        if (
          !sessionActive ||
          generation !== sessionGeneration ||
          controller.signal.aborted
        ) return;

        // Re-check immediately before append. This closes the race where two
        // extension instances summarize the same run concurrently.
        const recapAlreadyAppended = ctx.sessionManager.getBranch().some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === RECAP_ENTRY_TYPE &&
            typeof entry.data === "object" &&
            entry.data !== null &&
            "runKey" in entry.data &&
            entry.data.runKey === runKey,
        );
        if (recapAlreadyAppended) return;
        pi.appendEntry(RECAP_ENTRY_TYPE, { ...recap, runKey });
      })();

      activeSummaries.set(controller, task);
      updateStatus();
      try {
        await task;
      } finally {
        activeSummaries.delete(controller);
        updateStatus();
      }
    });
  });

  pi.on("session_shutdown", async () => {
    sessionActive = false;
    sessionGeneration++;
    runBoundary.reset();
    summaryQueue.close();
    const summaries = [...activeSummaries.entries()];
    for (const [controller] of summaries) controller.abort();
    await waitForCancellation(
      summaries.map(([, task]) => task),
      SHUTDOWN_WAIT_MS,
    );
    activeSummaries.clear();
    statusContext?.ui.setStatus(STATUS_KEY, undefined);
    statusContext = undefined;
  });

  pi.registerCommand("summary-model", {
    description: "Choose the model and reasoning level used for run recaps",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Summary model selection is only available in the TUI.",
            "error",
          );
        }
        return;
      }

      const current = loadSummaryConfig();
      const model = await openModelPicker(ctx, current);
      if (!model) return;

      const reasoning = await openReasoningPicker(
        ctx,
        model,
        current.reasoning,
      );
      if (!reasoning) return;

      const config = {
        provider: model.provider,
        model: model.id,
        reasoning,
      };
      try {
        await saveSummaryConfig(config);
      } catch {
        ctx.ui.notify(
          "Could not save the private summary model config.",
          "error",
        );
        return;
      }

      ctx.ui.notify(
        `Summary model: ${config.provider}/${config.model} · ${config.reasoning}`,
        "info",
      );
    },
  });
}
