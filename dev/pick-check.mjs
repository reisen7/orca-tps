// What the status bar item would say right now, without waiting for an agent.
//   node --experimental-strip-types --import ./dev/register.mjs dev/pick-check.mjs
import { readSnapshot as readOpenCode } from '../src/opencode.ts'
import { readSnapshot as readPi } from '../src/pi.ts'

const RECENT_MS = 10 * 60_000
const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB')

const sources = [
  ['opencode', readOpenCode()],
  ['pi', readPi()]
]

for (const [name, snapshot] of sources) {
  const last = snapshot.turns.find((turn) => turn.tps !== null)
  const live = snapshot.live?.tps ?? null
  console.log(
    [
      name.padEnd(9),
      `updated ${clock(snapshot.updatedAt)}`,
      `live ${live === null ? '-' : live.toFixed(0)}`,
      `last ${last?.tps ? last.tps.toFixed(0) : '-'}`,
      `avg ${snapshot.average.tps ? snapshot.average.tps.toFixed(0) : '-'}`,
      snapshot.problem ? `problem ${snapshot.problem}` : ''
    ].join('  ')
  )
}

// The same rule as src/worker.ts: a live session wins, else the most recently written one.
const ready = []
for (const [name, snapshot] of sources) {
  if (!snapshot.sessionId) continue
  const live = snapshot.live?.tps ?? null
  const last = snapshot.turns.find((turn) => turn.tps !== null)?.tps ?? null
  const tps = live ?? last
  if (tps === null) continue
  ready.push({ name, tps, live: live !== null, updatedAt: snapshot.updatedAt })
}
const live = ready.filter((entry) => entry.live)
const pool = live.length > 0 ? live : ready.filter((entry) => Date.now() - entry.updatedAt < RECENT_MS)
const candidates = pool.length > 0 ? pool : ready
const winner =
  candidates.length === 0
    ? null
    : candidates.reduce((left, right) => (right.updatedAt > left.updatedAt ? right : left))

console.log(
  '\nitem:',
  winner === null
    ? 'tok/s –'
    : `${winner.name === 'pi' ? 'pi' : 'OC'} ${winner.live ? '~' : ''}${winner.tps.toFixed(0)} tok/s`
)
