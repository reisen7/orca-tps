// Turning a list of assistant steps into turns, shared by both sources.
import type { Snapshot, Turn } from './protocol'

/** How many turns a snapshot keeps, newest first. */
export const TURN_LIMIT = 12

/** One assistant message: a model step. */
export interface Step {
  role: string
  /** When the step started. */
  at: number
  output: number
  reasoning: number
  /** Time the model spent generating this step; 0 when it is not known yet. */
  durationMs: number
  model: string | null
  /** No end timestamp yet: the model is still writing this step. */
  open: boolean
}

/** Both tools' rule: (output + reasoning) tokens over the time spent generating. */
export function rate(tokens: number, durationMs: number): number | null {
  if (!(tokens > 0) || !(durationMs > 0)) return null
  return tokens / (durationMs / 1000)
}

/** A person's message, or one the tool adds in their place, starts a new turn. */
export function isBoundary(role: string): boolean {
  return role === 'user' || role === 'synthetic'
}

/**
 * Assistant steps between two user messages are one turn (tool loops included), and reasoning
 * counts, so a turn's rate is what the tool's own tok/s shows.
 */
export function buildTurns(steps: Step[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null
  let live = false

  const flush = () => {
    if (!current) return
    current.tps = rate(current.tokens, current.durationMs)
    current.live = live
    turns.push(current)
    current = null
    live = false
  }

  for (const step of steps) {
    if (isBoundary(step.role)) {
      flush()
      continue
    }
    if (step.role !== 'assistant') continue
    if (!current) {
      current = {
        at: step.at,
        tokens: 0,
        output: 0,
        reasoning: 0,
        durationMs: 0,
        tps: null,
        live: false,
        model: null
      }
    }
    current.output += step.output
    current.reasoning += step.reasoning
    current.tokens += step.output + step.reasoning
    current.durationMs += step.durationMs
    if (step.open) live = true
    if (step.model) current.model = step.model
  }
  flush()
  return turns
}

/** Average over the turns that have a rate, so unfinished ones do not drag it down. */
export function summarise(turns: Turn[]): Snapshot['average'] {
  const timed = turns.filter((turn) => turn.tps !== null)
  const tokens = timed.reduce((sum, turn) => sum + turn.tokens, 0)
  const durationMs = timed.reduce((sum, turn) => sum + turn.durationMs, 0)
  return { tps: rate(tokens, durationMs), tokens, durationMs, turns: timed.length }
}
