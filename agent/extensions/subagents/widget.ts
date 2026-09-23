import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatElapsedMMSS } from "./launch.ts";

export const WIDGET_ID = "subagent-status";

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

export interface WidgetAgent {
  name: string;
  agent?: string;
  startTime: number;
  /** Waiting for a free concurrency slot instead of actually running. */
  queued?: boolean;
}

/** Minimal component contract expected by ctx.ui.setWidget factories. */
export interface WidgetComponent {
  invalidate(): void;
  render(width: number): string[];
}

export type WidgetFactory = (tui: unknown, theme: unknown) => WidgetComponent;

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
export function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  const contentWidth = Math.max(0, width - 2);
  const rightVis = visibleWidth(right);

  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/** Build the bordered top line: ╭─ Title ──── info ─╮ */
export function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  const inner = Math.max(0, width - 2);
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/** Build the bordered bottom line: ╰──────────────────╯ */
export function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

export function renderSubagentWidgetLines(agents: WidgetAgent[], width: number): string[] {
  const queued = agents.filter((agent) => agent.queued).length;
  const running = agents.length - queued;
  const title = "Subagents";
  const info = queued > 0 ? `${running} running, ${queued} queued` : `${running} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    if (agent.queued) {
      lines.push(borderLine(` --  ${agent.name}${agentTag} `, " queued… ", width));
      continue;
    }
    const elapsed = formatElapsedMMSS(agent.startTime);
    const left = ` ${elapsed}  ${agent.name}${agentTag} `;
    lines.push(borderLine(left, " running… ", width));
  }

  lines.push(borderBottom(width));
  return lines;
}

export interface WidgetController {
  /** Re-render immediately: clears the widget when no agents are running. */
  refresh(): void;
  /** Start the 1s refresh interval (idempotent). Renders immediately. */
  start(): void;
  /** Stop the refresh interval (idempotent). */
  stop(): void;
}

/**
 * Widget lifecycle controller. All state lives in the closure — nothing is
 * stored at module scope or on globalThis, so extension rebinds (session
 * switch, /reload) always start from a clean slate.
 */
export function createWidgetController(deps: {
  getAgents(): WidgetAgent[];
  setWidget(id: string, factory: WidgetFactory | undefined): void;
  intervalMs?: number;
  now?: () => number;
}): WidgetController {
  let interval: ReturnType<typeof setInterval> | null = null;
  const intervalMs = deps.intervalMs ?? 1000;

  function refresh(): void {
    if (deps.getAgents().length === 0) {
      deps.setWidget(WIDGET_ID, undefined);
      return;
    }
    deps.setWidget(WIDGET_ID, () => ({
      invalidate() {},
      render(width: number) {
        return renderSubagentWidgetLines(deps.getAgents(), width);
      },
    }));
  }

  return {
    refresh,
    start() {
      if (interval) return;
      refresh(); // immediate first render
      interval = setInterval(refresh, intervalMs);
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
