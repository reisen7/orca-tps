// pi keeps one JSONL file per session under ~/.pi/agent/sessions/<cwd>/<time>_<id>.jsonl.
// Every message line carries what pi's own UI needs for its rate: `usage.output`,
// `usage.reasoning` and `durationMs`, so the same maths as OpenCode applies.
//
// Files are read incrementally: the cache remembers the byte offset it stopped at, so a session
// that grows by one line costs one line, and a huge file is never loaded into memory at once.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { SessionSummary, Snapshot } from './protocol'
import { buildTurns, summarise, TURN_LIMIT, type Step } from './turns'

const READ_CHUNK = 1 << 20
/** A single JSONL line bigger than this is skipped: it cannot be a plain message. */
const MAX_LINE = 8 << 20
/** Where pi stops being read when only the title is needed. */
const TITLE_BYTES = 256 << 10

let configuredPath = ''

/** Where pi keeps its sessions, unless the person pointed the setting elsewhere. */
export function sessionsRoot(): string {
  if (configuredPath.trim()) return configuredPath.trim()
  return join(homedir(), '.pi', 'agent', 'sessions')
}

export function setSessionsRoot(value: string): void {
  configuredPath = value
}

interface PiFile {
  /** Byte offset the cache has consumed up to. */
  offset: number
  /** Raw bytes of an unfinished last line. */
  carry: Buffer
  /** Inside a line that was too big to keep. */
  skipping: boolean
  /** Every user and assistant entry, in file order. */
  steps: Step[]
  title: string | null
  /** File size when the scan ran, and what the last snapshot was built from. */
  size: number
  mtimeMs: number
  stamp: string
}

const files = new Map<string, PiFile>()

function firstText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null
  if (!Array.isArray(content)) return null
  for (const part of content) {
    if (part && typeof part === 'object' && typeof (part as any).text === 'string') {
      const text = (part as any).text.trim()
      if (text) return text
    }
  }
  return null
}

/** One line of a pi session file, reduced to the bits a rate needs. */
function takeLine(state: PiFile, line: string): void {
  if (!line) return
  let entry: any
  try {
    entry = JSON.parse(line)
  } catch {
    return
  }
  if (!entry || entry.type !== 'message') return
  const message = entry.message
  if (!message || typeof message !== 'object') return
  const role = typeof message.role === 'string' ? message.role : ''
  if (role !== 'user' && role !== 'assistant') return
  const at =
    typeof message.timestamp === 'number'
      ? message.timestamp
      : typeof entry.timestamp === 'string'
        ? Date.parse(entry.timestamp)
        : 0
  if (role === 'user') {
    if (!state.title) {
      const text = firstText(message.content)?.replace(/\s+/g, ' ').trim()
      state.title = text ? (text.length > 60 ? `${text.slice(0, 59)}…` : text) : null
    }
    state.steps.push({ role, at, output: 0, reasoning: 0, durationMs: 0, model: null, open: false })
    return
  }
  const usage = message.usage ?? {}
  state.steps.push({
    role,
    at,
    output: typeof usage.output === 'number' ? usage.output : 0,
    reasoning: typeof usage.reasoning === 'number' ? usage.reasoning : 0,
    durationMs: typeof message.durationMs === 'number' ? message.durationMs : 0,
    model: typeof message.model === 'string' ? message.model : null,
    open: false
  })
}

/** Read what the file gained since the cache stopped, line by line, without holding it all. */
function scan(file: string, state: PiFile, limitBytes = Infinity): void {
  const size = statSync(file).size
  if (size < state.offset) {
    // The file was replaced or truncated: start over.
    state.offset = 0
    state.carry = Buffer.alloc(0)
    state.skipping = false
    state.steps = []
    state.title = null
  }
  const end = Math.min(size, limitBytes === Infinity ? size : state.offset + limitBytes)
  if (end <= state.offset) return

  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.allocUnsafe(READ_CHUNK)
    let position = state.offset
    while (position < end) {
      const length = Math.min(READ_CHUNK, end - position)
      const read = readSync(fd, buffer, 0, length, position)
      if (read <= 0) break
      position += read
      let chunk: Buffer = buffer.subarray(0, read)
      if (state.carry.length > 0) chunk = Buffer.concat([state.carry, chunk])
      let start = 0
      let newline = chunk.indexOf(10, start)
      while (newline !== -1) {
        if (!state.skipping) takeLine(state, chunk.subarray(start, newline).toString('utf8'))
        state.skipping = false
        start = newline + 1
        newline = chunk.indexOf(10, start)
      }
      state.carry = chunk.subarray(start)
      if (state.carry.length > MAX_LINE) {
        state.carry = Buffer.alloc(0)
        state.skipping = true
      }
    }
  } finally {
    closeSync(fd)
  }
  state.offset = end - state.carry.length
  state.size = size
  state.mtimeMs = statSync(file).mtimeMs
}

function stateFor(file: string): PiFile {
  let state = files.get(file)
  if (!state) {
    state = {
      offset: 0,
      carry: Buffer.alloc(0),
      skipping: false,
      steps: [],
      title: null,
      size: -1,
      mtimeMs: 0,
      stamp: ''
    }
    files.set(file, state)
  }
  return state
}

/** Listing every session means a recursive readdir; a fresh answer is reused this long. */
const LIST_TTL_MS = 2000

let listedAt = 0
let listed: Array<{ file: string; mtimeMs: number; size: number }> = []

/** Every session file, newest first. */
function listFiles(): Array<{ file: string; mtimeMs: number; size: number }> {
  const now = Date.now()
  if (listed.length > 0 && now - listedAt < LIST_TTL_MS) return listed
  const root = sessionsRoot()
  if (!existsSync(root)) return []
  let entries: string[] = []
  try {
    entries = readdirSync(root, { recursive: true, encoding: 'utf8' }) as string[]
  } catch {
    return []
  }
  const out: Array<{ file: string; mtimeMs: number; size: number }> = []
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.jsonl')) continue
    const file = join(root, name)
    try {
      const stat = statSync(file)
      if (stat.isFile()) out.push({ file, mtimeMs: stat.mtimeMs, size: stat.size })
    } catch {
      /* went away between listing and stat */
    }
  }
  out.sort((left, right) => right.mtimeMs - left.mtimeMs)
  listed = out
  listedAt = now
  return out
}

/** The nearest title a pi session has: its first user message, else its working directory. */
function titleOf(file: string): string {
  const state = stateFor(file)
  if (!state.title) {
    if (state.offset === 0) {
      try {
        scan(file, state, TITLE_BYTES)
      } catch {
        /* unreadable: fall back to the folder name */
      }
    }
    if (!state.title) {
      const folder = basename(dirname(file)).replace(/^--/, '').replace(/--$/, '').replace(/-/g, ' ')
      state.title = folder || 'pi session'
    }
  }
  return state.title
}

function emptySnapshot(problem: string | null, detail: string): Snapshot {
  return {
    source: 'pi',
    sessionId: null,
    title: null,
    model: null,
    updatedAt: Date.now(),
    average: { tps: null, tokens: 0, durationMs: 0, turns: 0 },
    turns: [],
    streaming: false,
    live: null,
    problem,
    sourceDetail: detail
  }
}

export function readSnapshot(file?: string): Snapshot {
  const root = sessionsRoot()
  if (!existsSync(root)) {
    return emptySnapshot(`No pi sessions at ${root}. Set a path in Settings → Plugins → OpenCode TPS.`, root)
  }
  const all = listFiles()
  const chosen = file && all.some((entry) => entry.file === file) ? file : all[0]?.file
  if (!chosen) return emptySnapshot('pi has no sessions yet.', root)

  try {
    const state = stateFor(chosen)
    const stat = statSync(chosen)
    const stamp = `${stat.size}:${stat.mtimeMs}`
    if (stamp === state.stamp && state.offset > 0) return snapshotOf(chosen, state, stat.mtimeMs)
    scan(chosen, state)
    state.stamp = stamp
    return snapshotOf(chosen, state, stat.mtimeMs)
  } catch (error) {
    return emptySnapshot(`Cannot read ${chosen}: ${String(error)}`, chosen)
  }
}

/** Built fresh each time: the array is small (turns, not messages). */
function snapshotOf(file: string, state: PiFile, mtimeMs: number): Snapshot {
  const turns = buildTurns(state.steps)
  const lastTurn = turns[turns.length - 1]
  return {
    source: 'pi',
    sessionId: file,
    title: titleOf(file),
    model: lastTurn?.model ?? null,
    updatedAt: mtimeMs,
    average: summarise(turns),
    turns: turns.slice(-TURN_LIMIT).reverse(),
    streaming: false,
    live: null,
    problem: null,
    sourceDetail: file
  }
}

export function listSessions(limit = 25): SessionSummary[] {
  return listFiles()
    .slice(0, Math.max(1, limit))
    .map((entry) => ({
      id: entry.file,
      title: titleOf(entry.file),
      updatedAt: entry.mtimeMs,
      model: null,
      source: 'pi' as const
    }))
}

/** The sessions folder to watch; pi appends a line there for every finished step. */
export function watchRoot(): string | null {
  const root = sessionsRoot()
  return existsSync(root) ? root : null
}
