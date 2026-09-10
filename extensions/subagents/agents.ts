import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export type AgentSource = "package" | "global" | "project";

export interface AgentDefaults {
  tools?: string;
  skills?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

export interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

export interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/** Directories scanned for agent definitions, in increasing priority order. */
export interface AgentSearchDirs {
  /** Agents bundled with this package. */
  bundled: string;
  /** Global agents (under the pi agent config dir). */
  global: string;
  /** Project-local agents (.pi/agents under the working directory). */
  project: string;
}

/** Tools that are gated by `spawning: false` */
export const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagent_interrupt",
  "subagents_list",
  "subagent_resume",
]);

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** Build the default search dirs from the bundled agents directory. */
export function defaultAgentDirs(
  bundledDir: string,
  opts?: { configDir?: string; projectCwd?: string },
): AgentSearchDirs {
  const configDir = opts?.configDir ?? getAgentConfigDir();
  const projectCwd = opts?.projectCwd ?? process.cwd();
  return {
    bundled: bundledDir,
    global: join(configDir, "agents"),
    project: join(projectCwd, ".pi", "agents"),
  };
}

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
export function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

export function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

export function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

export function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

export function parseAgentDefinition(
  content: string,
  fallbackName: string,
): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
    spawning: parseOptionalBoolean(getFrontmatterValue(frontmatter, "spawning")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

/** Search paths for a single agent definition, highest priority first. */
export function agentDefinitionSearchPaths(name: string, dirs: AgentSearchDirs): string[] {
  return [
    join(dirs.project, `${name}.md`),
    join(dirs.global, `${name}.md`),
    join(dirs.bundled, `${name}.md`),
  ];
}

export function discoverAgentDefinitions(dirs: AgentSearchDirs): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const ordered: Array<{ path: string; source: AgentSource }> = [
    { path: dirs.bundled, source: "package" },
    { path: dirs.global, source: "global" },
    { path: dirs.project, source: "project" },
  ];

  for (const { path: dir, source } of ordered) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }

  return [...agents.values()];
}

export function loadAgentDefaults(
  agentName: string,
  dirs: AgentSearchDirs,
): AgentDefinition | null {
  for (const p of agentDefinitionSearchPaths(agentName, dirs)) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }
  return null;
}

export interface ResolvedSubagentPaths {
  effectiveCwd: string | null;
  localAgentDir: string | null;
  effectiveAgentDir: string;
}

/**
 * Resolve the working directory and pi agent config dir for a spawn.
 *
 * Relative `cwd` values are resolved against the pi agent config dir when they
 * come from agent frontmatter, and against the parent process cwd when passed
 * as a tool parameter. Absolute paths (POSIX or Windows) are used as-is.
 */
export function resolveSubagentPaths(
  params: { cwd?: string },
  agentDefs: Pick<AgentDefaults, "cwd"> | null,
  opts: { configDir: string; processCwd: string },
): ResolvedSubagentPaths {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? opts.configDir : opts.processCwd;
  const effectiveCwd = rawCwd
    ? isAbsolute(rawCwd)
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : opts.configDir;
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

/**
 * Default per-cwd session directory used by pi (`<agentDir>/sessions/--<cwd>--`).
 * Created if missing.
 */
export function ensureSessionDir(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

export function resolveEffectiveSessionMode(
  params: { fork?: boolean },
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

export interface LaunchBehavior {
  sessionMode: SubagentSessionMode;
  /** Session mode written into the seeded child session file (null = no seeding). */
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
}

export function resolveLaunchBehavior(
  params: { fork?: boolean },
  agentDefs: AgentDefaults | null,
): LaunchBehavior {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}
