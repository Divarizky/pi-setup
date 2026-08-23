import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent"
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui"
import { Input, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import type { ActionRecord } from "../action-queue.ts"
import type { ApprovalRequest } from "../approval.ts"
import { formatElapsed, type SubagentSnapshot } from "../domain.ts"
import { formatContextUtilization } from "../format.ts"
import type { SubagentReadModel } from "../manager.ts"
import { buildTranscriptLines, sanitizeText } from "./transcript.ts"

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
  return keybindings.getKeys(binding).join("/") || "unbound"
}

function statusGlyph(snap: SubagentSnapshot, theme: Theme): string {
  if (snap.restarting) return theme.fg("warning", "START")
  switch (snap.status) {
    case "running":
      return theme.fg("warning", "RUN")
    case "done":
      return theme.fg("success", "OK")
    case "error":
      return theme.fg("error", "ERR")
  }
}

function contextLabel(snap: SubagentSnapshot): string {
  const projectPath = snap.meta.worktree?.repoRoot ?? snap.cwd
  const project = projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath
  const worktree = snap.meta.worktree?.branch
    ?? snap.meta.worktree?.path.split(/[\\/]/).filter(Boolean).pop()
  return worktree ? `${project} · ${worktree}` : project
}

function statusWord(snap: SubagentSnapshot, theme: Theme): string {
  if (snap.restarting) return theme.fg("warning", "starting")
  switch (snap.status) {
    case "running":
      return theme.fg("warning", "running")
    case "done":
      return theme.fg("success", "done")
    case "error":
      return theme.fg("error", "failed")
  }
}

export interface TakeoverOptions {
  readonly badge?: string
  readonly getApprovals?: (jobId: string) => ReadonlyArray<ApprovalRequest>
  readonly getActions?: (jobId: string) => ReadonlyArray<ActionRecord>
  readonly onDelete?: (jobId: string) => Promise<void>
  readonly confirmDelete?: (snap: SubagentSnapshot) => Promise<boolean>
  readonly onDeleteError?: (message: string) => void
}

function helpLines(text: string, width: number, maxLines?: number): string[] {
  const wrapped = wrapTextWithAnsi(text, Math.max(12, width - 2))
  return maxLines === undefined ? wrapped : wrapped.slice(0, maxLines)
}

export function formatSubagentError(errorText: string): string {
  const clean = sanitizeText(errorText).replace(/\s+/g, " ").trim()
  const apiKey = clean.match(/^No API key found for\s+([^\.\s]+)\.?/i)
  if (apiKey) {
    return `Provider ${apiKey[1]} belum terautentikasi. Jalankan /login, lalu retry subagent.`
  }
  return clean
}

function labeledLines(label: string, value: string, width: number, maxLines = 3): string[] {
  return wrapTextWithAnsi(`${label}${value}`, Math.max(12, width)).slice(0, maxLines)
}

export function buildSubagentInfoLines(
  snap: SubagentSnapshot,
  width: number,
  theme: Theme,
  options?: TakeoverOptions,
): string[] {
  const report = snap.report
  const approvals = options?.getApprovals?.(snap.id).filter((item) => item.status === "pending") ?? []
  const actions = options?.getActions?.(snap.id).filter((item) => item.status === "pending") ?? []
  const mode = snap.meta.mode ?? "build"
  const origin = snap.origin === "quick-ask" ? "quick-ask" : "model"
  const details = [
    `${mode}/${origin}`,
    snap.backend,
    contextLabel(snap),
    snap.backend === "orca" && snap.meta.nativeTerminalHandle
      ? `terminal ${snap.meta.nativeTerminalHandle}`
      : undefined,
    snap.queued.length > 0 ? `${snap.queued.length} queued` : undefined,
    approvals.length > 0 ? `${approvals.length} approval${approvals.length === 1 ? "" : "s"}` : undefined,
    actions.length > 0 ? `${actions.length} action${actions.length === 1 ? "" : "s"}` : undefined,
  ].filter(Boolean).join(" · ")
  const lines = [theme.fg("muted", truncateToWidth(details, width))]
  if (report) {
    const reportLine = `report: ${report.outcome}${report.needsParentDecision ? " · decision needed" : ""}`
    lines.push(theme.fg(report.needsParentDecision ? "warning" : "dim", truncateToWidth(reportLine, width)))
    lines.push(...labeledLines("summary: ", sanitizeText(report.summary), width, 2).map((line) => theme.fg("dim", line)))
  }
  if (approvals.length > 0) {
    lines.push(theme.fg("warning", truncateToWidth(`pending approval: ${approvals.map((item) => item.operation).join(", ")}`, width)))
  }
  if (actions.length > 0) {
    lines.push(theme.fg("warning", truncateToWidth(`pending action: ${actions.map((item) => item.event.type).join(", ")}`, width)))
  }
  return lines
}

export async function openSubagentTakeover(
  ctx: ExtensionCommandContext,
  view: SubagentReadModel,
  id: string,
  options?: TakeoverOptions,
) {
  if (!view.get(id)) return
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) =>
      new TakeoverView(tui, theme, keybindings, id, view, done, options),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  )
}

export function confirmSubagentDeletion(
  ctx: Pick<ExtensionCommandContext, "ui">,
  snap: SubagentSnapshot,
): Promise<boolean> {
  return ctx.ui.custom<boolean>(
    (tui, theme, keybindings, done) =>
      new DeleteConfirmationView(tui, theme, keybindings, snap, done),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "56%", minWidth: 48, maxHeight: "100%" },
    },
  )
}

export async function openSubagentPicker(
  ctx: ExtensionCommandContext,
  view: SubagentReadModel,
  options?: TakeoverOptions,
) {
  const selection: DashboardSelection = { index: 0 }

  while (true) {
    if (view.size() === 0) {
      ctx.ui.notify("No subagents", "info")
      return
    }

    const picked = await ctx.ui.custom<string | null>(
      (tui, theme, keybindings, done) =>
        new SubagentDashboard(tui, theme, keybindings, view, selection, done, {
          ...options,
          confirmDelete: (snap) => confirmSubagentDeletion(ctx, snap),
          onDeleteError: (message) => ctx.ui.notify(message, "error"),
        }),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    )

    if (!picked) return
    if (!view.get(picked)) continue

    await openSubagentTakeover(ctx, view, picked, options)
  }
}

export interface DashboardSelection {
  id?: string
  index: number
}

export function reconcileDashboardSelection(
  selection: DashboardSelection,
  subs: ReadonlyArray<Pick<SubagentSnapshot, "id">>,
) {
  const stableIndex = selection.id ? subs.findIndex((snap) => snap.id === selection.id) : -1
  selection.index =
    stableIndex >= 0
      ? stableIndex
      : Math.min(Math.max(0, selection.index), Math.max(0, subs.length - 1))
  selection.id = subs[selection.index]?.id
}

class DeleteConfirmationView implements Component {
  private tui: TUI
  private theme: Theme
  private keybindings: KeybindingsManager
  private snap: SubagentSnapshot
  private done: (value: boolean) => void
  private closed = false

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    snap: SubagentSnapshot,
    done: (value: boolean) => void,
  ) {
    this.tui = tui
    this.theme = theme
    this.keybindings = keybindings
    this.snap = snap
    this.done = done
  }

  private close(value: boolean) {
    if (this.closed) return
    this.closed = true
    this.done(value)
  }

  render(width: number): string[] {
    const frameWidth = Math.max(4, width)
    const innerWidth = Math.max(1, frameWidth - 4)
    const title = this.theme.fg("warning", this.theme.bold("DELETE THREAD"))
    const messageLines = wrapTextWithAnsi(`Delete "${this.snap.title}" and its session/chat history?`, innerWidth)
    const content = [
      title,
      ...messageLines,
      this.theme.fg("warning", "The session, durable metadata, worktree, branch, and all uncommitted changes will be deleted."),
      "",
      this.theme.fg("dim", "Enter/y confirm · Esc/n cancel"),
    ]
    const top = this.theme.fg("border", `╭${"─".repeat(frameWidth - 2)}╮`)
    const bottom = this.theme.fg("border", `╰${"─".repeat(frameWidth - 2)}╯`)
    const framed = content.map(
      (line) => this.theme.fg("border", "│ ") + this.pad(line, innerWidth) + this.theme.fg("border", " │"),
    )
    return [top, ...framed, bottom].map((line) => truncateToWidth(line, frameWidth))
  }

  private pad(text: string, width: number): string {
    const truncated = truncateToWidth(text, width)
    return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)))
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.confirm") || data === "y" || data === "Y") {
      this.close(true)
    } else if (this.keybindings.matches(data, "tui.select.cancel") || data === "n" || data === "N") {
      this.close(false)
    }
  }

  invalidate(): void {}
}

class SubagentDashboard implements Component {
  private tui: TUI
  private theme: Theme
  private keybindings: KeybindingsManager
  private view: SubagentReadModel
  private selection: DashboardSelection
  private done: (value: string | null) => void
  private options?: TakeoverOptions
  private showHistory = false
  private deleting = false
  private hiddenIds = new Set<string>()

  private closed = false
  private ticker: ReturnType<typeof setInterval>
  private unsubChange: () => void

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    view: SubagentReadModel,
    selection: DashboardSelection,
    done: (value: string | null) => void,
    options?: TakeoverOptions,
  ) {
    this.tui = tui
    this.theme = theme
    this.keybindings = keybindings
    this.view = view
    this.selection = selection
    this.done = done
    this.options = options
    this.ticker = setInterval(() => this.tui.requestRender(), 1000)
    this.unsubChange = view.subscribe(() => this.tui.requestRender())
  }

  private subs(): ReadonlyArray<SubagentSnapshot> {
    const all = this.view.list().filter((snap) => !this.hiddenIds.has(snap.id))
    if (this.showHistory) return all.filter((snap) => snap.status === "done" && !snap.restarting)
    return all.filter((snap) => {
      const approvals = this.options?.getApprovals?.(snap.id).some((item) => item.status === "pending") ?? false
      const actions = this.options?.getActions?.(snap.id).some((item) => item.status === "pending") ?? false
      return snap.status === "running" || snap.restarting === true || snap.status === "error" || approvals || actions
    })
  }

  private cleanup() {
    if (this.closed) return false
    this.closed = true
    clearInterval(this.ticker)
    this.unsubChange()
    return true
  }

  private close(result: string | null) {
    if (this.cleanup()) this.done(result)
  }

  dispose(): void {
    this.cleanup()
  }

  handleInput(data: string): void {
    const subs = this.subs()
    reconcileDashboardSelection(this.selection, subs)

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close(null)
      return
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const snap = subs[this.selection.index]
      if (snap) this.close(snap.id)
      return
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (subs.length > 0) {
        this.selection.index = (this.selection.index - 1 + subs.length) % subs.length
        this.selection.id = subs[this.selection.index]?.id
        this.tui.requestRender()
      }
      return
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      if (subs.length > 0) {
        this.selection.index = (this.selection.index + 1) % subs.length
        this.selection.id = subs[this.selection.index]?.id
        this.tui.requestRender()
      }
      return
    }
    if (data === "x") {
      const snap = subs[this.selection.index]
      if (snap && snap.status === "running") this.view.requestAbort(snap.id)
      return
    }
    if (data === "d") {
      const snap = subs[this.selection.index]
      if (snap && this.options?.onDelete && !this.deleting) void this.deleteThread(snap)
      return
    }
    if (data === "h") {
      this.showHistory = !this.showHistory
      this.selection.index = 0
      this.selection.id = undefined
      this.tui.requestRender()
      return
    }
  }

  private async deleteThread(snap: SubagentSnapshot): Promise<void> {
    this.deleting = true
    this.tui.requestRender()
    try {
      const confirmed = await this.options?.confirmDelete?.(snap)
      if (confirmed) {
        await this.options?.onDelete?.(snap.id)
        this.hiddenIds.add(snap.id)
      }
    } catch (error) {
      this.options?.onDeleteError?.(`Could not delete ${snap.id}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.deleting = false
      this.tui.requestRender()
    }
  }

  private pad(text: string, width: number): string {
    const truncated = truncateToWidth(text, width)
    return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)))
  }

  private borderSegment(width: number, title: string): string {
    const theme = this.theme
    const label = title
      ? ` ${truncateToWidth(title, Math.max(0, width - 3))} `
      : ""
    const labelWidth = visibleWidth(label)
    return (
      theme.fg("border", "─") +
      (label ? theme.fg("text", label) : "") +
      theme.fg("border", "─".repeat(Math.max(0, width - 1 - labelWidth)))
    )
  }

  render(width: number): string[] {
    const theme = this.theme
    const subs = this.subs()
    reconcileDashboardSelection(this.selection, subs)
    const rows = this.tui.terminal.rows || 30
    const help = helpLines(
      `↑/↓ select · ${configuredKeys(this.keybindings, "tui.select.confirm")} open · h ${this.showHistory ? "active" : "history"} · d delete · x abort · ${configuredKeys(this.keybindings, "tui.select.cancel")} close`,
      width,
      rows < 10 ? 2 : undefined,
    )
    const bodyHeight = Math.max(1, rows - 4 - help.length)
    const leftWidth = Math.max(10, Math.min(48, Math.floor((width - 2) * 0.38)))
    const rightWidth = Math.max(10, width - 2 - leftWidth)
    const selected = subs[this.selection.index]
    const leftRows = this.renderRows(subs, leftWidth, Math.max(1, bodyHeight - 2))
    const detail = this.renderDetail(selected, rightWidth, Math.max(1, bodyHeight - 1))
    const leftTitle = [
      theme.fg("accent", theme.bold("SUBAGENTS")),
      theme.fg("muted", this.showHistory ? "history" : "active + attention"),
    ]
    const rightTitle = theme.fg("accent", theme.bold(selected ? `THREAD · ${selected.title}` : "THREAD"))
    const leftContent = [...leftTitle, ...leftRows]
    const rightContent = [rightTitle, ...detail]
    const lines: string[] = []
    lines.push(
      theme.fg("border", "╭" + "─".repeat(leftWidth) + "┬" + "─".repeat(rightWidth) + "╮"),
    )
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(
        theme.fg("border", "│") + this.pad(leftContent[i] ?? "", leftWidth) +
        theme.fg("border", "│") + this.pad(rightContent[i] ?? "", rightWidth) +
        theme.fg("border", "│"),
      )
    }
    lines.push(
      theme.fg("border", "╰" + "─".repeat(leftWidth) + "┴" + "─".repeat(rightWidth) + "╯"),
    )
    for (const line of help) lines.push(truncateToWidth(theme.fg("dim", `  ${line}`), width))
    return lines
  }

  private boxTop(width: number): string {
    return this.theme.fg("border", "╭" + "─".repeat(Math.max(0, width - 2)) + "╮")
  }

  private boxBottom(width: number): string {
    return this.theme.fg("border", "╰" + "─".repeat(Math.max(0, width - 2)) + "╯")
  }

  private renderDetail(snap: SubagentSnapshot | undefined, width: number, height: number): string[] {
    const theme = this.theme
    if (!snap) return [theme.fg("dim", "Select a Thread")]

    const approvals = this.options?.getApprovals?.(snap.id).filter((item) => item.status === "pending") ?? []
    const mode = snap.meta.mode ?? "build"
    const origin = snap.origin === "quick-ask" ? "quick-ask" : "model"
    const worktree = snap.meta.worktree
    const report = snap.report
    const passedTests = report?.tests.filter((test) => test.passed).length ?? 0
    const changedFiles = report?.changes.length ?? 0
    const lines: string[] = [
      theme.fg("accent", theme.bold(`${statusWord(snap, theme)} · ${snap.title}`)),
    ]

    if (approvals.length > 0) {
      lines.push(theme.fg("warning", theme.bold("[APPROVAL REQUIRED]")))
      lines.push(theme.fg("warning", `Action: ${approvals.map((item) => item.operation).join(", ")}`))
    }

    lines.push(theme.fg("muted", `${mode}/${origin} · ${snap.backend}`))
    if (snap.meta.modelLabel) lines.push(theme.fg("muted", `Model: ${snap.meta.modelLabel}`))
    if (worktree?.branch) lines.push(theme.fg("muted", `Branch: ${worktree.branch}`))
    if (worktree?.path) lines.push(theme.fg("muted", `Worktree: ${worktree.path}`))
    if (snap.backend === "orca") {
      if (snap.meta.nativeTerminalHandle) lines.push(theme.fg("muted", `Orca terminal: ${snap.meta.nativeTerminalHandle}`))
      if (snap.meta.nativeTabId) lines.push(theme.fg("muted", `Orca tab: ${snap.meta.nativeTabId}`))
      if (snap.meta.nativePaneKey) lines.push(theme.fg("muted", `Orca pane: ${snap.meta.nativePaneKey}`))
      if (snap.meta.nativeWorktreeId) lines.push(theme.fg("muted", `Orca worktree: ${snap.meta.nativeWorktreeId}`))
    }
    lines.push(theme.fg("muted", `Tests: ${passedTests} passed · Files: ${changedFiles} changed`))

    if (report) {
      lines.push(theme.fg("border", "─".repeat(Math.max(1, Math.min(width, 40)))))
      lines.push(theme.fg(report.needsParentDecision ? "warning" : "text", `Report: ${report.outcome}`))
      lines.push(...labeledLines("Summary: ", sanitizeText(report.summary), width, 2).map((line) => theme.fg("dim", line)))
    }
    if (snap.errorText) {
      lines.push(...labeledLines("Error: ", formatSubagentError(snap.errorText), width, 3).map((line) => theme.fg("error", line)))
    }

    const transcript = buildTranscriptLines(snap, width, theme)
    lines.push(theme.fg("border", "─".repeat(Math.max(1, Math.min(width, 40)))))
    lines.push(...transcript.slice(Math.max(0, transcript.length - Math.max(1, height - lines.length))))
    return lines.slice(0, height)
  }

  private renderRows(
    subs: ReadonlyArray<SubagentSnapshot>,
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme
    const out: string[] = []

    const itemHeight = 2
    const visibleCount = Math.max(1, Math.floor(height / itemHeight))
    let start = 0
    if (subs.length > visibleCount) {
      start = Math.min(
        Math.max(0, this.selection.index - Math.floor(visibleCount / 2)),
        subs.length - visibleCount,
      )
    }
    const visible = subs.slice(start, start + visibleCount)

    for (let i = 0; i < visible.length; i++) {
      const snap = visible[i]
      const index = start + i
      const isSelected = index === this.selection.index
      const marker = isSelected ? theme.fg("accent", ">") : " "
      const title = isSelected ? theme.fg("accent", snap.title) : theme.fg("text", snap.title)
      const primary = ` ${marker} ${statusGlyph(snap, theme)} ${title}`
      const secondary = `     ${theme.fg("dim", snap.id)} ${theme.fg("muted", `· ${contextLabel(snap)}`)}`
      out.push(truncateToWidth(primary, width))
      out.push(truncateToWidth(secondary, width))
    }

    if (start > 0) {
      out[0] = truncateToWidth(theme.fg("dim", `   ... ${start} more`), width)
      if (out.length > 1) out[1] = ""
    }
    if (start + visibleCount < subs.length) {
      out[out.length - 2] = truncateToWidth(
        theme.fg("dim", `   ... ${subs.length - start - visibleCount} more`), width,
      )
      out[out.length - 1] = ""
    }
    return out
  }

  invalidate(): void {}
}

class TakeoverView implements Component, Focusable {
  private tui: TUI
  private theme: Theme
  private keybindings: KeybindingsManager
  private id: string
  private view: SubagentReadModel
  private done: (value: null) => void
  private options?: TakeoverOptions

  private input = new Input()
  private scrollOffset = 0
  private unsubscribe: () => void
  private renderTimer?: ReturnType<typeof setTimeout>
  private ticker: ReturnType<typeof setInterval>
  private closed = false
  private actionError?: string

  private _focused = false
  get focused(): boolean {
    return this._focused
  }
  set focused(value: boolean) {
    this._focused = value
    this.input.focused = value
  }

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    id: string,
    view: SubagentReadModel,
    done: (value: null) => void,
    options?: TakeoverOptions,
  ) {
    this.tui = tui
    this.theme = theme
    this.keybindings = keybindings
    this.id = id
    this.view = view
    this.done = done
    this.options = options
    this.unsubscribe = view.subscribeTo(id, () => this.scheduleRender())
    this.ticker = setInterval(() => this.tui.requestRender(), 1000)
    this.input.onSubmit = (value: string) => {
      const text = value.trim()
      if (!text) return
      this.input.setValue("")
      this.actionError = undefined
      this.view.requestSend(this.id, text, (message) => {
        this.actionError = message
        this.tui.requestRender()
      })
      this.scrollOffset = 0
      this.tui.requestRender()
    }
  }

  private snap(): SubagentSnapshot | undefined {
    return this.view.get(this.id)
  }

  private scheduleRender() {
    if (this.renderTimer) return
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined
      if (!this.closed) this.tui.requestRender()
    }, 50)
  }

  private cleanup() {
    if (this.closed) return false
    this.closed = true
    this.unsubscribe()
    clearInterval(this.ticker)
    if (this.renderTimer) clearTimeout(this.renderTimer)
    this.renderTimer = undefined
    return true
  }

  private close() {
    if (this.cleanup()) this.done(null)
  }

  dispose(): void {
    this.cleanup()
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "app.clear")) {
      const snap = this.snap()
      if (snap?.status === "running") this.view.requestAbort(this.id)
      return
    }
    if (
      this.keybindings.matches(data, "app.interrupt") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.close()
      return
    }
    if (this.keybindings.matches(data, "tui.editor.pageUp")) {
      this.scrollOffset += this.viewportHeight()
      this.tui.requestRender()
      return
    }
    if (this.keybindings.matches(data, "tui.editor.pageDown")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - this.viewportHeight())
      this.tui.requestRender()
      return
    }
    this.input.handleInput(data)
    this.tui.requestRender()
  }

  private viewportHeight(): number {
    const rows = this.tui.terminal.rows || 30
    return Math.max(1, rows - 10)
  }

  render(width: number): string[] {
    const theme = this.theme
    const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)))
    const lines: string[] = []
    const snap = this.snap()

    if (!snap) {
      lines.push(border)
      lines.push(theme.fg("dim", `${this.id} is no longer tracked`))
      lines.push(border)
      return lines
    }

    const rows = this.tui.terminal.rows || 30
    const inputLines = this.input.render(width)
    const compact = rows < 14
    const infoLines = buildSubagentInfoLines(snap, width, theme, this.options)
      .slice(0, compact ? 1 : undefined)
    const help = helpLines(
      `${configuredKeys(this.keybindings, "tui.input.submit")} send · ${configuredKeys(this.keybindings, "app.interrupt")} back · ${configuredKeys(this.keybindings, "app.clear")} abort · ↑/↓ transcript`,
      width,
      compact ? 1 : 2,
    )
    const bodyHeight = Math.max(1, rows - 6 - infoLines.length - inputLines.length - help.length)

    lines.push(border)
    const utilization = formatContextUtilization(snap.usage)
    const header =
      `${statusGlyph(snap, theme)} ` +
      theme.fg("accent", theme.bold(`${snap.id} · ${snap.title}`)) +
      theme.fg("muted", ` · ${statusWord(snap, theme)} · ${formatElapsed(snap)}`) +
      (this.options?.badge ? theme.fg("muted", ` · ${this.options.badge}`) : "") +
      theme.fg("dim", ` · ${snap.backend}: ${snap.meta.modelLabel ?? "?"}`) +
      (utilization ? theme.fg("dim", ` · ${utilization}`) : "")
    lines.push(truncateToWidth(header, width))
    for (const info of infoLines) lines.push(truncateToWidth(info, width))
    lines.push(border)

    const transcript = buildTranscriptLines(snap, width, theme)
    const body: string[] = []
    if (this.actionError) {
      body.push(truncateToWidth(theme.fg("error", `action error: ${sanitizeText(this.actionError)}`), width))
    }
    if (snap.errorText) {
      body.push(...labeledLines("error: ", formatSubagentError(snap.errorText), width, 3).map((line) => theme.fg("error", line)))
    }

    const indicatorRows = this.scrollOffset > 0 ? 1 : 0
    const capacity = Math.max(1, bodyHeight - body.length - indicatorRows)
    const maxOffset = Math.max(0, transcript.length - capacity)
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset
    const end = transcript.length - this.scrollOffset
    const visible = transcript.slice(Math.max(0, end - capacity), end)
    if (visible.length === 0) body.push(theme.fg("dim", "(no output yet)"))
    else body.push(...visible)

    if (this.scrollOffset > 0) {
      body.push(truncateToWidth(theme.fg("dim", `... ${this.scrollOffset} newer lines below · page down`), width))
    }
    while (body.length < bodyHeight) body.push("")
    lines.push(...body.slice(0, bodyHeight))

    lines.push(border)
    lines.push(...inputLines)
    for (const line of help) lines.push(truncateToWidth(theme.fg("dim", line), width))
    lines.push(border)
    return lines
  }

  invalidate(): void {
    this.input.invalidate()
  }
}
