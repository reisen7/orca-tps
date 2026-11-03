// Local harness: runs the plugin worker with a mock `orca` object, against a copy of the real
// OpenCode database that has one fake message still streaming.
//   node --experimental-strip-types dev/harness.mjs
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const here = dirname(fileURLToPath(import.meta.url))
const real = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.local', 'share', 'opencode', 'opencode.db')
const sandbox = join(tmpdir(), 'orca-tps-harness')
rmSync(sandbox, { recursive: true, force: true })
mkdirSync(join(sandbox, 'opencode'), { recursive: true })
const copy = join(sandbox, 'opencode', 'opencode.db')
copyFileSync(real, copy)

const session = 'ses_harness'
const now = Date.now()
const db = new DatabaseSync(copy)
db.exec('pragma foreign_keys = off')
db.exec(
  `insert into session_v2 (id, project_id, slug, directory, version, title, time_created, time_updated)
   values ('${session}', 'p_harness', 'harness', 'D:/tmp', '2.2.1', 'harness', ${now}, ${now})`
)
const insert = db.prepare(
  'insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?)'
)
const user = { time: { created: now - 3000 }, text: 'hi' }
insert.run('m_user', session, 'user', 1, now - 3000, now - 3000, JSON.stringify(user))

// A message still being written: created, no completed, text growing.
function live(id, chars, created) {
  const data = {
    time: { created },
    agent: 'build',
    model: { id: 'fake-model' },
    content: [{ type: 'text', text: 'x'.repeat(chars) }]
  }
  insert.run(id, session, 'assistant', 2, created, created, JSON.stringify(data))
}
live('m_live', 400, now - 2000)
db.close()

process.env.XDG_DATA_HOME = sandbox

const handlers = new Map()
const posts = []
const orca = {
  panels: {
    handle: (name, fn) => handlers.set(name, fn),
    post: (event, payload) => posts.push({ event, payload })
  },
  events: { on: () => ({ dispose() {} }) },
  // No status bar in the harness: `has` says so, and the worker leaves the item alone.
  host: { has: () => false, call: async () => ({}) },
  settings: { get: async () => '', onDidChange: () => ({ dispose() {} }) }
}
const worker = (await import('../src/worker.ts')).default
worker(orca)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const first = await handlers.get('tps.snapshot')(null)
console.log('problem:', first.problem)
console.log('streaming:', first.streaming)
console.log('live 1:', first.live)

// The text grows by 2000 characters over the next second: about 500 tok/s at 4 chars a token.
const db2 = new DatabaseSync(copy)
const grew = {
  time: { created: now - 2000 },
  agent: 'build',
  model: { id: 'fake-model' },
  content: [{ type: 'text', text: 'y'.repeat(2400) }]
}
db2.prepare('update session_message set data = ?, time_updated = ? where id = ?').run(JSON.stringify(grew), Date.now(), 'm_live')
db2.close()
await wait(1000)

const second = await handlers.get('tps.snapshot')(null)
console.log('live 2:', second.live, '-> expect roughly', Math.round(2000 / 4 / 1), 'tok/s')

// The step ends: tokens arrive and the turn gets a real rate.
const db3 = new DatabaseSync(copy)
const done = {
  time: { created: now - 2000, streamed: now - 200, completed: now },
  agent: 'build',
  model: { id: 'fake-model' },
  tokens: { input: 10, output: 600, reasoning: 200, cache: { read: 0, write: 0 } },
  content: [{ type: 'text', text: 'y'.repeat(2400) }]
}
db3.prepare('update session_message set data = ?, time_updated = ? where id = ?').run(JSON.stringify(done), Date.now(), 'm_live')
db3.close()

const third = await handlers.get('tps.snapshot')(null)
console.log('live after end:', third.live)
console.log('last turn:', third.turns[0])
console.log('average:', third.average)

// The worker's file watcher keeps Node alive; nothing else is pending.
process.exit(0)
