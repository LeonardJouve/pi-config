import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  sendPaste,
  pollForExit,
  closeSurface,
  sendEscape,
} from "./wezterm.ts";
import {
  defaultAgentDirs,
  discoverAgentDefinitions,
  ensureSessionDir,
  getAgentConfigDir,
  loadAgentDefaults,
  resolveDenyTools,
  resolveLaunchBehavior,
  resolveSubagentPaths,
} from "./agents.ts";
import {
  buildLaunchCommand,
  buildPiArgv,
  buildPiPromptArgs,
  buildSubagentEnv,
  buildSubagentToolAllowlist,
  formatElapsed,
  getArtifactDir,
  getShellReadyDelayMs,
  handleSubagentInterrupt,
  resolveResultPresentation,
  writeResumeMessageArtifact,
  writeSystemPromptArtifact,
  writeTaskArtifact,
} from "./launch.ts";
import { createWidgetController, type WidgetController } from "./widget.ts";
import type { RunningSubagent, SubagentResult } from "./types.ts";
import {
  countEntries,
  findLastAssistantMessage,
  getNewEntries,
  seedSubagentSessionFile,
} from "./session.ts";

/** Absolute path to this extension's directory. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load defaults from (e.g. 'worker', 'scout', 'researcher'). Reads ~/.pi/agent/agents/<name>.md for tools, skills, role.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Appended to system prompt (role instructions)" }),
  ),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills (overrides agent default)" }),
  ),
  tools: Type.Optional(
    Type.String({ description: "Comma-separated tools (overrides agent default)" }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Force the full-context fork mode for this spawn. The sub-agent inherits the current session conversation, overriding any agent frontmatter session-mode.",
    }),
  ),
});

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require WezTerm. ${muxSetupHint()}`,
      },
    ],
    details: { error: "mux not available" },
  };
}

function randomId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * The extension factory.
 *
 * IMPORTANT: pi re-invokes this factory whenever extensions are rebound
 * (session switch, /reload without re-import, trust resolution). All mutable
 * runtime state MUST live inside the factory closure — module-level or
 * globalThis state survives rebinds and gets poisoned by session_shutdown
 * handlers (previously an aborted AbortController on globalThis killed every
 * later spawn instantly).
 */
export default function subagentsExtension(pi: ExtensionAPI) {
  // ── Per-instance state ──

  /** All currently running subagents, keyed by id. */
  const runningSubagents = new Map<string, RunningSubagent>();

  /** Latest ExtensionContext from session_start, used for widget updates. */
  let latestCtx: ExtensionContext | null = null;

  /** Aborted on session_shutdown to stop all watchers belonging to this instance. */
  let instanceAbort = new AbortController();

  const agentDirs = defaultAgentDirs(join(SUBAGENTS_DIR, "../../agents"));

  function ensureInstanceArmed(): void {
    if (instanceAbort.signal.aborted) {
      instanceAbort = new AbortController();
    }
  }

  const widget: WidgetController = createWidgetController({
    getAgents: () => [...runningSubagents.values()],
    setWidget: (id, factory) => {
      if (!latestCtx?.hasUI) return;
      latestCtx.ui.setWidget(id, factory as any, { placement: "aboveEditor" });
    },
  });

  /** Refresh the widget; stop the refresh timer once nothing is running. */
  function syncWidget(): void {
    widget.refresh();
    if (runningSubagents.size === 0) {
      widget.stop();
    }
  }

  // ── Lifecycle ──

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    ensureInstanceArmed();
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    widget.stop();
    latestCtx = null;
    instanceAbort.abort();
    for (const agent of runningSubagents.values()) {
      agent.abortController?.abort();
    }
    runningSubagents.clear();
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const shouldRegister = (name: string) => !deniedTools.has(name);

  // ── Launch & watch ──

  /**
   * Launch a subagent: creates the WezTerm pane, builds the pi command, and
   * sends it. Returns a RunningSubagent — does NOT poll.
   *
   * Call watchSubagent() on the returned object to observe completion.
   */
  async function launchSubagent(
    params: Static<typeof SubagentParams>,
    ctx: ExtensionContext,
    options?: { surface?: string },
  ): Promise<RunningSubagent> {
    const startTime = Date.now();
    const id = randomId();

    const agentDefs = params.agent ? loadAgentDefaults(params.agent, agentDirs) : null;
    const effectiveTools = params.tools ?? agentDefs?.tools;
    const effectiveSkills = params.skills ?? agentDefs?.skills;

    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("No session file");
    const sessionId = ctx.sessionManager.getSessionId();
    const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

    const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(
      params,
      agentDefs,
      { configDir: getAgentConfigDir(), processCwd: process.cwd() },
    );
    const targetCwdForSession = effectiveCwd ?? ctx.cwd;
    const sessionDir = ensureSessionDir(targetCwdForSession, effectiveAgentDir);

    // Generate a unique session file path for this subagent.
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
    const subagentSessionFile = join(sessionDir, `${timestamp}_${randomUUID()}.jsonl`);

    // Use pre-created surface (parallel mode) or create a new one.
    const surfacePreCreated = !!options?.surface;
    const surface = options?.surface ?? createSurface(params.name);
    if (!surfacePreCreated) {
      await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
    }

    const launchBehavior = resolveLaunchBehavior(params, agentDefs);

    if (launchBehavior.seededSessionMode) {
      seedSubagentSessionFile({
        mode: launchBehavior.seededSessionMode,
        parentSessionFile: sessionFile,
        childSessionFile: subagentSessionFile,
        childCwd: targetCwdForSession,
      });
    }

    const { inheritsConversationContext } = launchBehavior;

    // Build the task message.
    // Only full-context fork mode inherits prior conversation state.
    // Blank-session modes need the wrapper instructions and artifact-backed handoff.
    const modeHint = agentDefs?.autoExit
      ? "Complete your task autonomously."
      : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
    const summaryInstruction = agentDefs?.autoExit
      ? "Your FINAL assistant message should summarize what you accomplished."
      : "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
    const denySet = resolveDenyTools(agentDefs);
    const identity = agentDefs?.body ?? params.systemPrompt ?? null;
    const systemPromptMode = agentDefs?.systemPromptMode;
    const identityInSystemPrompt = systemPromptMode && identity;
    const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
    const fullTask = inheritsConversationContext
      ? params.task
      : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;

    // Pass agent body as system prompt via file to avoid shell escaping issues
    // with multiline content. Pi's --append-system-prompt and --system-prompt
    // auto-detect file paths and read their contents.
    let systemPromptFlag: "--system-prompt" | "--append-system-prompt" | undefined;
    let systemPromptPath: string | undefined;
    if (identityInSystemPrompt && identity) {
      systemPromptFlag = systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
      systemPromptPath = writeSystemPromptArtifact(artifactDir, params.name, identity);
    }

    // Pass task and skill prompts to the sub-agent.
    // Only full-context fork mode gets a direct task argument because it already
    // inherits the parent conversation. Blank-session modes use artifact-backed
    // handoff so the wrapper instructions arrive as the initial user message.
    let taskArg: string;
    if (launchBehavior.taskDelivery === "direct") {
      taskArg = fullTask;
    } else {
      taskArg = `@${writeTaskArtifact(artifactDir, params.name, fullTask)}`;
    }

    const argv = buildPiArgv({
      sessionFile: subagentSessionFile,
      extensionPath: join(SUBAGENTS_DIR, "subagent-done.ts"),
      systemPromptFlag,
      systemPromptPath,
      toolAllowlist: buildSubagentToolAllowlist(effectiveTools),
      promptArgs: buildPiPromptArgs({
        effectiveSkills,
        taskDelivery: launchBehavior.taskDelivery,
        taskArg,
      }),
    });

    const env = buildSubagentEnv({
      path: process.env.PATH,
      // Prefer a project-local .pi/agent dir under the child cwd; otherwise
      // forward the parent's explicit override (if any).
      agentDir:
        localAgentDir && existsSync(localAgentDir)
          ? localAgentDir
          : process.env.PI_CODING_AGENT_DIR,
      denyTools: denySet,
      name: params.name,
      agent: params.agent,
      autoExit: agentDefs?.autoExit,
      sessionFile: subagentSessionFile,
      surface,
    });

    sendPaste(surface, buildLaunchCommand({ cwd: effectiveCwd, env, argv }));

    const running: RunningSubagent = {
      id,
      name: params.name,
      task: params.task,
      agent: params.agent,
      surface,
      startTime,
      sessionFile: subagentSessionFile,
    };

    runningSubagents.set(id, running);
    return running;
  }

  /**
   * Watch a launched subagent until it exits. Polls for completion, extracts
   * the summary from the session file, cleans up the surface, and removes the
   * entry from runningSubagents.
   */
  async function watchSubagent(
    running: RunningSubagent,
    signal: AbortSignal,
  ): Promise<{ result: SubagentResult }> {
    const { name, task, surface, startTime, sessionFile } = running;

    const finish = (): void => {
      try {
        closeSurface(surface);
      } catch {
        // Surface may already be gone — nothing to clean up.
      }
      runningSubagents.delete(running.id);
      syncWidget();
    };

    try {
      const pollResult = await pollForExit(
        surface,
        AbortSignal.any([signal, instanceAbort.signal]),
        { interval: 1000, sessionFile },
      );

      const elapsed = Math.floor((Date.now() - startTime) / 1000);

      let summary: string;
      if (existsSync(sessionFile)) {
        const allEntries = getNewEntries(sessionFile, 0);
        summary =
          findLastAssistantMessage(allEntries) ??
          (pollResult.errorMessage
            ? `Subagent error: ${pollResult.errorMessage}`
            : pollResult.exitCode !== 0
              ? `Sub-agent exited with code ${pollResult.exitCode}`
              : "Sub-agent exited without output");
      } else {
        summary = pollResult.errorMessage
          ? `Subagent error: ${pollResult.errorMessage}`
          : pollResult.exitCode !== 0
            ? `Sub-agent exited with code ${pollResult.exitCode}`
            : "Sub-agent exited without output";
      }

      finish();

      return {
        result: {
          name,
          task,
          summary,
          sessionFile,
          exitCode: pollResult.exitCode,
          elapsed,
          ping: pollResult.ping,
          ...(pollResult.errorMessage ? { errorMessage: pollResult.errorMessage } : {}),
        },
      };
    } catch (err: any) {
      finish();

      if (signal.aborted || instanceAbort.signal.aborted) {
        return {
          result: {
            name,
            task,
            summary: "Subagent cancelled.",
            exitCode: 1,
            elapsed: Math.floor((Date.now() - startTime) / 1000),
            error: "cancelled",
            sessionFile,
          },
        };
      }
      return {
        result: {
          name,
          task,
          summary: `Subagent error: ${err?.message ?? String(err)}`,
          exitCode: 1,
          elapsed: Math.floor((Date.now() - startTime) / 1000),
          error: err?.message ?? String(err),
        },
      };
    }
  }

  /** Deliver a finished (or pinged) subagent result back into the parent session. */
  function deliverResult(running: RunningSubagent, result: SubagentResult): void {
    if (result.ping) {
      const sessionRef = result.sessionFile
        ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
        : "";
      pi.sendMessage(
        {
          customType: "subagent_ping",
          content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
          display: true,
          details: {
            name: result.ping.name,
            message: result.ping.message,
            agent: running.agent,
            sessionFile: result.sessionFile,
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
      return;
    }

    pi.sendMessage(
      {
        customType: "subagent_result",
        content: resolveResultPresentation(result, running.name),
        display: true,
        details: {
          name: running.name,
          task: running.task,
          agent: running.agent,
          exitCode: result.exitCode,
          elapsed: result.elapsed,
          sessionFile: result.sessionFile,
          ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  }

  /** Start the background watcher for a freshly launched subagent. */
  function watchAndDeliver(running: RunningSubagent): void {
    // Separate AbortController for the watcher (the tool's signal completes
    // when the tool returns).
    const watcherAbort = new AbortController();
    running.abortController = watcherAbort;
    widget.start();

    watchSubagent(running, watcherAbort.signal)
      .then(({ result }) => deliverResult(running, result))
      .catch((err) => {
        syncWidget();
        pi.sendMessage(
          {
            customType: "subagent_result",
            content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
            display: true,
            details: { name: running.name, task: running.task, error: err?.message },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      });
  }

  // ── subagent tool ──

  const SUBAGENT_TOOL_DESCRIPTION =
    "Spawn a sub-agent in a dedicated WezTerm pane. " +
    "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
    "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
    "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
    "DO NOT fabricate, assume, or summarize results after calling this tool. " +
    "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.";

  if (shouldRegister("subagent"))
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: SUBAGENT_TOOL_DESCRIPTION,
      promptSnippet: SUBAGENT_TOOL_DESCRIPTION,
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Prevent self-spawning (e.g. worker spawning another worker)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // A rebind without session_start (shouldn't happen, but be safe):
        // never watch on an aborted instance controller.
        ensureInstanceArmed();

        // Launch the subagent (creates pane, sends command)
        const running = await launchSubagent(params, ctx);

        // Fire-and-forget: start watching in background
        watchAndDeliver(running);

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const name =
          typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        const agent =
          typeof partialArgs.agent === "string" && partialArgs.agent
            ? theme.fg("dim", ` (${partialArgs.agent})`)
            : "";
        const cwdHint =
          typeof partialArgs.cwd === "string" && partialArgs.cwd
            ? theme.fg("dim", ` in ${partialArgs.cwd}`)
            : "";
        let text = "▸ " + theme.fg("toolTitle", theme.bold(name)) + agent + cwdHint;

        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagent_interrupt tool ──

  const INTERRUPT_DESCRIPTION =
    "Send Escape to the active turn of a currently running subagent. " +
    "The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
    "and does not emit a subagent_result solely because of this request.";

  if (shouldRegister("subagent_interrupt"))
    pi.registerTool({
      name: "subagent_interrupt",
      label: "Interrupt Subagent",
      description: INTERRUPT_DESCRIPTION,
      promptSnippet: INTERRUPT_DESCRIPTION,
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
      }),

      async execute(_toolCallId, params) {
        const result = handleSubagentInterrupt(params, runningSubagents.values(), sendEscape);
        if (result.details?.status === "interrupt_requested") {
          syncWidget();
        }
        return result;
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : args.name ?? "(unknown)";
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — interrupt turn"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.status === "interrupt_requested") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
              theme.fg("dim", " — interrupt requested"),
            0,
            0,
          );
        }

        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_list tool ──

  const LIST_DESCRIPTION =
    "List all available subagent definitions. " +
    "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
    "Project-local agents override global ones with the same name.";

  if (shouldRegister("subagents_list"))
    pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description: LIST_DESCRIPTION,
      promptSnippet: LIST_DESCRIPTION,
      parameters: Type.Object({}),

      async execute() {
        const list = discoverAgentDefinitions(agentDirs).filter(
          (agent) => !agent.disableModelInvocation,
        );

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          return `• ${a.name}${badge}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });

  // ── subagent_resume tool ──

  const RESUME_DESCRIPTION =
    "Resume a previous sub-agent session in a new WezTerm pane. " +
    "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
    "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
    "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
    "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you with the result when it is ready. " +
    "Use when a sub-agent was cancelled or needs follow-up work.";

  if (shouldRegister("subagent_resume"))
    pi.registerTool({
      name: "subagent_resume",
      label: "Resume Subagent",
      description: RESUME_DESCRIPTION,
      promptSnippet: RESUME_DESCRIPTION,
      parameters: Type.Object({
        sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
        name: Type.Optional(
          Type.String({ description: "Display name for the terminal tab. Default: 'Resume'" }),
        ),
        message: Type.Optional(
          Type.String({
            description: "Optional message to send after resuming (e.g. follow-up instructions)",
          }),
        ),
        autoExit: Type.Optional(
          Type.Boolean({
            description:
              "Whether the resumed session should automatically exit after completing its response. Defaults to true for autonomous follow-up work; set false for interactive resumed sessions.",
          }),
        ),
      }),

      renderCall(args, theme) {
        const name = args.name ?? "Resume";
        const text =
          "▸ " + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " — resuming session");
        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "Resume";

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const name = params.name ?? "Resume";
        const autoExit = params.autoExit ?? true;
        const startTime = Date.now();
        const id = randomId();

        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!existsSync(params.sessionPath)) {
          return {
            content: [
              { type: "text", text: `Error: session file not found: ${params.sessionPath}` },
            ],
            details: { error: "session not found" },
          };
        }

        ensureInstanceArmed();

        // Record entry count before resuming so we can extract new messages
        const entryCountBefore = countEntries(params.sessionPath);

        const surface = createSurface(name);
        await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

        const sessionId = ctx.sessionManager.getSessionId();
        const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

        const promptArgs: string[] = [];
        if (params.message) {
          const resumeMsgFile = writeResumeMessageArtifact(artifactDir, name, params.message);
          promptArgs.push(`@${resumeMsgFile}`);
        }

        const argv = buildPiArgv({
          sessionFile: params.sessionPath,
          extensionPath: join(SUBAGENTS_DIR, "subagent-done.ts"),
          promptArgs,
        });

        const env = buildSubagentEnv({
          path: process.env.PATH,
          agentDir: process.env.PI_CODING_AGENT_DIR,
          name,
          autoExit,
          sessionFile: params.sessionPath,
        });

        sendPaste(surface, buildLaunchCommand({ env, argv }));

        // Register as a running subagent for widget tracking
        const running: RunningSubagent = {
          id,
          name,
          task: params.message ?? "resumed session",
          surface,
          startTime,
          sessionFile: params.sessionPath,
        };
        runningSubagents.set(id, running);

        // Fire-and-forget watcher — same delivery path as spawn, but the
        // summary only includes entries appended after the resume point.
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;
        widget.start();

        watchSubagent(running, watcherAbort.signal)
          .then((watched) => {
            let result = watched.result;
            if (!result.ping && existsSync(params.sessionPath)) {
              const newEntries = getNewEntries(params.sessionPath, entryCountBefore);
              const summary =
                findLastAssistantMessage(newEntries) ??
                (result.errorMessage
                  ? `Subagent error: ${result.errorMessage}`
                  : result.exitCode !== 0
                    ? `Resumed session exited with code ${result.exitCode}`
                    : "Resumed session exited without new output");
              result = { ...result, summary };
            }
            deliverResult(running, result);
          })
          .catch((err) => {
            syncWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Resume error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: {
            id,
            name,
            sessionPath: params.sessionPath,
            status: "started",
          },
        };
      },
    });

  // ── Commands ──

  // /iterate command — fork the session into a subagent
  pi.registerCommand("iterate", {
    description: "Fork session into a subagent for focused work (bugfixes, iteration)",
    handler: async (args, ctx) => {
      const task = args.trim() || "";
      const toolCall = task
        ? `Use subagent to fork a session. fork: true, name: "Iterate", task: ${JSON.stringify(task)}`
        : `Use subagent to fork a session. fork: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName, agentDirs);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const status = errorMessage
          ? "failed (provider/agent error)"
          : failed
            ? `failed (exit ${exitCode})`
            : "completed";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove session ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nSession: .+\nResume: .+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

        const contentLines = [header];

        if (options.expanded) {
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
            contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
          }
        } else {
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_ping message renderer ──
  pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.message ?? "");
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
          }
        } else {
          const preview = (details.message ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });
}
