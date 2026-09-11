import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interpretExitSidecar, pollForExit, readExitSidecar } from "../wezterm.ts";

test("interpretExitSidecar handles ping payloads", () => {
  const result = interpretExitSidecar({ type: "ping", name: "Scout", message: "need help" });
  assert.deepEqual(result, {
    reason: "ping",
    exitCode: 0,
    ping: { name: "Scout", message: "need help" },
  });
});

test("interpretExitSidecar handles error payloads with and without messages", () => {
  const withMsg = interpretExitSidecar({ type: "error", errorMessage: "Overloaded" });
  assert.equal(withMsg.reason, "error");
  assert.equal(withMsg.exitCode, 1);
  assert.equal(withMsg.errorMessage, "Overloaded");

  const blank = interpretExitSidecar({ type: "error", errorMessage: "   " });
  assert.match(blank.errorMessage ?? "", /no errorMessage in sidecar/);

  const missing = interpretExitSidecar({ type: "error" });
  assert.match(missing.errorMessage ?? "", /no errorMessage in sidecar/);
});

test("interpretExitSidecar treats done and unknown payloads as done", () => {
  assert.deepEqual(interpretExitSidecar({ type: "done" }), { reason: "done", exitCode: 0 });
  assert.deepEqual(interpretExitSidecar(null), { reason: "done", exitCode: 0 });
  assert.deepEqual(interpretExitSidecar({ type: "weird" }), { reason: "done", exitCode: 0 });
});

test("readExitSidecar consumes the sidecar file", () => {
  const dir = mkdtempSync(join(tmpdir(), "subagents-wezterm-"));
  try {
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "", "utf8");

    // No sidecar → null
    assert.equal(readExitSidecar(sessionFile), null);

    // Valid sidecar → parsed and removed
    writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "ping", name: "N", message: "M" }));
    const result = readExitSidecar(sessionFile);
    assert.equal(result?.reason, "ping");
    assert.equal(existsSync(`${sessionFile}.exit`), false);

    // Malformed sidecar → null (left on disk for the next reader)
    writeFileSync(`${sessionFile}.exit`, "{oops");
    assert.equal(readExitSidecar(sessionFile), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pollForExit rejects immediately when the signal is already aborted", async () => {
  // Regression: a poisoned (pre-aborted) controller must never be silently
  // reused — it used to kill every spawn at elapsed 0.
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => pollForExit("999999", controller.signal, { interval: 10 }),
    /Aborted while waiting for subagent to finish/,
  );
});

test("pollForExit returns the sidecar result before touching the mux", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subagents-wezterm-"));
  try {
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "", "utf8");
    writeFileSync(
      `${sessionFile}.exit`,
      JSON.stringify({ type: "error", errorMessage: "rate limited" }),
    );

    // Surface id is bogus — if the fast path failed we'd hit wezterm and error out.
    const result = await pollForExit("999999", new AbortController().signal, {
      interval: 10,
      sessionFile,
    });
    assert.equal(result.reason, "error");
    assert.equal(result.errorMessage, "rate limited");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pollForExit aborts mid-wait when the signal fires", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(
    () =>
      pollForExit("999999", controller.signal, {
        interval: 10_000,
        // no sessionFile → falls through to the sleep, where abort rejects
      }),
    /Aborted/,
  );
});
