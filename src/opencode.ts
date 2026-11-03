// OpenCode's own database: sessions, message steps, and a live estimate while text arrives.
//
// The database is only ever opened read-only, and a message is fetched and parsed once, then
// reused while its `time_updated` stays the same, so a streaming turn costs one small row read
// instead of the whole session.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Snapshot } from './protocol'
import { buildTurns, summarise, TURN_LIMIT, type Step } from './turns'

/** Beyond this many cached messages, start over rather than grow forever. */
const CACHE_LIMIT = 4000
/** SQLite's variable limit is 32766 in modern builds; stay well under it. */
const IN_CHUNK = 400

let configuredPath = ''

/** Where OpenCode keeps its database, unless the person pointed the setting elsewhere. */
export function databasePath(): string {
  if (configuredPath.trim()) return configuredPath.trim()
  const dataHome = (process.env.XDG_DATA_HOME ?? '').trim()
  const base = dataHome || join(homedir(), '.local', 'share')
  return join(base, 'opencode', 'opencode.db')
}

export function setDatabasePath(value: string): void {
  configuredPath = value
}

interface MetaRow {
  id: string
  type?: string
  time_created: number
  time_updated: number
}

/** One message, parsed once and kept while its row does not change. */
interface Message {
  id: string
  time_updated: number
  role: string
  created: number
  streamed?: number
  completed?: number
  output: number
  reasoning: number
  model: string | null
  /** Characters of text (including reasoning) written so far: what the live estimate samples. */
  chars: number
}

const cache = new Map<string, Message>()

function openDb(file: string): DatabaseSync {
  return new DatabaseSync(file, { readOnly: true })
}

function query(db: DatabaseSync, sql: string, ...params: Array<string | number>): any[] {
  return db.prepare(sql).all(...params) as any[]
}

/** Characters of text (and reasoning) in the message's content parts. */
function writtenChars(data: any): number {
  const content = Array.isArray(data?.content) ? data.content : []
  let chars = 0
  for (const part of content) {
    if (part && typeof part.text === 'string') chars += part.text.length
  }
  return chars
}

function parseMessage(meta: MetaRow, text: string | undefined): Message | null {
  if (typeof text !== 'string' || !text) return null
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const tokens = data.tokens && typeof data.tokens === 'object' ? data.tokens : {}
  const time = data.time ?? {}
  return {
    id: meta.id,
    time_updated: meta.time_updated,
    role: meta.type ?? (tokens.output === undefined ? 'user' : 'assistant'),
    created: typeof time.created === 'number' ? time.created : meta.time_created,
    streamed: typeof time.streamed === 'number' ? time.streamed : undefined,
    completed: typeof time.completed === 'number' ? time.completed : undefined,
    output: typeof tokens.output === 'number' ? tokens.output : 0,
    reasoning: typeof tokens.reasoning === 'number' ? tokens.reasoning : 0,
    model: data.model?.id ?? data.model?.modelID ?? null,
    chars: writtenChars(data)
  }
}

/**
 * Every message of one session, newest data only: the metadata query is small (SQLite does not
 * read a large text column until it is selected), and only rows whose `time_updated` moved are
 * fetched and parsed again.
 */
function loadMessages(db: DatabaseSync, sessionId: string): Message[] {
  if (cache.size > CACHE_LIMIT) cache.clear()
  const meta = query(
    db,
    `select id, type, time_created, time_updated from session_message
      where session_id = ? order by time_created asc`,
    sessionId
  ) as MetaRow[]

  const changed = meta.filter((row) => cache.get(row.id)?.time_updated !== row.time_updated)
  for (let index = 0; index < changed.length; index += IN_CHUNK) {
    const slice = changed.slice(index, index + IN_CHUNK)
    const marks = slice.map(() => '?').join(',')
    const rows = query(db, `select id, data from session_message where id in (${marks})`, ...slice.map((row) => row.id))
    const byId = new Map<string, string>(rows.map((row) => [row.id, row.data]))
    for (const row of slice) {
      const message = parseMessage(row, byId.get(row.id))
      if (message) cache.set(row.id, message)
      else cache.delete(row.id)
    }
  }

  const messages: Message[] = []
  for (const row of meta) {
    const message = cache.get(row.id)
    if (message) messages.push(message)
  }
  return messages
}

function steps(messages: Message[]): Step[] {
  return messages.map((message) => {
    // OpenCode stamps `streamed` when text starts arriving and writes `tokens` only when the
    // step ends, so a step without `completed` is still being written.
    const open = typeof message.completed !== 'number'
    const durationMs =
      message.streamed && message.streamed > message.created ? message.streamed - message.created : 0
    return {
      role: message.role,
      at: message.created,
      output: message.output,
      reasoning: message.reasoning,
      durationMs,
      model: message.model,
      open
    }
  })
}

interface LiveSample {
  id: string
  at: number
  chars: number
}
let liveSamples: LiveSample[] = []

/**
 * OpenCode writes a streaming message's text into the database as it arrives, but only fills
 * `tokens` when the step ends. So while it writes, measure characters per second and divide by
 * four: an estimate, which the status bar marks with a leading ~.
 */
function liveEstimate(messages: Message[]): { tps: number | null; chars: number } | null {
  let live: Message | null = null
  for (const message of messages) {
    if (message.role === 'assistant' && typeof message.completed !== 'number') live = message
  }
  if (!live) {
    liveSamples = []
    return null
  }
  const chars = live.chars
  const now = Date.now()
  if (liveSamples.length > 0 && liveSamples[liveSamples.length - 1].id !== live.id) liveSamples = []
  liveSamples.push({ id: live.id, at: now, chars })
  if (liveSamples.length > 6) liveSamples = liveSamples.slice(-6)

  const rates: number[] = []
  for (let index = 1; index < liveSamples.length; index += 1) {
    const previous = liveSamples[index - 1]
    const current = liveSamples[index]
    const seconds = (current.at - previous.at) / 1000
    const gained = current.chars - previous.chars
    if (seconds > 0.05 && gained > 0) rates.push(gained / 4 / seconds)
  }
  if (rates.length === 0) return { tps: null, chars }
  rates.sort((left, right) => left - right)
  return { tps: rates[Math.floor(rates.length / 2)], chars }
}

function sessionTable(db: DatabaseSync): string {
  const rows = query(db, `select name from sqlite_master where type = 'table' and name in ('session_v2', 'session')`)
  const names = rows.map((row) => row.name)
  return names.includes('session_v2') ? 'session_v2' : 'session'
}

function emptySnapshot(problem: string | null): Snapshot {
  return {
    source: 'opencode',
    sessionId: null,
    title: null,
    model: null,
    updatedAt: Date.now(),
    average: { tps: null, tokens: 0, durationMs: 0, turns: 0 },
    turns: [],
    streaming: false,
    live: null,
    problem,
    sourceDetail: databasePath()
  }
}

/** The last snapshot, handed back untouched when the session has not changed at all. */
let lastStamp = ''
let lastSnapshot: Snapshot | null = null

export function readSnapshot(sessionId?: string): Snapshot {
  const file = databasePath()
  if (!existsSync(file)) {
    return emptySnapshot(`No OpenCode database at ${file}. Set a path in Settings → Plugins → OpenCode TPS.`)
  }
  let db: DatabaseSync
  try {
    db = openDb(file)
  } catch (error) {
    return emptySnapshot(`Cannot open ${file}: ${String(error)}`)
  }
  try {
    const table = sessionTable(db)
    const sessions = query(db, `select id, title, time_updated, model from ${table} order by time_updated desc`)
    if (sessions.length === 0) return emptySnapshot('The database has no sessions yet.')

    const byId = new Map<string, any>(sessions.map((row) => [row.id, row]))
    let chosen = sessionId && byId.has(sessionId) ? sessionId : ''
    if (!chosen) chosen = sessions[0].id
    const session = byId.get(chosen)!

    const messages = loadMessages(db, chosen)
    let newestWrite = 0
    for (const message of messages) if (message.time_updated > newestWrite) newestWrite = message.time_updated
    const stamp = `${chosen}:${messages.length}:${newestWrite}`
    if (lastSnapshot && stamp === lastStamp) return lastSnapshot
    lastStamp = stamp

    const all = buildTurns(steps(messages))
    const lastTurn = all[all.length - 1]
    const live = liveEstimate(messages)
    const snapshot: Snapshot = {
      source: 'opencode',
      sessionId: chosen,
      title: session.title ?? null,
      model: lastTurn?.model ?? (typeof session.model === 'string' ? session.model : (session.model?.id ?? null)),
      // When the newest message was written: comparable with pi's file mtime.
      updatedAt: newestWrite || (typeof session.time_updated === 'number' ? session.time_updated : 0),
      average: summarise(all),
      turns: all.slice(-TURN_LIMIT).reverse(),
      streaming: Boolean(lastTurn?.live) || live !== null,
      live,
      problem: null,
      sourceDetail: file
    }
    lastSnapshot = snapshot
    return snapshot
  } catch (error) {
    lastSnapshot = null
    lastStamp = ''
    return emptySnapshot(`Cannot read ${file}: ${String(error)}`)
  } finally {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
}

/** The directory to watch for writes: the database and its -wal file live there. */
export function watchDirectory(): string | null {
  const file = databasePath()
  return existsSync(file) ? join(file, '..') : null
}
