import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCmdLaunchCommand,
  buildLaunchCommand,
  buildPiArgv,
  buildPiPromptArgs,
  buildSubagentEnv,
  buildSubagentToolAllowlist,
  formatElapsed,
  formatElapsedMMSS,
  getArtifactDir,
  getMaxConcurrentSubagents,
  getShellReadyDelayMs,
  handleSubagentInterrupt,
  resolveInterruptTarget,
  resolveResultPresentation,
  requestSubagentInterrupt,
  safeScriptName,
  writeResumeMessageArtifact,
  writeSystemPromptArtifact,
  writeTaskArtifact,
} from "../launch.ts";
import { isWindows, posixShellEscape } from "../shell.ts";
import type { RunningSubagent } from "../types.ts";

function makeRunning(overrides: Partial<RunningSubagent> = {}): RunningSubagent {
  return {
    id: "abc123",
    name: "Worker: thing",
    task: "do thing",
    surface: "42",
    startTime: Date.now(),
    sessionFile: "/tmp/session.jsonl",
    ...overrides,
  };
}

test("formatElapsed", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(59), "59s");
  assert.equal(formatElapsed(60), "1m 0s");
  assert.equal(formatElapsed(125), "2m 5s");
});

test("formatElapsedMMSS pads and clamps", () => {
  const now = 1_000_000;
  assert.equal(formatElapsedMMSS(now - 5_000, now), "00:05");
  assert.equal(formatElapsedMMSS(now - 65_000, now), "01:05");
  assert.equal(formatElapsedMMSS(now + 10_000, now), "00:00");
});

test("safeScriptName sanitizes names", () => {
  assert.equal(safeScriptName("Scout: Auth Module"), "scout-auth-module");
  assert.equal(safeScriptName("  Weird!!! ??  "), "weird");
  assert.equal(safeScriptName("---"), "subagent");
  assert.equal(safeScriptName("", "resume"), "resume");
  assert.equal(safeScriptName("Ünïcöde 123"), "ncde-123");
});

test("getShellReadyDelayMs honors env overrides", () => {
  assert.equal(getShellReadyDelayMs({}), 500);
  assert.equal(getShellReadyDelayMs({ PI_SUBAGENT_SHELL_READY_DELAY_MS: "2500" }), 2500);
  assert.equal(getShellReadyDelayMs({ PI_SUBAGENT_SHELL_READY_DELAY_MS: "0" }), 0);
  assert.equal(getShellReadyDelayMs({ PI_SUBAGENT_SHELL_READY_DELAY_MS: "abc" }), 500);
  assert.equal(getShellReadyDelayMs({ PI_SUBAGENT_SHELL_READY_DELAY_MS: "-5" }), 500);
});

test("getMaxConcurrentSubagents defaults to 2 and honors env overrides", () => {
  assert.equal(getMaxConcurrentSubagents({}), 2);
  assert.equal(getMaxConcurrentSubagents({ PI_SUBAGENT_MAX_CONCURRENT: "4" }), 4);
  assert.equal(getMaxConcurrentSubagents({ PI_SUBAGENT_MAX_CONCURRENT: "1" }), 1);
  assert.equal(getMaxConcurrentSubagents({ PI_SUBAGENT_MAX_CONCURRENT: "0" }), 2);
  assert.equal(getMaxConcurrentSubagents({ PI_SUBAGENT_MAX_CONCURRENT: "abc" }), 2);
});

test("getArtifactDir joins session dir and id", () => {
  assert.equal(getArtifactDir("/sessions/dir", "sid-1"), join("/sessions/dir", "artifacts", "sid-1"));
});

test("buildSubagentToolAllowlist always includes child control tools", () => {
  assert.equal(buildSubagentToolAllowlist(undefined), null);
  assert.equal(buildSubagentToolAllowlist(""), null);
  assert.equal(buildSubagentToolAllowlist("  , "), null);
  assert.equal(
    buildSubagentToolAllowlist("read, bash"),
    "read,bash,caller_ping,subagent_done",
  );
  // dedupes when the definition already lists a control tool
  assert.equal(
    buildSubagentToolAllowlist("read,subagent_done"),
    "read,subagent_done,caller_ping",
  );
});

test("buildPiPromptArgs orders skills before task", () => {
  assert.deepEqual(
    buildPiPromptArgs({ taskDelivery: "direct", taskArg: "the task" }),
    ["the task"],
  );
  assert.deepEqual(
    buildPiPromptArgs({
      effectiveSkills: "one, two",
      taskDelivery: "direct",
      taskArg: "the task",
    }),
    ["/skill:one", "/skill:two", "the task"],
  );
  // artifact delivery needs an empty separator so /skill: lands in messages[1..]
  assert.deepEqual(
    buildPiPromptArgs({
      effectiveSkills: "one",
      taskDelivery: "artifact",
      taskArg: "@/tmp/task.md",
    }),
    ["", "/skill:one", "@/tmp/task.md"],
  );
  assert.deepEqual(
    buildPiPromptArgs({ taskDelivery: "artifact", taskArg: "@/tmp/task.md" }),
    ["@/tmp/task.md"],
  );
});

test("buildSubagentEnv skips undefined and orders assignments", () => {
  const env = buildSubagentEnv({
    path: "/bin",
    agentDir: null,
    denyTools: [],
    name: "Worker",
    autoExit: false,
    sessionFile: "/s.jsonl",
    surface: "7",
  });
  assert.deepEqual(Object.keys(env), [
    "PATH",
    "PI_CODING_AGENT_DIR",
    "PI_DENY_TOOLS",
    "PI_SUBAGENT_NAME",
    "PI_SUBAGENT_AGENT",
    "PI_SUBAGENT_AUTO_EXIT",
    "PI_SUBAGENT_SESSION",
    "PI_SUBAGENT_SURFACE",
  ]);
  assert.equal(env.PI_CODING_AGENT_DIR, undefined);
  assert.equal(env.PI_DENY_TOOLS, undefined);
  assert.equal(env.PI_SUBAGENT_AUTO_EXIT, undefined);

  const env2 = buildSubagentEnv({
    denyTools: ["write", "subagent"],
    name: "W",
    agent: "worker",
    autoExit: true,
    sessionFile: "/s.jsonl",
  });
  assert.equal(env2.PI_DENY_TOOLS, "write,subagent");
  assert.equal(env2.PI_SUBAGENT_AGENT, "worker");
  assert.equal(env2.PI_SUBAGENT_AUTO_EXIT, "1");
  assert.equal(env2.PI_SUBAGENT_SURFACE, undefined);
});

test("buildPiArgv escapes paths and appends optional flags", () => {
  const argv = buildPiArgv({
    sessionFile: "/path/with space/s.jsonl",
    extensionPath: "/ext/done.ts",
    toolAllowlist: "read,bash",
    systemPromptFlag: "--append-system-prompt",
    systemPromptPath: "/sys/prompt.md",
    promptArgs: ["", "/skill:x", "@/task.md"],
  });
  if (isWindows) {
    assert.deepEqual(argv, [
      "pi",
      "--session",
      '"/path/with space/s.jsonl"',
      "-e",
      '"/ext/done.ts"',
      "--append-system-prompt",
      '"/sys/prompt.md"',
      "--tools",
      '"read,bash"',
      '""',
      '"/skill:x"',
      '"@/task.md"',
    ]);
  } else {
    assert.deepEqual(argv, [
      "pi",
      "--session",
      "'/path/with space/s.jsonl'",
      "-e",
      "'/ext/done.ts'",
      "--append-system-prompt",
      "'/sys/prompt.md'",
      "--tools",
      "'read,bash'",
      "''",
      "'/skill:x'",
      "'@/task.md'",
    ]);
  }
});

test("buildLaunchCommand assembles cd, env, argv and sentinel", () => {
  if (isWindows) {
    // On Windows, buildLaunchCommand returns { command, batchFile }.
    const result = buildLaunchCommand({
      cwd: "C:\\work",
      env: { PATH: "C:\\bin", NAME: "worker" },
      argv: ["pi", "--session", '"/s.jsonl"'],
    });
    assert.equal(typeof result, "object");
    assert.ok((result as any).batchFile.endsWith(".bat"));
    assert.ok((result as any).command.startsWith('"'));
    const content = readFileSync((result as any).batchFile, "utf8");
    assert.match(content, /@echo off/);
    assert.match(content, /set PATH=C:\\bin/);
    assert.match(content, /set NAME=worker/);
    assert.match(content, /cd \/d C:\\work/);
    assert.match(content, /call pi --session "\/s.jsonl"/);
    assert.match(content, /__SUBAGENT_DONE_%__rc__%__/);
    assert.match(content, /del "%~f0"/);
    // cleanup
    rmSync((result as any).batchFile, { force: true });
  } else {
    const cmd = buildLaunchCommand({
      cwd: "/work/dir",
      env: { PATH: "/bin", SKIP: undefined, NAME: "it's" },
      argv: ["pi", "--session", "'/s.jsonl'"],
    });
    assert.equal(
      cmd,
      "cd '/work/dir' && PATH='/bin' NAME='it'\\''s' pi --session '/s.jsonl'; echo '__SUBAGENT_DONE_'$?'__'",
    );

    const noCwd = buildLaunchCommand({ env: {}, argv: ["pi"] });
    assert.equal(noCwd, "pi; echo '__SUBAGENT_DONE_'$?'__'");
  }
});

test("buildCmdLaunchCommand creates a batch file with correct content", () => {
  const result = buildCmdLaunchCommand({
    env: { PI_NAME: "test", PI_TOOLS: "read,bash" },
    argv: ["pi", "--session", '"session.jsonl"'],
  });
  assert.ok(result.batchFile.endsWith(".bat"));
  assert.ok(existsSync(result.batchFile));
  const content = readFileSync(result.batchFile, "utf8");
  assert.match(content, /@echo off/);
  assert.match(content, /set PI_NAME=test/);
  assert.match(content, /set PI_TOOLS=read,bash/);
  assert.match(content, /call pi --session "session.jsonl"/);
  assert.match(content, /set __rc__=%ERRORLEVEL%/);
  assert.match(content, /echo __SUBAGENT_DONE_%__rc__%__/);
  assert.match(content, /del "%~f0"/);
  rmSync(result.batchFile, { force: true });
});

test("writeTaskArtifact is content-addressed and always rewrites", () => {
  const root = mkdtempSync(join(tmpdir(), "subagents-launch-"));
  try {
    const p1 = writeTaskArtifact(root, "Scout: Auth", "task one");
    assert.ok(p1.startsWith(join(root, "context", "scout-auth-")));
    assert.equal(readFileSync(p1, "utf8"), "task one");

    // same content → same path
    assert.equal(writeTaskArtifact(root, "Scout: Auth", "task one"), p1);

    // different content → different path
    const p2 = writeTaskArtifact(root, "Scout: Auth", "task two");
    assert.notEqual(p2, p1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeSystemPromptArtifact does not overwrite existing files", () => {
  const root = mkdtempSync(join(tmpdir(), "subagents-launch-"));
  try {
    const p = writeSystemPromptArtifact(root, "worker", "identity v1");
    writeFileSync(p, "mutated", "utf8");
    const again = writeSystemPromptArtifact(root, "worker", "identity v1");
    assert.equal(again, p);
    assert.equal(readFileSync(p, "utf8"), "mutated"); // skipped, not rewritten
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeResumeMessageArtifact stores under subagent-resume/", () => {
  const root = mkdtempSync(join(tmpdir(), "subagents-launch-"));
  try {
    const p = writeResumeMessageArtifact(root, "Resume", "please continue");
    assert.ok(p.includes(join("subagent-resume", "resume-")));
    assert.equal(readFileSync(p, "utf8"), "please continue");
    assert.ok(existsSync(p));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveResultPresentation formats success, failure and provider errors", () => {
  const ok = resolveResultPresentation(
    { exitCode: 0, elapsed: 65, summary: "All done.", sessionFile: "/s.jsonl" },
    "Worker",
  );
  assert.match(ok, /^Sub-agent "Worker" completed \(1m 5s\)\.\n\nAll done\./);
  assert.match(ok, /Resume: pi --session \/s\.jsonl$/);

  const failed = resolveResultPresentation(
    { exitCode: 3, elapsed: 10, summary: "Boom." },
    "Worker",
  );
  assert.match(failed, /^Sub-agent "Worker" failed \(exit code 3\)\.\n\nBoom\./);
  assert.equal(failed.includes("Session:"), false);

  const providerError = resolveResultPresentation(
    { exitCode: 1, elapsed: 10, summary: "stale", errorMessage: "Overloaded" },
    "Worker",
  );
  assert.match(providerError, /provider\/agent error — auto-retry exhausted/);
  assert.match(providerError, /Error: Overloaded/);
  assert.equal(providerError.includes("stale"), false);
});

test("resolveInterruptTarget resolves by id and name", () => {
  const a = makeRunning({ id: "a", name: "A" });
  const b = makeRunning({ id: "b", name: "B" });
  const all = [a, b];

  const byId = resolveInterruptTarget({ id: "a" }, all);
  assert.ok("running" in byId);
  assert.equal(byId.running, a);
  assert.match(
    (resolveInterruptTarget({ id: "zz" }, all) as { error: string }).error,
    /No running subagent with id "zz"/,
  );
  const byName = resolveInterruptTarget({ name: "B" }, all);
  assert.ok("running" in byName);
  assert.equal(byName.running, b);
  assert.match(
    (resolveInterruptTarget({ name: "missing" }, all) as { error: string }).error,
    /No running subagent named "missing"/,
  );
  assert.match(
    (resolveInterruptTarget({}, all) as { error: string }).error,
    /Provide a running subagent id or exact display name/,
  );

  const dup1 = makeRunning({ id: "d1", name: "Dup" });
  const dup2 = makeRunning({ id: "d2", name: "Dup" });
  const ambiguous = resolveInterruptTarget({ name: "Dup" }, [dup1, dup2]) as { error: string };
  assert.match(ambiguous.error, /Ambiguous subagent name "Dup"\. Matches: Dup \[d1\], Dup \[d2\]/);
});

test("requestSubagentInterrupt surfaces wezterm failures", () => {
  const ok = requestSubagentInterrupt(makeRunning(), () => {});
  assert.deepEqual(ok, { ok: true });

  const bad = requestSubagentInterrupt(makeRunning({ name: "X" }), () => {
    throw new Error("pane gone");
  }) as { error: string };
  assert.match(bad.error, /Failed to send Escape to subagent "X" via wezterm: pane gone/);
});

test("handleSubagentInterrupt returns tool-shaped results", () => {
  const running = [makeRunning({ id: "x1", name: "X", surface: "9" })];
  const escaped: string[] = [];

  const ok = handleSubagentInterrupt({ id: "x1" }, running, (s) => escaped.push(s));
  assert.deepEqual(escaped, ["9"]);
  assert.equal(ok.details.status, "interrupt_requested");
  assert.match(ok.content[0].text, /Interrupt requested for subagent "X"/);

  const miss = handleSubagentInterrupt({ id: "nope" }, running, () => {});
  assert.match(miss.details.error as string, /No running subagent with id "nope"/);
});
