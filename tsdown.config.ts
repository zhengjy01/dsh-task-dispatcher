/**
 * Standalone build config for the dsh-task-dispatcher plugin.
 *
 * Uses the bundled shared client-bundle preset (shared/tsdown.client.ts,
 * vendored from the dsh-web-ui family repo): node-half lib/ plus the
 * browser bundle lib/client.js (closure-factory artifact for the GUI's
 * __ModuleLoader__, served at /plugins/task-dispatcher/client.js).
 */
import { clientBundle } from './shared/tsdown.client.ts'

export default clientBundle('dsh-task-dispatcher', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-tools',
    'dsh-ticktick',
  ],
})
