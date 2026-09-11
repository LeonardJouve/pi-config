import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DONE_SENTINEL_REGEX,
  isWindows,
  posixShellEscape,
  cmdEscape,
  shellEscape,
} from "../shell.ts";

test("posixShellEscape wraps in single quotes", () => {
  assert.equal(posixShellEscape("hello"), "'hello'");
  assert.equal(posixShellEscape(""), "''");
});

test("posixShellEscape escapes embedded single quotes", () => {
  assert.equal(posixShellEscape("it's"), "'it'\\''s'");
  assert.equal(posixShellEscape("a'b'c"), "'a'\\''b'\\''c'");
});

test("posixShellEscape keeps windows paths intact inside quotes", () => {
  assert.equal(
    posixShellEscape("C:\\Users\\leona\\.pi\\session.jsonl"),
    "'C:\\Users\\leona\\.pi\\session.jsonl'",
  );
});

test("cmdEscape wraps in double quotes", () => {
  assert.equal(cmdEscape("hello"), '"hello"');
  assert.equal(cmdEscape(""), '""');
});

test("cmdEscape escapes embedded double quotes", () => {
  assert.equal(cmdEscape('say "hi"'), '"say ^"hi^""');
});

test("shellEscape dispatches by platform", () => {
  if (isWindows) {
    assert.equal(shellEscape("hello"), '"hello"');
  } else {
    assert.equal(shellEscape("hello"), "'hello'");
  }
});

test("done sentinel regex captures the exit code", () => {
  const match = "some output\n__SUBAGENT_DONE_2__\n".match(DONE_SENTINEL_REGEX);
  assert.ok(match);
  assert.equal(match[1], "2");

  assert.equal(DONE_SENTINEL_REGEX.test("__SUBAGENT_DONE___"), false);
});
