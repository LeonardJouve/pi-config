/**
 * Shell quoting helpers and the exit sentinel shared between the launcher
 * (index.ts / launch.ts) and the completion poller (wezterm.ts).
 */

/** Prefix of the sentinel echoed by the child pane's shell when pi exits. */
export const DONE_SENTINEL_PREFIX = "__SUBAGENT_DONE_";

/** Suffix of the sentinel echoed by the child pane's shell when pi exits. */
export const DONE_SENTINEL_SUFFIX = "__";

/** Matches the sentinel on the pane screen and captures the shell exit code. */
export const DONE_SENTINEL_REGEX = /__SUBAGENT_DONE_(\d+)__/;

/** POSIX single-quote escaping (works in bash/zsh/sh shells). */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
