import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { DONE_SENTINEL_REGEX } from "./shell.ts";

export { shellEscape } from "./shell.ts";

const execFileAsync = promisify(execFile);

let weztermAvailable: boolean | null = null;

function hasWeztermCommand(): boolean {
  if (weztermAvailable != null) return weztermAvailable;
  try {
    if (process.platform === "win32") {
      execFileSync("where.exe", ["wezterm"], { stdio: "ignore" });
    } else {
      execFileSync("sh", ["-c", "command -v wezterm"], { stdio: "ignore" });
    }
    weztermAvailable = true;
  } catch {
    weztermAvailable = false;
  }
  return weztermAvailable;
}

/** WezTerm multiplexing is available when we're running inside a WezTerm pane. */
export function isMuxAvailable(): boolean {
  return !!process.env.WEZTERM_UNIX_SOCKET && hasWeztermCommand();
}

export function muxSetupHint(): string {
  return "Start pi inside WezTerm (no wrapper needed — WezTerm has built-in multiplexing).";
}

function requireMux(): void {
  if (!isMuxAvailable()) {
    throw new Error(`WezTerm multiplexing not available. ${muxSetupHint()}`);
  }
}


function tailLines(text: string, lines: number): string {
  const split = text.split("\n");
  if (split.length <= lines) return text;
  return split.slice(-lines).join("\n");
}

/**
 * Create a new WezTerm pane (split to the right) for a subagent.
 * Returns the pane id (a numeric string).
 */
export function createSurface(name: string): string {
  requireMux();
  const args = ["cli", "split-pane", "--right", "--cwd", process.cwd()];
  const paneId = execFileSync("wezterm", args, { encoding: "utf8" }).trim();
  if (!paneId || !/^\d+$/.test(paneId)) {
    throw new Error(`Unexpected wezterm split-pane output: ${paneId || "(empty)"}`);
  }
  try {
    execFileSync("wezterm", ["cli", "set-tab-title", "--pane-id", paneId, name], {
      encoding: "utf8",
    });
  } catch {
    // Optional — tab title is cosmetic.
  }
  return paneId;
}

/** Send a command string to a pane and execute it. */
export function sendCommand(surface: string, command: string): void {
  requireMux();
  execFileSync(
    "wezterm",
    ["cli", "send-text", "--pane-id", surface, "--no-paste", command + "\n"],
    { encoding: "utf8" },
  );
}

/** Send one Escape keypress to a pane. */
export function sendEscape(surface: string): void {
  requireMux();
  execFileSync("wezterm", ["cli", "send-text", "--pane-id", surface, "--no-paste", "\u001b"], {
    encoding: "utf8",
  });
}

/**
 * Send a command to a pane via bracketed paste mode.
 * The command is pasted atomically — no temp script files needed,
 * avoiding Windows backslash-path bugs and leftover files on disk.
 */
export function sendPaste(surface: string, command: string): void {
  requireMux();
  execFileSync(
    "wezterm",
    ["cli", "send-text", "--pane-id", surface, command + "\n"],
    { encoding: "utf8" },
  );
}

/** Read the screen contents of a pane (async). */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireMux();
  const { stdout } = await execFileAsync("wezterm", ["cli", "get-text", "--pane-id", surface], {
    encoding: "utf8",
  });
  return tailLines(stdout, lines);
}

/** Close a pane. */
export function closeSurface(surface: string): void {
  requireMux();
  execFileSync("wezterm", ["cli", "kill-pane", "--pane-id", surface], { encoding: "utf8" });
}

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "ping" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Ping data if reason is "ping" */
  ping?: { name: string; message: string };
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by subagent_done / caller_ping /
 * the error path in subagent-done.ts).
 */
export function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "ping") {
    return {
      reason: "ping",
      exitCode: 0,
      ping: { name: data.name, message: data.message },
    };
  }
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

/**
 * Read and consume the `.exit` sidecar file for a session, if present.
 * Returns null when there is no (readable) sidecar.
 */
export function readExitSidecar(sessionFile: string): PollResult | null {
  const exitFile = `${sessionFile}.exit`;
  try {
    if (!existsSync(exitFile)) return null;
    const data = JSON.parse(readFileSync(exitFile, "utf8"));
    rmSync(exitFile, { force: true });
    return interpretExitSidecar(data);
  } catch {
    return null;
  }
}

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by subagent_done / caller_ping), falling back to the terminal
 * sentinel for crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by subagent_done / caller_ping)
    if (options.sessionFile) {
      const sidecar = readExitSidecar(options.sessionFile);
      if (sidecar) return sidecar;
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(DONE_SENTINEL_REGEX);
      if (match) {
        return { reason: "done", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        const sidecar = readExitSidecar(options.sessionFile);
        if (sidecar) return sidecar;
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
