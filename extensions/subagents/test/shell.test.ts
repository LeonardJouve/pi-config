import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DONE_SENTINEL_REGEX,
  shellEscape,
} from "../shell.ts";

test("shellEscape wraps in single quotes", () => {
  assert.equal(shellEscape("hello"), "'hello'");
  assert.equal(shellEscape(""), "''");
});

test("shellEscape escapes embedded single quotes", () => {
  assert.equal(shellEscape("it's"), "'it'\\''s'");
  assert.equal(shellEscape("a'b'c"), "'a'\\''b'\\''c'");
});

test("shellEscape keeps windows paths intact inside quotes", () => {
  assert.equal(
    shellEscape("C:\\Users\\leona\\.pi\\session.jsonl"),
    "'C:\\Users\\leona\\.pi\\session.jsonl'",
  );
});

test("done sentinel regex captures the exit code", () => {
  const match = "some output\n__SUBAGENT_DONE_2__\n".match(DONE_SENTINEL_REGEX);
  assert.ok(match);
  assert.equal(match[1], "2");

  assert.equal(DONE_SENTINEL_REGEX.test("__SUBAGENT_DONE___"), false);
});
