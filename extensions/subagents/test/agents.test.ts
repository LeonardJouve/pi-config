import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SPAWNING_TOOLS,
  defaultAgentDirs,
  discoverAgentDefinitions,
  ensureSessionDir,
  loadAgentDefaults,
  parseAgentDefinition,
  resolveDenyTools,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveSubagentPaths,
  type AgentSearchDirs,
} from "../agents.ts";

function makeTempDirs(): { dirs: AgentSearchDirs; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "subagents-test-"));
  const dirs: AgentSearchDirs = {
    bundled: join(root, "bundled"),
    global: join(root, "global"),
    project: join(root, "project"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  return { dirs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeAgent(dir: string, file: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content, "utf8");
}

const FULL_AGENT = `---
name: tester
description: Test agent
tools: read, bash
skills: alpha, beta
deny-tools: write
spawning: false
auto-exit: true
system-prompt: replace
session-mode: fork
cwd: workdir
disable-model-invocation: true
---

# Tester

Role body.
`;

test("parseAgentDefinition parses all frontmatter fields", () => {
  const parsed = parseAgentDefinition(FULL_AGENT, "fallback");
  assert.ok(parsed);
  assert.equal(parsed.name, "tester");
  assert.equal(parsed.description, "Test agent");
  assert.equal(parsed.tools, "read, bash");
  assert.equal(parsed.skills, "alpha, beta");
  assert.equal(parsed.denyTools, "write");
  assert.equal(parsed.spawning, false);
  assert.equal(parsed.autoExit, true);
  assert.equal(parsed.systemPromptMode, "replace");
  assert.equal(parsed.sessionMode, "fork");
  assert.equal(parsed.cwd, "workdir");
  assert.equal(parsed.disableModelInvocation, true);
  assert.equal(parsed.body, "# Tester\n\nRole body.");
});

test("parseAgentDefinition falls back to filename name and skill alias", () => {
  const parsed = parseAgentDefinition(
    "---\nskill: only-one\n---\nbody text",
    "from-file",
  );
  assert.ok(parsed);
  assert.equal(parsed.name, "from-file");
  assert.equal(parsed.skills, "only-one");
  assert.equal(parsed.body, "body text");
});

test("parseAgentDefinition returns null without frontmatter", () => {
  assert.equal(parseAgentDefinition("# Just markdown", "x"), null);
});

test("parseAgentDefinition rejects invalid session-mode and defaults booleans", () => {
  const parsed = parseAgentDefinition("---\nsession-mode: nonsense\nspawning: yes\n---\n", "x");
  assert.ok(parsed);
  assert.equal(parsed.sessionMode, undefined);
  assert.equal(parsed.spawning, false); // "yes" !== "true"
  assert.equal(parsed.autoExit, undefined);
  assert.equal(parsed.disableModelInvocation, false);
});

test("resolveDenyTools expands spawning:false and adds deny-tools", () => {
  assert.equal(resolveDenyTools(null).size, 0);

  const deny = resolveDenyTools({ spawning: false, denyTools: "write, edit" });
  for (const t of SPAWNING_TOOLS) assert.ok(deny.has(t));
  assert.ok(deny.has("write"));
  assert.ok(deny.has("edit"));

  const onlyDeny = resolveDenyTools({ denyTools: "bash" });
  assert.deepEqual([...onlyDeny], ["bash"]);
});

test("discoverAgentDefinitions applies project > global > package precedence", () => {
  const { dirs, cleanup } = makeTempDirs();
  try {
    writeAgent(dirs.bundled, "scout.md", "---\ndescription: bundled scout\n---\nbundled body");
    writeAgent(dirs.global, "scout.md", "---\ndescription: global scout\n---\nglobal body");
    writeAgent(dirs.project, "scout.md", "---\ndescription: project scout\n---\nproject body");
    writeAgent(dirs.bundled, "worker.md", "---\ndescription: bundled worker\n---\nworker body");
    writeAgent(dirs.project, "helper.md", "---\nname: helper\n---\nhelp");
    writeAgent(dirs.project, "no-frontmatter.md", "# nothing");

    const found = discoverAgentDefinitions(dirs);
    const byName = new Map(found.map((a) => [a.name, a]));

    assert.equal(byName.get("scout")?.source, "project");
    assert.equal(byName.get("scout")?.description, "project scout");
    assert.equal(byName.get("worker")?.source, "package");
    assert.equal(byName.get("helper")?.source, "project");
    assert.equal(byName.has("no-frontmatter"), false);
  } finally {
    cleanup();
  }
});

test("discoverAgentDefinitions tolerates missing directories", () => {
  const found = discoverAgentDefinitions({
    bundled: join(tmpdir(), "definitely-missing-bundled"),
    global: join(tmpdir(), "definitely-missing-global"),
    project: join(tmpdir(), "definitely-missing-project"),
  });
  assert.deepEqual(found, []);
});

test("loadAgentDefaults prefers project over global over bundled", () => {
  const { dirs, cleanup } = makeTempDirs();
  try {
    writeAgent(dirs.bundled, "a.md", "---\ndescription: bundled\n---\nx");
    writeAgent(dirs.global, "a.md", "---\ndescription: global\n---\nx");
    assert.equal(loadAgentDefaults("a", dirs)?.description, "global");

    writeAgent(dirs.project, "a.md", "---\ndescription: project\n---\nx");
    assert.equal(loadAgentDefaults("a", dirs)?.description, "project");

    assert.equal(loadAgentDefaults("missing", dirs), null);
  } finally {
    cleanup();
  }
});

test("resolveSubagentPaths resolves relative param cwd against process cwd", () => {
  const res = resolveSubagentPaths({ cwd: "sub/dir" }, null, {
    configDir: "/config",
    processCwd: "/work",
  });
  assert.equal(res.effectiveCwd, join("/work", "sub/dir"));
  assert.equal(res.localAgentDir, join("/work", "sub/dir", ".pi", "agent"));
  assert.equal(res.effectiveAgentDir, "/config"); // localAgentDir does not exist
});

test("resolveSubagentPaths resolves agent frontmatter cwd against config dir", () => {
  const res = resolveSubagentPaths({}, { cwd: "role-dir" }, {
    configDir: "/config",
    processCwd: "/work",
  });
  assert.equal(res.effectiveCwd, join("/config", "role-dir"));
});

test("resolveSubagentPaths keeps absolute cwd (POSIX and Windows) as-is", () => {
  const posix = resolveSubagentPaths({ cwd: "/abs/path" }, null, {
    configDir: "/config",
    processCwd: "/work",
  });
  assert.equal(posix.effectiveCwd, "/abs/path");

  if (process.platform === "win32") {
    const win = resolveSubagentPaths({ cwd: "C:\\abs\\path" }, null, {
      configDir: "/config",
      processCwd: "/work",
    });
    assert.equal(win.effectiveCwd, "C:\\abs\\path");
  }
});

test("resolveSubagentPaths prefers existing local .pi/agent dir", () => {
  const { dirs, cleanup } = makeTempDirs();
  try {
    const cwd = join(dirs.project, "with-local-agent");
    const localAgentDir = join(cwd, ".pi", "agent");
    mkdirSync(localAgentDir, { recursive: true });

    const res = resolveSubagentPaths({ cwd }, null, {
      configDir: dirs.global,
      processCwd: dirs.bundled,
    });
    assert.equal(res.effectiveCwd, cwd);
    assert.equal(res.effectiveAgentDir, localAgentDir);
  } finally {
    cleanup();
  }
});

test("ensureSessionDir creates the pi-style per-cwd session directory", () => {
  const { dirs, cleanup } = makeTempDirs();
  try {
    const sessionDir = ensureSessionDir("C:\\work\\project", dirs.bundled);
    assert.equal(sessionDir, join(dirs.bundled, "sessions", "--C--work-project--"));
    // idempotent
    assert.equal(ensureSessionDir("C:\\work\\project", dirs.bundled), sessionDir);
  } finally {
    cleanup();
  }
});

test("session mode resolution: fork param wins, agent default next, standalone last", () => {
  assert.equal(resolveEffectiveSessionMode({ fork: true }, { sessionMode: "lineage-only" }), "fork");
  assert.equal(resolveEffectiveSessionMode({}, { sessionMode: "lineage-only" }), "lineage-only");
  assert.equal(resolveEffectiveSessionMode({}, null), "standalone");
});

test("resolveLaunchBehavior maps modes to seeding and task delivery", () => {
  const standalone = resolveLaunchBehavior({}, null);
  assert.deepEqual(standalone, {
    sessionMode: "standalone",
    seededSessionMode: null,
    inheritsConversationContext: false,
    taskDelivery: "artifact",
  });

  const lineage = resolveLaunchBehavior({}, { sessionMode: "lineage-only" });
  assert.equal(lineage.seededSessionMode, "lineage-only");
  assert.equal(lineage.taskDelivery, "artifact");

  const fork = resolveLaunchBehavior({ fork: true }, null);
  assert.equal(fork.seededSessionMode, "fork");
  assert.equal(fork.inheritsConversationContext, true);
  assert.equal(fork.taskDelivery, "direct");
});

test("defaultAgentDirs derives global/project dirs", () => {
  const dirs = defaultAgentDirs("/bundled", {
    configDir: "/cfg",
    projectCwd: "/proj",
  });
  assert.deepEqual(dirs, {
    bundled: "/bundled",
    global: join("/cfg", "agents"),
    project: join("/proj", ".pi", "agents"),
  });
});
