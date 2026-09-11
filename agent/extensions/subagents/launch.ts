import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DONE_SENTINEL_PREFIX, DONE_SENTINEL_SUFFIX, shellEscape, isWindows } from "./shell.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";

/**
 * Child control tools from subagent-done.ts. Pi applies --tools to built-in,
 * extension, and custom tools. If a subagent definition restricts tools, these
 * must stay allowed or the child cannot report completion.
 */
export const SUBAGENT_CONTROL_TOOLS = ["caller_ping", "subagent_done"] as const;

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

export function formatElapsedMMSS(startTime: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startTime) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function safeScriptName(name: string, fallback = "subagent"): string {
  return (
    (name || fallback)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || fallback
  );
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 * Configurable for environments that do extra shell-init work before the
 * prompt is ready. Defaults to 500ms.
 */
export function getShellReadyDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

/**
 * Internal artifact directory path for a session.
 * Path convention: <sessionDir>/artifacts/<session-id>/
 */
export function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

export function buildSubagentToolAllowlist(effectiveTools?: string): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  if (requested.length === 0) return null;

  const allow = new Set(requested);
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..].
 */
export function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [...(needsSeparator ? [""] : []), ...skillPrompts, params.taskArg];
}

/**
 * Write the full task text to a content-addressed artifact file and return its
 * path. The child pi receives `@<path>` so multiline tasks survive shell quoting.
 */
export function writeTaskArtifact(artifactDir: string, name: string, task: string): string {
  const hash = createHash("sha256").update(task).digest("hex").slice(0, 16);
  const artifactPath = join(artifactDir, "context", `${safeScriptName(name)}-${hash}.md`);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, task, "utf8");
  return artifactPath;
}

/**
 * Write the agent identity/system prompt to a content-addressed artifact file
 * and return its path. Existing files are left untouched (content-addressed,
 * so same content = same path).
 */
export function writeSystemPromptArtifact(
  artifactDir: string,
  name: string,
  identity: string,
): string {
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  const syspromptPath = join(
    artifactDir,
    "context",
    `${safeScriptName(name)}-sysprompt-${hash}.md`,
  );
  if (!existsSync(syspromptPath)) {
    mkdirSync(dirname(syspromptPath), { recursive: true });
    writeFileSync(syspromptPath, identity, "utf8");
  }
  return syspromptPath;
}

/**
 * Write a resume follow-up message to a content-addressed artifact file and
 * return its path. Existing files are left untouched.
 */
export function writeResumeMessageArtifact(
  artifactDir: string,
  name: string,
  message: string,
): string {
  const hash = createHash("sha256").update(message).digest("hex").slice(0, 16);
  const resumeMsgFile = join(
    artifactDir,
    "subagent-resume",
    `${safeScriptName(name, "resume")}-${hash}.md`,
  );
  if (!existsSync(resumeMsgFile)) {
    mkdirSync(dirname(resumeMsgFile), { recursive: true });
    writeFileSync(resumeMsgFile, message, "utf8");
  }
  return resumeMsgFile;
}

/** Ordered environment assignments for a child pi launch. `undefined` values are skipped. */
export function buildSubagentEnv(input: {
  path?: string;
  /** Resolved PI_CODING_AGENT_DIR override (local project dir or forwarded parent value). */
  agentDir?: string | null;
  denyTools?: Iterable<string>;
  name: string;
  agent?: string;
  autoExit?: boolean;
  sessionFile: string;
  surface?: string;
}): Record<string, string | undefined> {
  const denied = [...(input.denyTools ?? [])];
  return {
    PATH: input.path,
    PI_CODING_AGENT_DIR: input.agentDir ?? undefined,
    PI_DENY_TOOLS: denied.length > 0 ? denied.join(",") : undefined,
    PI_SUBAGENT_NAME: input.name,
    PI_SUBAGENT_AGENT: input.agent,
    PI_SUBAGENT_AUTO_EXIT: input.autoExit ? "1" : undefined,
    PI_SUBAGENT_SESSION: input.sessionFile,
    PI_SUBAGENT_SURFACE: input.surface,
  };
}

/** Build the escaped pi argv (tokens are shell-escaped where needed). */
export function buildPiArgv(opts: {
  sessionFile: string;
  extensionPath: string;
  systemPromptFlag?: "--system-prompt" | "--append-system-prompt";
  systemPromptPath?: string;
  toolAllowlist?: string | null;
  promptArgs: string[];
}): string[] {
  const argv = [
    "pi",
    "--session",
    shellEscape(opts.sessionFile),
    "-e",
    shellEscape(opts.extensionPath),
  ];
  if (opts.systemPromptFlag && opts.systemPromptPath) {
    argv.push(opts.systemPromptFlag, shellEscape(opts.systemPromptPath));
  }
  if (opts.toolAllowlist) {
    argv.push("--tools", shellEscape(opts.toolAllowlist));
  }
  for (const arg of opts.promptArgs) {
    argv.push(shellEscape(arg));
  }
  return argv;
}

/** Result from `buildLaunchCommand` on Windows (batch file approach). */
export interface LaunchCommandResult {
  /** The short one-liner sent to the pane (the batch file path in quotes). */
  command: string;
  /** Absolute path to the temporary batch file, for cleanup. */
  batchFile: string;
}

/**
 * Assemble the full shell command sent to the child pane:
 * optional cd, env assignments, argv, and the exit sentinel echo.
 *
 * Detects the platform and generates syntax appropriate for the default
 * shell: bash/zsh on POSIX, cmd.exe on Windows.
 *
 * On POSIX returns a plain command string.
 * On Windows returns `{ command, batchFile }` — the batch file handles
 * reliable `%ERRORLEVEL%` capture and avoids cmd.exe's line-length limit.
 */
export function buildLaunchCommand(opts: {
  cwd?: string | null;
  env: Record<string, string | undefined>;
  argv: string[];
}): string | LaunchCommandResult {
  if (isWindows) {
    return buildCmdLaunchCommand(opts);
  }
  return buildPosixLaunchCommand(opts);
}

/** POSIX (bash/zsh/sh) command assembly: `VAR=val cmd; echo sentinel`. */
function buildPosixLaunchCommand(opts: {
  cwd?: string | null;
  env: Record<string, string | undefined>;
  argv: string[];
}): string {
  const envParts: string[] = [];
  for (const [key, value] of Object.entries(opts.env)) {
    if (value === undefined) continue;
    envParts.push(`${key}=${shellEscape(value)}`);
  }
  const envPrefix = envParts.length > 0 ? envParts.join(" ") + " " : "";
  const cdPrefix = opts.cwd ? `cd ${shellEscape(opts.cwd)} && ` : "";
  return (
    `${cdPrefix}${envPrefix}${opts.argv.join(" ")}` +
    `; echo '${DONE_SENTINEL_PREFIX}'$?'${DONE_SENTINEL_SUFFIX}'`
  );
}

/**
 * cmd.exe command assembly via a temporary batch file.
 *
 * A batch file avoids two cmd.exe pitfalls:
 *   1. `%ERRORLEVEL%` in a `&&` chain is expanded at parse time, giving the
 *      wrong exit code.  Inside a batch file, `call` runs the command and
 *      `set __rc__=%ERRORLEVEL%` on the *next line* reads it correctly
 *      because batch files parse line-by-line.
 *   2. Extremely long one-liners (PATH + argv) hit cmd.exe's ~8191-char
 *      command-line limit.  A batch file has no such limit.
 *
 * Returns `{ command, batchFile }`.
 * `command` is the short one-liner sent to the pane (just the batch path).
 * `batchFile` is the absolute path so the caller can clean it up.
 */
export function buildCmdLaunchCommand(opts: {
  cwd?: string | null;
  env: Record<string, string | undefined>;
  argv: string[];
}): { command: string; batchFile: string } {
  const batchFile = join(tmpdir(), `pi-subagent-${randomUUID()}.bat`);

  const lines: string[] = ["@echo off"];

  if (opts.cwd) {
    lines.push(`cd /d ${opts.cwd}`);
  }

  // Env values are written raw — batch `set` treats everything after `=`
  // as the literal value, so no shell-escaping is needed.
  for (const [key, value] of Object.entries(opts.env)) {
    if (value === undefined) continue;
    lines.push(`set ${key}=${value}`);
  }

  // `call` invokes pi (handles pi.cmd/.bat correctly) and returns control
  // to the next line where %ERRORLEVEL% holds pi's exit code.
  lines.push(`call ${opts.argv.join(" ")}`);
  lines.push(`set __rc__=%ERRORLEVEL%`);

  // The echo and del lines are parsed after `call` finishes, so
  // %__rc__% is expanded at that point with the correct value.
  lines.push(
    `echo ${DONE_SENTINEL_PREFIX}%__rc__%${DONE_SENTINEL_SUFFIX}`,
  );
  // Self-cleanup; `2>nul` suppresses errors if the file is locked.
  lines.push(`del "%~f0" 2>nul`);

  writeFileSync(batchFile, lines.join("\r\n"), "utf8");
  return { command: `"${batchFile}"`, batchFile };
}

export function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage"
  >,
  name: string,
): string {
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
    : "";

  if (result.errorMessage) {
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_resume.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

export function resolveInterruptTarget(
  params: { id?: string; name?: string },
  running: Iterable<RunningSubagent>,
): { running: RunningSubagent } | { error: string } {
  const all = [...running];

  const requestedId = params.id?.trim();
  if (requestedId) {
    const running = all.find((entry) => entry.id === requestedId);
    return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
  }

  const requestedName = params.name?.trim();
  if (!requestedName) {
    return { error: "Provide a running subagent id or exact display name." };
  }

  const matches = all.filter((entry) => entry.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    return { error: `No running subagent named "${requestedName}".` };
  }

  const candidates = matches.map((entry) => `${entry.name} [${entry.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

export function requestSubagentInterrupt(
  running: RunningSubagent,
  sendEscapeKey: (surface: string) => void,
): { ok: true } | { error: string } {
  try {
    sendEscapeKey(running.surface);
    return { ok: true };
  } catch (error: any) {
    return {
      error:
        `Failed to send Escape to subagent "${running.name}" via wezterm: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

export function handleSubagentInterrupt(
  params: { id?: string; name?: string },
  running: Iterable<RunningSubagent>,
  sendEscapeKey: (surface: string) => void,
): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  const resolved = resolveInterruptTarget(params, running);
  if ("error" in resolved) {
    return {
      content: [{ type: "text", text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const target = resolved.running;
  const interruption = requestSubagentInterrupt(target, sendEscapeKey);
  if ("error" in interruption) {
    return {
      content: [{ type: "text", text: interruption.error }],
      details: { error: interruption.error, id: target.id, name: target.name },
    };
  }

  return {
    content: [{ type: "text", text: `Interrupt requested for subagent "${target.name}".` }],
    details: { id: target.id, name: target.name, status: "interrupt_requested" },
  };
}
