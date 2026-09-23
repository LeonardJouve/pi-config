# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono) — spawn sub-agent sessions in **WezTerm** panes. **Fully non-blocking** — the main agent keeps working while subagents run in the background.

## How It Works

Call `subagent()` and it **returns immediately**. The sub-agent runs in its own WezTerm pane. A small widget above the input shows all running agents with elapsed time. When a sub-agent finishes, its result is **steered back** into the main session as an async notification — triggering a new turn so the agent can process it.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  Scout: Auth (scout)                 running… │
│ 00:45  Research: DB (researcher)           running… │
╰────────────────────────────────────────────────────╯
```

For parallel execution, call `subagent` multiple times — up to the concurrency cap runs at once:

```typescript
subagent({ name: "Scout: Auth", agent: "scout", task: "Analyze auth module" });
subagent({ name: "Scout: DB", agent: "scout", task: "Map database schema" });
// Both return immediately, results steer back independently
```

### Concurrency cap

At most **2** subagents run at the same time (1 orchestrator + 2 children). Extra `subagent` calls are **not rejected** — they are queued FIFO and launched automatically the moment a running subagent finishes, so you can fire off five at once and let the harness serialize them. Queued calls return `status: "queued"` with their position, and their results are delivered exactly like a launched one.

```
╭─ Subagents ────────────────────── 2 running, 2 queued ─╮
│ 00:23  Scout: Auth (scout)                     running… │
│ 00:45  Research: DB (researcher)               running… │
│  --    Scout: API (scout)                       queued… │
│  --    Worker: Tests (worker)                   queued… │
╰─────────────────────────────────────────────────────────╯
```

Change the cap with `PI_SUBAGENT_MAX_CONCURRENT` (minimum 1):

```bash
export PI_SUBAGENT_MAX_CONCURRENT=4
```

`subagent_resume` skips the queue (explicit one-off action) but counts toward the cap.

## Install

```bash
pi install git:github.com/HazAT/pi-interactive-subagents
```

**Requirement:** run pi inside [WezTerm](https://wezfurlong.org/wezterm/) (a terminal emulator with built-in multiplexing). No wrapper needed — just start `pi` in a WezTerm pane.

If your shell startup is slow and subagent commands sometimes get dropped before the prompt is ready, set `PI_SUBAGENT_SHELL_READY_DELAY_MS` to a higher value (defaults to `500`):

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500
```

## What's Included

### Tools & commands

**Main-session tools:**

| Tool                 | Description                                                             |
| -------------------- | ----------------------------------------------------------------------- |
| `subagent`           | Spawn a sub-agent in a dedicated WezTerm pane (async — returns immediately) |
| `subagent_interrupt` | Interrupt a running subagent's current turn (sends Escape)              |
| `subagents_list`     | List available agent definitions                                        |
| `subagent_resume`    | Resume a previous sub-agent session (async)                            |

**Commands:**

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `/iterate`                 | Fork the current session into a subagent for quick fixes |
| `/subagent <agent> <task>` | Spawn a named agent directly         |

**Subagent-only tools** (loaded into each child via `subagent-done.ts`):

| Tool            | Description                                                       |
| --------------- | ----------------------------------------------------------------- |
| `subagent_done` | Self-terminate and return the last assistant message as the result |
| `caller_ping`   | Ask the parent for help and exit; the parent can resume the session |

### Bundled agents

| Agent          | Tools                     | Role                                                            |
| -------------- | ------------------------- | --------------------------------------------------------------- |
| **researcher** | read, bash, write         | Deep investigation & experimentation — verifies facts, reports findings |
| **scout**      | read, bash                | Fast codebase reconnaissance — maps files, patterns, conventions |
| **worker**     | read, bash, write, edit   | Implements a well-scoped task — writes code, tests, commits      |

Subagents inherit the parent session's model (no model is pinned per agent).

Agent discovery follows priority: **project-local** (`.pi/agents/`) > **global** (`~/.pi/agent/agents/`) > **package-bundled**. Override any bundled agent by placing your own version in a higher-priority location.

## Async flow

```
1. Agent calls subagent()          → returns immediately ("started", or "queued" if the cap is hit)
2. Sub-agent runs in a WezTerm pane → widget shows it running (queued items wait for a slot)
3. User keeps chatting              → main session fully interactive
4. Sub-agent finishes               → result steered back as completion/failure,
                                      and the next queued subagent is launched
5. Main agent processes result      → continues with new context
```

Completion messages render with a colored background and are expandable with `Ctrl+O` to show the full summary and session file path.

## Agent definitions

An agent is a Markdown file with YAML frontmatter. The body becomes the sub-agent's role/system prompt (appended when `system-prompt: append`).

```markdown
---
name: scout
description: Fast codebase reconnaissance
tools: read, bash
spawning: false
auto-exit: true
system-prompt: append
---

# Scout
...role instructions (situation / context / role)...
```

Frontmatter fields:

| Field                 | Description                                                                 |
| --------------------- | --------------------------------------------------------------------------- |
| `name`                | Agent name (defaults to filename)                                           |
| `description`         | Shown by `subagents_list`                                                   |
| `tools`               | Comma-separated tool allowlist for the child (control tools are always added) |
| `skill` / `skills`    | Comma-separated skills to load in the child                                 |
| `deny-tools`          | Comma-separated tools to deny in the child                                  |
| `spawning`            | `false` denies the child all subagent-spawning tools                        |
| `auto-exit`           | `true` makes the child shut itself down when its turn completes             |
| `system-prompt`       | `append` (default behavior) or `replace` — how the body is applied          |
| `session-mode`        | `standalone` (default), `lineage-only`, or `fork`                           |
| `cwd`                 | Working directory for the child                                             |
| `disable-model-invocation` | `true` hides the agent from `subagents_list`                           |

### Session modes

- **standalone** — fresh session; the task is handed off as an artifact file.
- **lineage-only** — fresh session that records its parent lineage.
- **fork** — the child inherits the current conversation; the task is passed directly. Trigger per-spawn with `fork: true` (used by `/iterate`).

## Layout

```
index.ts          # extension factory: tools, commands, renderers, per-instance
                  #   runtime state (running map, widget, abort controller)
agents.ts         # agent definition parsing/discovery + spawn-mode resolution
launch.ts         # pure command/env/artifact builders + interrupt resolution
queue.ts          # concurrency cap: FIFO queue of spawns waiting for a slot
widget.ts         # running-subagents widget rendering + lifecycle controller
wezterm.ts        # WezTerm pane control (create/send/read/close, poll for exit)
shell.ts          # shell quoting + exit-sentinel constants
session.ts        # session seeding + result extraction helpers
types.ts          # shared RunningSubagent / SubagentResult types
subagent-done.ts  # child extension: identity widget, subagent_done, caller_ping, auto-exit
test/             # node --test suites for the pure modules
agents/
  researcher.md  scout.md  worker.md
```

## Development

Requires Node 22+ (tests run TypeScript directly via native type stripping).

```bash
npm install   # installs @earendil-works/pi-tui for the widget tests
npm test      # node --test "test/*.test.ts"
```

All mutable runtime state lives inside the extension factory closure — pi
re-invokes the factory on every rebind (session switch, `/reload`), and
`session_shutdown` tears the instance down. Never store runtime state at module
scope or on `globalThis`: it survives rebinds and gets poisoned by shutdown
handlers.
