// Reads pi's real session files through the plugin's own module:
//   node --experimental-strip-types --import ./dev/register.mjs dev/pi-check.mjs
import { listSessions, readSnapshot, sessionsRoot } from '../src/pi.ts'

console.log('root', sessionsRoot())

let started = performance.now()
const sessions = listSessions(10)
console.log(`listSessions(10): ${(performance.now() - started).toFixed(0)}ms for ${sessions.length}`)
for (const session of sessions.slice(0, 5)) console.log(`  ${new Date(session.updatedAt).toISOString()}  ${session.title}`)

started = performance.now()
const first = readSnapshot()
console.log(`readSnapshot (newest): ${(performance.now() - started).toFixed(0)}ms`)
console.log(`  ${first.title}`)
console.log(`  average ${first.average.tps?.toFixed(1)} tok/s over ${first.average.turns} turns, ${first.average.tokens} tokens`)
for (const turn of first.turns.slice(0, 3)) {
  console.log(`  turn ${turn.tps?.toFixed(1)} tok/s · ${turn.tokens} tokens · ${(turn.durationMs / 1000).toFixed(1)}s · ${turn.model}`)
}

started = performance.now()
const second = readSnapshot(first.sessionId ?? undefined)
console.log(`readSnapshot (same file again): ${(performance.now() - started).toFixed(0)}ms`)
console.log(`  same numbers: ${second.average.tokens === first.average.tokens}`)

// The biggest file on disk, to check that the scan stays comfortable.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
let biggest = { file: '', size: 0 }
for (const name of readdirSync(sessionsRoot(), { recursive: true, encoding: 'utf8' })) {
  if (!name.endsWith('.jsonl')) continue
  const file = join(sessionsRoot(), name)
  const size = statSync(file).size
  if (size > biggest.size) biggest = { file, size }
}
started = performance.now()
const huge = readSnapshot(biggest.file)
console.log(`readSnapshot (${(biggest.size / 1024 / 1024).toFixed(0)}MB file): ${(performance.now() - started).toFixed(0)}ms`)
console.log(`  ${huge.average.turns} turns, average ${huge.average.tps?.toFixed(1)} tok/s`)
started = performance.now()
readSnapshot(biggest.file)
console.log(`  again: ${(performance.now() - started).toFixed(0)}ms`)
