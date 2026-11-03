// The plugin's worker: keeps Orca's status bar showing how fast the agent is generating, in
// tokens per second, for OpenCode (its database) and for pi (its session files).
//
// There is no panel: the worker shows only the busiest tool — one that is still writing wins,
// otherwise the one used most recently — so nothing has to be switched by hand.
//
// Orca starts it when the plugin is enabled, transpiles this file when it loads (no build step)
// and restarts it on save. It only reads: OpenCode's database read-only, pi's session files as
// text, and both are watched with a notification (never a poll).
import type { OrcaWorkerApi } from 'orca/worker'
import { watch, type FSWatcher } from 'node:fs'
import { readSnapshot as readOpenCode, setDatabasePath, watchDirectory } from './opencode'
import { readSnapshot as readPi, setSessionsRoot, watchRoot } from './pi'
import type { Snapshot, Source } from './protocol'

const DEBOUNCE_MS = 350
/** The item id declared in orca-plugin.json. */
const ITEM = 'tps'

let databaseSetting = ''
let piSetting = ''

function isSource(value: unknown): value is Source {
  return value === 'opencode' || value === 'pi'
}

/** Short label, so a glance tells you which tool the number belongs to. */
const SOURCE_TAG: Record<Source, string> = { opencode: 'OC', pi: 'pi' }
const SOURCE_NAME: Record<Source, string> = { opencode: 'OpenCode', pi: 'pi' }

/** What the number means: a live estimate while text is arriving, or the last finished turn. */
type Reading = { kind: 'live'; tps: number } | { kind: 'idle'; tps: number } | null

function reading(snapshot: Snapshot): Reading {
  if (snapshot.live && snapshot.live.tps !== null) return { kind: 'live', tps: snapshot.live.tps }
  const last = snapshot.turns.find((turn) => turn.tps !== null)
  if (!last || last.tps === null) return null
  return { kind: 'idle', tps: last.tps }
}

/**
 * Colour carries meaning, and only green, amber and red differ from the status bar's own text, so
 * the bands are: green while text is arriving and for a fast rate, plain for an ordinary one,
 * amber when it slows down and red when it crawls.
 */
function toneFor(entry: Shown | null): string {
  if (entry === null) return 'neutral'
  if (entry.value.kind === 'live') return 'success'
  if (entry.value.tps >= 100) return 'success'
  if (entry.value.tps >= 20) return 'neutral'
  if (entry.value.tps >= 8) return 'warning'
  return 'danger'
}

/** A source counts as in use if it was written to this recently, so an old number does not win. */
const RECENT_MS = 10 * 60_000

interface Shown {
  source: Source
  snapshot: Snapshot
  value: { kind: 'live' | 'idle'; tps: number }
}

/**
 * The one number to show: a session that is still writing text wins, otherwise the one written to
 * most recently. Both tools are read, but only the busiest is displayed.
 */
function shown(both: Array<[Source, Snapshot | null]>): Shown | null {
  const ready: Shown[] = []
  for (const [source, snapshot] of both) {
    if (!snapshot || snapshot.sessionId === null) continue
    const value = reading(snapshot)
    if (value === null) continue
    ready.push({ source, snapshot, value })
  }
  const live = ready.filter((entry) => entry.value.kind === 'live')
  const pool =
    live.length > 0
      ? live
      : ready.filter((entry) => Date.now() - entry.snapshot.updatedAt < RECENT_MS)
  const candidates = pool.length > 0 ? pool : ready
  if (candidates.length === 0) return null
  return candidates.reduce((left, right) => (right.snapshot.updatedAt > left.snapshot.updatedAt ? right : left))
}

/** `pi 67 tok/s`, or `OC ~128 tok/s` while OpenCode is still writing. */
function textOf(entry: Shown | null): string {
  if (entry === null) return 'tok/s –'
  const mark = entry.value.kind === 'live' ? '~' : ''
  return `${SOURCE_TAG[entry.source]} ${mark}${entry.value.tps.toFixed(0)} tok/s`
}

function tooltipOf(entry: Shown | null): string {
  if (entry === null) return 'No session yet'
  const bits = [SOURCE_NAME[entry.source], entry.snapshot.title || 'Untitled session']
  if (entry.snapshot.average.tps !== null) bits.push(`avg ${entry.snapshot.average.tps.toFixed(0)} tok/s`)
  if (entry.snapshot.model) bits.push(entry.snapshot.model)
  return bits.join(' · ')
}

export default function activate(orca: OrcaWorkerApi): void {
  const watchers: FSWatcher[] = []
  const watched = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = false

  const snapshots: Record<Source, Snapshot | null> = { opencode: null, pi: null }
  const stale: Record<Source, boolean> = { opencode: true, pi: true }

  const ready = (async () => {
    const [databaseValue, piValue] = await Promise.all([
      orca.settings.get('databasePath').catch(() => ''),
      orca.settings.get('piSessionsPath').catch(() => '')
    ])
    if (typeof databaseValue === 'string' && databaseValue) {
      databaseSetting = databaseValue
      setDatabasePath(databaseValue)
    }
    if (typeof piValue === 'string' && piValue) {
      piSetting = piValue
      setSessionsRoot(piValue)
    }
  })().catch(() => undefined)

  let lastText = ''
  let lastTone = ''

  // Orca 1.4.247 has no `orca.statusBar` object yet, but it does serve the `statusBar.update` host
  // call, so that is what is used; a build without either simply shows the manifest's placeholder.
  const setStatus = () => {
    if (typeof orca.host?.has !== 'function' || !orca.host.has('statusBar.update')) return
    const entry = shown([
      ['opencode', snapshots.opencode],
      ['pi', snapshots.pi]
    ])
    const text = textOf(entry)
    const tone = toneFor(entry)
    if (text === lastText && tone === lastTone) return
    lastText = text
    lastTone = tone

    void orca.host
      .call('statusBar.update', { id: ITEM, text, tone, tooltip: tooltipOf(entry) })
      .catch(() => {
        // The item may not be drawn yet right after the plugin starts: forget what was shown so
        // the next change sends it again.
        lastText = ''
        lastTone = ''
      })
  }

  const publish = () => {
    for (const source of ['opencode', 'pi'] as Source[]) {
      if (!stale[source]) continue
      try {
        snapshots[source] = source === 'pi' ? readPi() : readOpenCode()
        stale[source] = false
      } catch {
        /* the next change tries again */
      }
    }
    setStatus()
  }

  const schedule = (source?: Source) => {
    if (source) stale[source] = true
    else {
      stale.opencode = true
      stale.pi = true
    }
    pending = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (!pending) return
      pending = false
      try {
        publish()
      } catch {
        /* the next change tries again */
      }
    }, DEBOUNCE_MS)
  }

  const watchDir = (dir: string, source: Source, recursive: boolean) => {
    if (watched.has(dir)) return
    try {
      const watcher = watch(dir, { recursive }, () => schedule(source))
      watched.add(dir)
      watcher.on('error', () => {
        watcher.close()
        watched.delete(dir)
        const index = watchers.indexOf(watcher)
        if (index >= 0) watchers.splice(index, 1)
      })
      watchers.push(watcher)
    } catch {
      /* not being able to watch is not fatal: the number simply stops moving */
    }
  }

  const startWatching = () => {
    const dbDirectory = watchDirectory()
    if (dbDirectory) watchDir(dbDirectory, 'opencode', false)
    const piDirectory = watchRoot()
    if (piDirectory) watchDir(piDirectory, 'pi', true)
  }

  // Orca reaps an idle worker after five minutes, and an agent starting or finishing is exactly
  // when the number should be read again: the event wakes the worker if it was reaped, and this
  // listener refreshes it if it is still running.
  orca.events?.on?.('agent.status.changed', () => schedule())

  // Kept for `orca plugin dev request . tps.snapshot --data '{"source":"pi"}'`, which is how the
  // numbers are checked from a terminal without a panel.
  orca.panels.handle('tps.snapshot', async (input) => {
    await ready
    const source: Source = isSource(input?.source) ? input.source : 'opencode'
    const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : undefined
    return source === 'pi' ? readPi(sessionId) : readOpenCode(sessionId)
  })

  void ready.then(() => {
    startWatching()
    const fill = () => {
      try {
        publish()
      } catch {
        /* the next change tries again */
      }
    }
    // Right after the plugin starts the item may not be drawn yet; the first call would be lost.
    fill()
    setTimeout(fill, 1500)
    setTimeout(fill, 5000)
  })

  // Settings can change while the worker runs: re-read the path and watch the new place.
  const reloadSetting = async (key: string) => {
    const value = await orca.settings.get(key)
    if (typeof value !== 'string') return
    if (key === 'databasePath' && value !== databaseSetting) {
      databaseSetting = value
      setDatabasePath(value)
      stale.opencode = true
      startWatching()
    }
    if (key === 'piSessionsPath' && value !== piSetting) {
      piSetting = value
      setSessionsRoot(value)
      stale.pi = true
      startWatching()
    }
  }
  orca.settings.onDidChange?.((change: { key?: string }) => {
    if (change && typeof change.key === 'string') void reloadSetting(change.key)
  })
}
