import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import contextManagerExtension from "../index.ts";
import { OutputCache } from "./output-cache.ts";

function createExecuteHarness(): { execute: any; inspect: any; handlers: Map<string, (event: any, ctx: any) => any> } {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  contextManagerExtension({
    on(event: string, handler: (event: any, ctx: any) => any) { handlers.set(event, handler); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
  } as any);
  return { execute: tools.get("execute"), inspect: tools.get("inspect"), handlers };
}

function createExecuteTool(): any {
  return createExecuteHarness().execute;
}

test("running execute and inspect renderers add spacing above progress", () => {
  const { execute, inspect } = createExecuteHarness();
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const executeLines = execute.renderResult(
    {
      content: [{ type: "text", text: "Running · 0ms" }],
      details: { contextManager: { elapsedMs: 0, outputPreview: "live output" } },
    },
    { expanded: false, isPartial: true },
    theme,
    undefined,
  ).render(80);
  const inspectLines = inspect.renderResult(
    { content: [{ type: "text", text: "" }], details: {} },
    { expanded: false, isPartial: true },
    theme,
    undefined,
  ).render(80);

  assert.equal(executeLines[0]?.trim(), "");
  assert.match(executeLines[1] ?? "", /Running/);
  assert.equal(inspectLines[0]?.trim(), "");
  assert.match(inspectLines[1] ?? "", /inspect/);
});

test("execute renders final output as a bounded Codex-style block", () => {
  const execute = createExecuteTool();
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const args = { runtime: "shell", script: "npm test" + String.fromCharCode(27) + "[31m" };
  const call = execute.renderCall(args, theme, { executionStarted: true, isPartial: true } as any)
    .render(160).join("\n");
  const displayOutputPreview = {
    head: Array.from({ length: 20 }, (_, index) => `line-${index + 1}`),
    tail: Array.from({ length: 20 }, (_, index) => `line-${index + 81}`),
    totalLines: 100,
  };
  const result = {
    content: [{ type: "text", text: "compact model summary" }],
    details: {
      contextManager: {
        outputId: "output-a1b2c3d4",
        runtime: "shell",
        exitCode: 0,
        durationMs: 1_250,
        displayOutputPreview,
      },
    },
  };
  const collapsed = execute.renderResult(
    result,
    { expanded: false, isPartial: false },
    theme,
    { args, toolCallId: "result-test" } as any,
  ).render(160).join("\n");
  const expanded = execute.renderResult(
    result,
    { expanded: true, isPartial: false },
    theme,
    { args, toolCallId: "result-test" } as any,
  ).render(160).join("\n");

  assert.match(call, /Running/);
  assert.match(call, /npm test/);
  assert.ok(!call.includes(String.fromCharCode(27)));
  assert.match(collapsed, /Ran shell · npm test · success/);
  assert.ok(!collapsed.includes(String.fromCharCode(27)));
  assert.match(collapsed, /success/);
  assert.match(collapsed, /1.3s/);
  assert.match(collapsed, /line-1/);
  assert.match(collapsed, /line-4/);
  assert.match(collapsed, /\+92 lines omitted/);
  assert.match(collapsed, /line-97/);
  assert.match(collapsed, /line-100/);
  assert.doesNotMatch(collapsed, /line-20/);
  assert.match(expanded, /line-20/);
  assert.match(expanded, /line-81/);
  assert.match(expanded, /\+60 lines omitted/);
  assert.match(expanded, /inspect/);
  assert.match(expanded, /output-a1b2c3d4/);
});

test("execute renders failed, timeout, and cancelled statuses with termination details", () => {
  const execute = createExecuteTool();
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const args = { runtime: "javascript", script: "run-task" };
  const displayOutputPreview = { head: ["captured output"], tail: [], totalLines: 1 };
  const render = (contextManager: Record<string, unknown>) => execute.renderResult(
    {
      content: [{ type: "text", text: "failure summary" }],
      details: { contextManager: { runtime: "javascript", durationMs: 1_250, outputId: "output-deadbeef", displayOutputPreview, ...contextManager } },
      isError: true,
    },
    { expanded: false, isPartial: false },
    theme,
    { args, toolCallId: "status-test" } as any,
  ).render(160).join("\n");

  const failed = render({ exitCode: 7, signal: "SIGTERM" });
  const timedOut = render({ exitCode: null, signal: "SIGKILL", timedOut: true });
  const cancelled = render({ exitCode: null, signal: "SIGTERM", cancelled: true });

  assert.match(failed, /failed \(exit 7\)/);
  assert.match(failed, /SIGTERM/);
  assert.match(timedOut, /timeout/);
  assert.match(timedOut, /SIGKILL/);
  assert.match(cancelled, /cancelled/);
  assert.match(cancelled, /SIGTERM/);
  assert.match(cancelled, /captured output/);
});

test("execute retains failure and timeout status, signal, and cached output", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cm-terminal-state-"));
  const execute = createExecuteTool();
  let failedOutputId: string | undefined;
  let timeoutOutputId: string | undefined;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

  try {
    const failedError: any = await execute.execute(
      "failed-output-test",
      { runtime: "javascript", script: "process.stderr.write('exit-failure'); process.exitCode = 7" },
      undefined,
      undefined,
      { cwd, hasUI: true } as any,
    ).then(() => undefined, (error: any) => error);
    const failedDetails = failedError?.details?.contextManager;
    failedOutputId = failedDetails?.outputId;
    assert.ok(failedError instanceof Error);
    assert.equal(failedDetails?.exitCode, 7);
    assert.equal(failedDetails?.timedOut, false);
    assert.match(await new OutputCache().get(failedOutputId!) ?? "", /exit-failure/);
    const failedRender = execute.renderResult(
      { content: [{ type: "text", text: failedError.message }], details: (failedError as any).details, isError: true },
      { expanded: false, isPartial: false },
      theme,
      { args: { runtime: "javascript", script: "exit task" } } as any,
    ).render(160).join("\n");
    assert.match(failedRender, /failed \(exit 7\)/);
    assert.match(failedRender, /exit-failure/);

    const timeoutError: any = await execute.execute(
      "timeout-output-test",
      { runtime: "javascript", timeoutMs: 1_000, script: "process.stdout.write('before-timeout\\n'); setTimeout(() => {}, 5_000)" },
      undefined,
      undefined,
      { cwd, hasUI: true } as any,
    ).then(() => undefined, (error: any) => error);
    const timeoutDetails = timeoutError?.details?.contextManager;
    timeoutOutputId = timeoutDetails?.outputId;
    assert.ok(timeoutError instanceof Error);
    assert.equal(timeoutDetails?.timedOut, true);
    assert.ok(timeoutDetails?.durationMs >= 1_000);
    assert.match(await new OutputCache().get(timeoutOutputId!) ?? "", /before-timeout/);
    const timeoutRender = execute.renderResult(
      { content: [{ type: "text", text: timeoutError.message }], details: (timeoutError as any).details, isError: true },
      { expanded: false, isPartial: false },
      theme,
      { args: { runtime: "javascript", script: "wait task" } } as any,
    ).render(160).join("\n");
    assert.match(timeoutRender, /timeout/);
    assert.match(timeoutRender, /before-timeout/);
  } finally {
    if (failedOutputId) await new OutputCache().remove(failedOutputId);
    if (timeoutOutputId) await new OutputCache().remove(timeoutOutputId);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("execute reports cancellation requested before process start", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cm-pre-cancelled-"));
  const marker = join(cwd, "started.txt");
  const execute = createExecuteTool();
  const controller = new AbortController();
  controller.abort();

  try {
    const error: any = await execute.execute(
      "pre-cancelled-output-test",
      { runtime: "javascript", script: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")` },
      controller.signal,
      undefined,
      { cwd, hasUI: true } as any,
    ).then(() => undefined, (caught: any) => caught);

    assert.ok(error instanceof Error);
    assert.equal((error as any).details?.contextManager?.cancelled, true);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("execute reports cancellation with cached partial output", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cm-cancelled-output-"));
  const harness = createExecuteHarness();
  const execute = harness.execute;
  const controller = new AbortController();
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const args = { runtime: "javascript", script: "write output then wait" };
  let outputId: string | undefined;

  try {
    const error: any = await execute.execute(
      "cancelled-output-test",
      { runtime: "javascript", script: "process.stdout.write('before-cancel\\n'); setTimeout(() => {}, 5_000)" },
      controller.signal,
      (update: any) => {
        if (update.details?.contextManager?.outputPreview?.includes("before-cancel")) controller.abort();
      },
      { cwd, hasUI: true } as any,
    ).then(() => undefined, (caught: any) => caught);
    const details = error?.details?.contextManager;
    outputId = details?.outputId;

    assert.ok(error);
    assert.equal(details?.cancelled, true);
    assert.ok(details?.durationMs > 0);
    assert.match(await new OutputCache().get(outputId!) ?? "", /before-cancel/);
    const toolResultHandler = harness.handlers.get("tool_result");
    assert.ok(toolResultHandler);
    const wrappedResult = await toolResultHandler({
      toolName: "execute",
      toolCallId: "cancelled-output-test",
      isError: true,
      content: [{ type: "text", text: error.message }],
      details: {},
    }, {} as any);
    assert.equal(wrappedResult.details.contextManager.cancelled, true);
    assert.equal(wrappedResult.details.contextManager.outputId, outputId);
    const rendered = execute.renderResult(
      { content: wrappedResult.content, details: wrappedResult.details, isError: true },
      { expanded: false, isPartial: false },
      theme,
      { args, toolCallId: "cancelled-output-test" } as any,
    ).render(160).join("\n");
    assert.match(rendered, /cancelled/);
    assert.match(rendered, /before-cancel/);
  } finally {
    if (outputId) await new OutputCache().remove(outputId);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("execute keeps display previews UI-only in headless contexts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cm-headless-output-"));
  const execute = createExecuteTool();
  let updateCalls = 0;
  let outputId: string | undefined;
  let failureOutputId: string | undefined;

  try {
    const result = await execute.execute(
      "headless-output-test",
      { runtime: "javascript", script: "process.stdout.write('headless-output')" },
      undefined,
      () => { updateCalls++; },
      { cwd, hasUI: false } as any,
    );
    outputId = result.details?.contextManager?.outputId;

    assert.equal(updateCalls, 0);
    assert.equal(result.details?.contextManager?.displayOutputPreview, undefined);
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Status: success/);
    assert.match(await new OutputCache().get(outputId!) ?? "", /headless-output/);

    const failureError = await execute.execute(
      "headless-failure-test",
      { runtime: "javascript", script: "process.stderr.write('headless-failure'); process.exitCode = 3" },
      undefined,
      () => { updateCalls++; },
      { cwd, hasUI: false } as any,
    ).then(() => undefined, (error: any) => error);
    failureOutputId = failureError?.details?.contextManager?.outputId;
    assert.ok(failureError instanceof Error);
    assert.equal((failureError as any).details.contextManager.exitCode, 3);
    assert.equal(updateCalls, 0);
    assert.match(await new OutputCache().get(failureOutputId!) ?? "", /headless-failure/);
  } finally {
    if (outputId) await new OutputCache().remove(outputId);
    if (failureOutputId) await new OutputCache().remove(failureOutputId);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("execute streams live output into the partial tool renderer", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cm-live-output-"));
  const execute = createExecuteTool();
  assert.ok(execute);
  let partialOutputSeen = false;
  let renderedPartial = "";
  let outputId: string | undefined;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

  try {
    const result = await execute.execute(
      "live-output-test",
      {
        runtime: "shell",
        script: process.platform === "win32"
          ? "[Console]::Out.WriteLine('live-start'); [Console]::Error.WriteLine('stderr-live'); Start-Sleep -Milliseconds 350; Write-Output live-end"
          : "printf 'live-start\\n'; printf 'stderr-live\\n' >&2; sleep 0.35; printf 'live-end\\n'",
      },
      undefined,
      (update: any) => {
        const details = update.details?.contextManager;
        if (typeof details?.outputPreview === "string" && details.outputPreview.includes("live-start")) {
          partialOutputSeen = true;
          renderedPartial = execute.renderResult(
            update,
            { expanded: false, isPartial: true },
            theme,
            undefined,
          ).render(120).join("\n");
        }
      },
      { cwd, hasUI: true } as any,
    );
    outputId = result.details?.contextManager?.outputId;

    assert.equal(partialOutputSeen, true);
    assert.match(renderedPartial, /live-start/);
    assert.match(renderedPartial, /stderr-live/);
    assert.match(renderedPartial, /Running/);

    const finalModelText = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.match(finalModelText, /\[context-manager\] Status: success/);
    assert.match(finalModelText, /inspect:/);
    const cachedOutput = await new OutputCache().get(outputId!);
    assert.match(cachedOutput ?? "", /live-start/);
    assert.match(cachedOutput ?? "", /stderr-live/);
    assert.match(cachedOutput ?? "", /live-end/);

    const finalPreview = result.details?.contextManager?.displayOutputPreview;
    assert.equal(typeof finalPreview, "object");
    assert.match(JSON.stringify(finalPreview), /live-start/);
    assert.match(JSON.stringify(finalPreview), /stderr-live/);
    const renderedFinal = execute.renderResult(
      result,
      { expanded: false, isPartial: false },
      theme,
      { args: { runtime: "shell", script: "live stream test" } } as any,
    ).render(120).join("\n");
    assert.match(renderedFinal, /success/);
    assert.match(renderedFinal, /live-start/);
    assert.match(renderedFinal, /stderr-live/);
    assert.match(renderedFinal, /live-end/);
    assert.match(renderedFinal, /ctrl\+o to expand/);
  } finally {
    if (outputId) await new OutputCache().remove(outputId);
    rmSync(cwd, { recursive: true, force: true });
  }
});
