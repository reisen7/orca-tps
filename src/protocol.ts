// What the worker reports, and the one request kept for checking it from a terminal.
export {}

/** Where the numbers come from: OpenCode's database, or pi's session files. */
export type Source = 'opencode' | 'pi'

export interface Turn {
  /** When the turn's first assistant message started. */
  at: number
  /** output + reasoning tokens, the number both tools divide by time. */
  tokens: number
  output: number
  reasoning: number
  /** Milliseconds the model spent generating. */
  durationMs: number
  /** tokens / seconds, or null when the turn has no timing yet. */
  tps: number | null
  /** Still generating when the snapshot was taken. */
  live: boolean
  model: string | null
}

export interface SessionSummary {
  /** OpenCode session id, or the path of a pi session file. */
  id: string
  title: string
  updatedAt: number
  model: string | null
  source: Source
}

export interface Snapshot {
  source: Source
  sessionId: string | null
  title: string | null
  model: string | null
  /** When the session was last written to, in epoch ms: the newer of two wins the status bar. */
  updatedAt: number
  /** Average over every finished turn in the session. */
  average: { tps: number | null; tokens: number; durationMs: number; turns: number }
  /** Newest first. */
  turns: Turn[]
  /** True while the newest turn is still streaming. */
  streaming: boolean
  /** A rough tok/s while text is still arriving; null when nothing is streaming. */
  live: { tps: number | null; chars: number } | null
  /** Why there is nothing to show, when there is nothing to show. */
  problem: string | null
  /** The database or file this came from, for the tooltip. */
  sourceDetail: string
}

declare module 'orca' {
  interface PluginRequests {
    /** The numbers for one source; without an id, its newest session. */
    'tps.snapshot': { input: { source?: Source; sessionId?: string } | null; output: Snapshot }
  }
}
