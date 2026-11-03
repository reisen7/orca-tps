# TPS

Shows how fast an agent is generating, in tokens per second, in Orca's status bar — the bottom of
the window. There is no panel to open and nothing to switch by hand.

It reads two tools:

- **OpenCode** — from `~/.local/share/opencode/opencode.db`.
- **pi** — from the JSONL session files under `~/.pi/agent/sessions`.

Both use the same maths: a turn is `(output + reasoning) tokens / time spent generating`, so
reasoning counts, and a turn is the assistant steps between two of your messages (tool loops
included). That is what each tool's own interface reports.

## What the item shows

`pi 67 tok/s`, `OC 35 tok/s`, `OC ~128 tok/s`.

- The short tag says which tool the number belongs to.
- A number on its own is the last finished turn.
- `~` means a live estimate: OpenCode writes the text into its database as it arrives, so the
  worker measures characters per second and divides by four. It becomes a real number when the
  step ends. pi writes a step only once it is finished, so it has no live estimate.
- `–` means there is nothing to measure yet.

**Colour carries meaning**, so the number reads at a glance:

| Colour | Meaning |
| --- | --- |
| Green | text is arriving right now, or the last turn ran at 100 tok/s or more |
| Plain | 20–99 tok/s |
| Amber | 8–19 tok/s |
| Red | under 8 tok/s |

(Orca's status bar only has a handful of tones; `accent` paints the same white as plain text, so
it is not used.)

Hovering the item shows the session title, the session average, the model and the tool.

**Which tool is shown.** Only one, so the item does not flip between two agents. A session that is
still writing text wins; otherwise the one written to most recently. A source idle for more than
ten minutes does not win over one in use.

## How much it reads

It never writes and never polls.

- OpenCode's database is opened `readOnly`. A message's metadata is read once; its JSON is fetched
  and parsed again only when `time_updated` moves. A streaming session costs one small row read per
  change, not a re-read of the session.
- pi's files are read incrementally: the worker remembers the byte offset it stopped at, so a file
  that grew by one line costs one line. A very large line is skipped rather than held in memory.
  The folder listing itself is reused for two seconds.
- Both are watched with `fs.watch` (a notification, not a poll), debounced to at most one read
  every 350 ms, and a source is only re-read when it changed.
- Measured on a 6 MB pi session: 23 ms for the first read, ~12 ms after. On the 116 MB session on
  this machine: 179 ms once, then cached. OpenCode: ~3 ms typical, 0 ms when nothing changed.

Orca reaps an idle plugin worker after five minutes, so the plugin also subscribes to
`agent.status.changed`: an agent starting or finishing wakes the worker and refreshes the number,
which is exactly when it should be re-read.

## Settings

Settings → Plugins → OpenCode TPS:

- **OpenCode database** — path to `opencode.db`, empty for the default (or `$XDG_DATA_HOME`).
- **pi sessions folder** — empty for `~/.pi/agent/sessions`.

## Access it asks for

- `trusted-worker` — its own Node process, with your user account's access to this machine, because
  that is the only way to read those files.
- `agent:read` — to be told when an agent starts or stops working, so the number refreshes.
- `settings:own` — the two paths above.

It contributes one status bar item, one event subscription, and runs no commands or hooks.

## A note on the Orca version

`contributes.statusBarItems` is documented as Orca 1.4.248+, and the manifest validator refuses
anything lower, so `engines.orca` is `>=1.4.248`. It does work on 1.4.247 as well — that build
already draws plugin status bar items, but has no `orca.statusBar` object, so the worker calls the
`statusBar.update` host call directly (`orca.host.has('statusBar.update')` decides, and a build
without it simply keeps the manifest's placeholder).

## Develop

```sh
orca plugin dev load .          # asks for the access above, then loads the folder
orca plugin shot . --status-bar # PNG of the status bar as Orca draws it
orca plugin dev request . tps.snapshot --data '{"source":"pi"}' --json
orca plugin validate .
```

`orca plugin test` is broken in Orca 1.4.247 (the shipped test runtime cannot find its own
modules), so the dev scripts stand in:

```sh
node --experimental-strip-types --import ./dev/register.mjs dev/harness.mjs     # OpenCode, with a fake streaming message
node --experimental-strip-types --import ./dev/register.mjs dev/pi-check.mjs   # real pi files and their timings
node --experimental-strip-types --import ./dev/register.mjs dev/pick-check.mjs # both sources, and which one wins
```

`dev/harness.mjs` runs the OpenCode reader against a copy of the real database that holds one
message which is still streaming, so the live estimate and the finished turn rate can be checked
without waiting for an agent. `dev/pick-check.mjs` prints what the status bar would show right now.
`dev/register.mjs` only adds the file-extension resolution that Orca's plugin loader does for you.

## Files

- `src/worker.ts` — watching both sources, choosing which to show, and the status bar item.
- `src/opencode.ts` — OpenCode's database, its parse cache and the live estimate.
- `src/pi.ts` — pi's session files and the incremental scan.
- `src/turns.ts` — turns, rates and averages, shared by both.
- `src/protocol.ts` — the snapshot shape and the one request kept for checking it.

## Publish

The folder is a plugin on its own: push it to a repository, tag `v<version>` and add the
`orca-plugin` topic. Orca names the publisher after the repository owner. `orca plugin release-entry
.` prints the catalog entry once the commit is tagged.
