// Node needs file extensions; Orca's plugin loader does not. This hook lets the dev scripts run
// the plugin's own TypeScript files unchanged: `node --experimental-strip-types --import
// ./dev/register.mjs dev/harness.mjs`.
import { register } from 'node:module'

register('./ts-resolver.mjs', import.meta.url)
