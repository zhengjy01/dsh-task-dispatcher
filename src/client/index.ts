/**
 * dsh-task-dispatcher — browser half. Registers the dispatcher settings
 * panel into the web settings page (settings.section entry). The panel
 * configures the dispatch time, source list, filter, notify toggles, and
 * drives manual dispatches. Failure policy: registration problems are
 * logged, never thrown — the web shell fails the whole boot when a plugin
 * apply throws, and an external plugin must not take the GUI down.
 */
// Type-only: pulls the settings-surface SlotMap merge (the 'settings.section'
// entry) and the client runtime Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { TaskDispatcherSettingsPanel } from './TaskDispatcherSettingsPanel.tsx'

/** Required services. */
export const inject = ['slots']

/**
 * Register the dispatcher settings page.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  try {
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'task-dispatcher',
      order: 320,
      label: () => '任务派发器',
    }, TaskDispatcherSettingsPanel))
  } catch (error) {
    console.warn('[dsh-task-dispatcher] settings panel registration failed:', error)
  }
}
