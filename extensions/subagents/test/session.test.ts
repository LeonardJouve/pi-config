import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendBranchSummary,
  countEntries,
  findLastAssistantMessage,
  getLeafId,
  getNewEntries,
  mergeNewEntries,
  seedSubagentSessionFile,
} from "../session.ts";

function withTempFile(lines: string[], fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "subagents-session-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((l) => l + "\n").join(""), "utf8");
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assistantEntry(id: string, text: string | null, extra: Record<string, unknown> = {}): string {
  const content = text === null ? [] : [{ type: "text", text }];
  return JSON.stringify({
    type: "message",
    id,
    message: { role: "assistant", content, ...extra },
  });
}

test("seedSubagentSessionFile lineage-only writes a fresh header", () => {
  const dir = mkdtempSync(join(tmpdir(), "subagents-session-"));
  try {
    const parent = join(dir, "parent.jsonl");
    writeFileSync(
      parent,
      JSON.stringify({ type: "session", version: 3, id: "p" }) +
        "\n" +
        JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: [] } }) +
        "\n",
      "utf8",
    );
    const child = join(dir, "nested", "child.jsonl");
    seedSubagentSessionFile({
      mode: "lineage-only",
      parentSessionFile: parent,
      childSessionFile: child,
      childCwd: "/work",
    });

    const lines = readFileSync(child, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const header = JSON.parse(lines[0]);
    assert.equal(header.type, "session");
    assert.equal(header.version, 3);
    assert.equal(header.cwd, "/work");
    assert.equal(header.parentSession, parent);
    assert.ok(header.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seedSubagentSessionFile fork copies history up to the last user message", () => {
  const dir = mkdtempSync(join(tmpdir(), "subagents-session-"));
  try {
    const parent = join(dir, "parent.jsonl");
    const parentLines = [
      JSON.stringify({ type: "session", version: 3, id: "p", cwd: "/old" }),
      JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "first" }] } }),
      JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } }),
      JSON.stringify({ type: "message", id: "m3", message: { role: "user", content: [{ type: "text", text: "latest" }] } }),
      JSON.stringify({ type: "message", id: "m4", message: { role: "assistant", content: [{ type: "text", text: "latest reply" }] } }),
    ];
    writeFileSync(parent, parentLines.join("\n") + "\n", "utf8");

    const child = join(dir, "child.jsonl");
    seedSubagentSessionFile({
      mode: "fork",
      parentSessionFile: parent,
      childSessionFile: child,
      childCwd: "/new",
    });

    const lines = readFileSync(child, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    // header + m1 + m2 (everything before the last user message m3); parent header dropped
    assert.equal(lines.length, 3);
    assert.equal(lines[0].type, "session");
    assert.equal(lines[0].cwd, "/new");
    assert.equal(lines[1].id, "m1");
    assert.equal(lines[2].id, "m2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("countEntries counts raw lines; getNewEntries slices and skips malformed lines", () => {
  withTempFile(
    [
      JSON.stringify({ type: "session", id: "s" }),
      "not json at all",
      JSON.stringify({ type: "message", id: "m1" }),
    ],
    (path) => {
      assert.equal(countEntries(path), 3);
      assert.equal(getNewEntries(path, 0).length, 2); // malformed skipped
      assert.deepEqual(
        getNewEntries(path, 2).map((e) => e.id),
        ["m1"],
      );
      assert.deepEqual(getNewEntries(path, 3), []);
    },
  );
});

test("getLeafId returns the last entry id", () => {
  withTempFile(
    [JSON.stringify({ type: "session", id: "s" }), JSON.stringify({ type: "message", id: "m9" })],
    (path) => {
      assert.equal(getLeafId(path), "m9");
    },
  );
});

test("findLastAssistantMessage returns the newest non-empty assistant text", () => {
  const entries = [
    JSON.parse(assistantEntry("a1", "first answer")),
    JSON.parse(assistantEntry("a2", "   ")), // whitespace only → skipped
    JSON.parse(assistantEntry("a3", "final answer")),
  ];
  assert.equal(findLastAssistantMessage(entries), "final answer");

  const onlyEmpty = [JSON.parse(assistantEntry("a1", ""))];
  assert.equal(findLastAssistantMessage(onlyEmpty), null);
  assert.equal(findLastAssistantMessage([]), null);
});

test("findLastAssistantMessage joins multiple text blocks", () => {
  const entries = [
    JSON.parse(
      JSON.stringify({
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "part one" },
            { type: "thinking", thinking: "ignored" },
            { type: "text", text: "part two" },
          ],
        },
      }),
    ),
  ];
  assert.equal(findLastAssistantMessage(entries), "part one\npart two");
});

test("findLastAssistantMessage falls back to errorMessage on stopReason=error", () => {
  const entries = [
    JSON.parse(assistantEntry("a1", "stale earlier answer")),
    JSON.parse(assistantEntry("a2", null, { stopReason: "error", errorMessage: " Overloaded " })),
  ];
  assert.equal(findLastAssistantMessage(entries), "Subagent error: Overloaded");

  // without errorMessage → keeps scanning older messages
  const noMsg = [
    JSON.parse(assistantEntry("a1", "earlier answer")),
    JSON.parse(assistantEntry("a2", null, { stopReason: "error" })),
  ];
  assert.equal(findLastAssistantMessage(noMsg), "earlier answer");

  // aborted turns are not surfaced as errors
  const aborted = [JSON.parse(assistantEntry("a1", null, { stopReason: "aborted" }))];
  assert.equal(findLastAssistantMessage(aborted), null);
});

test("appendBranchSummary appends a parseable entry", () => {
  withTempFile([JSON.stringify({ type: "session", id: "s" })], (path) => {
    const id = appendBranchSummary(path, "s", "m1", "did things");
    const entries = getNewEntries(path, 1);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, "branch_summary");
    assert.equal(entries[0].id, id);
    assert.equal(entries[0].parentId, "s");
    assert.equal((entries[0] as any).fromId, "m1");
    assert.equal((entries[0] as any).summary, "did things");
  });
});

test("mergeNewEntries appends only entries after the offset", () => {
  const dir = mkdtempSync(join(tmpdir(), "subagents-session-"));
  try {
    const source = join(dir, "source.jsonl");
    const target = join(dir, "target.jsonl");
    writeFileSync(
      source,
      [
        JSON.stringify({ type: "message", id: "m1" }),
        JSON.stringify({ type: "message", id: "m2" }),
        JSON.stringify({ type: "message", id: "m3" }),
      ].join("\n") + "\n",
      "utf8",
    );
    writeFileSync(target, JSON.stringify({ type: "session", id: "t" }) + "\n", "utf8");

    const merged = mergeNewEntries(source, target, 1);
    assert.deepEqual(merged.map((e) => e.id), ["m2", "m3"]);

    const targetIds = readFileSync(target, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).id);
    assert.deepEqual(targetIds, ["t", "m2", "m3"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
