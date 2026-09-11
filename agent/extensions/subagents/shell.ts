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

/** True when running on Windows (where new WezTerm panes default to cmd.exe). */
export const isWindows = process.platform === "win32";

/** POSIX single-quote escaping (works in bash/zsh/sh shells). */
export function posixShellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * cmd.exe double-quote escaping.
 *
 * Inside cmd.exe double quotes the only character that needs a caret escape
 * is the double-quote itself.  Other shell metacharacters (`&`, `|`, `<`,
 * `>`, `^`, `(`, `)`) lose their special meaning inside double quotes.
 * Percent signs are *not* escaped here because `%VAR%` expansion is how
 * cmd.exe reads back the values we set with `set`.
 */
export function cmdEscape(s: string): string {
  return '"' + s.replace(/"/g, '^"') + '"';
}

/**
 * Escape a string that will appear *outside* double quotes in a cmd.exe
 * command line.  Used for the exit-sentinel echo where parentheses and
 * dollar signs are cmd.exe metacharacters.
 */
export function cmdShellEscape(s: string): string {
  return s.replace(/["%&|<>()^!\s]/g, "^$&");
}

/**
 * Platform-aware shell quoting.
 * - Windows → cmd.exe double-quote escaping
 * - Other   → POSIX single-quote escaping
 */
export function shellEscape(s: string): string {
  return isWindows ? cmdEscape(s) : posixShellEscape(s);
}
