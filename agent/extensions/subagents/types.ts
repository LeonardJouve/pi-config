/** State for a launched (but not yet completed) subagent. */
export interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  abortController?: AbortController;
  /** Temp batch file path on Windows, cleaned up when the subagent finishes. */
  batchFile?: string;
}

/** Result from running a single subagent. */
export interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  ping?: { name: string; message: string };
}
