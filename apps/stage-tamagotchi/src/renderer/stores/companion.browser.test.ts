import type * as ElectronVueuse from '@proj-airi/electron-vueuse'

import en from '@proj-airi/i18n/locales/en'

import { setupSynced, usePiniaSynced } from '@proj-airi/stage-ui/libs/pinia'
import { useConsciousnessSettingsStore } from '@proj-airi/stage-ui/stores/modules/consciousness-settings'
import { createPinia, disposePinia } from 'pinia'
import { expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'

import { useCompanionStore } from './companion'

// The native gateway is the IPC boundary. Startup and persistent Pinia preferences remain real.
vi.mock('@proj-airi/electron-vueuse', async original => ({
  ...await original<typeof ElectronVueuse>(),
  useElectronEventaInvoke: () => async () => ({
    baseURL: 'http://127.0.0.1:1',
    token: 'test-session',
    jevConfigured: false,
    memoryEnabled: false,
    binaryPath: 'sag',
    archivePath: 'test-memory',
    sagVersion: '',
    sagError: '',
  }),
}))

it('preserves saved reasoning and sampling preferences when the companion restarts', async () => {
  localStorage.setItem('companion/setup-version', '1')
  localStorage.setItem('settings/consciousness/reasoning', 'false')
  localStorage.setItem('settings/consciousness/temperature-enabled', 'true')
  localStorage.setItem('settings/consciousness/top-p-enabled', 'true')
  const pinia = createPinia()
  const synced = setupSynced({ leadership: 'leader-only' })
  pinia.use(synced.pinia)
  let companion!: ReturnType<typeof useCompanionStore>
  const app = createApp({ setup() {
    companion = useCompanionStore()
    return () => null
  } }).use(synced.vue).use(pinia).use(createI18n({ legacy: false, locale: 'en', messages: { en } }))
  app.mount(document.createElement('div'))
  const runtime = app.runWithContext(usePiniaSynced)
  try {
    await vi.waitFor(() => expect(runtime.isLeader()).toBe(true))
    await companion.initialize()
    expect(companion.error).toBe('')
    const settings = useConsciousnessSettingsStore(pinia)
    expect(settings.reasoning).toBe(false)
    expect(settings.temperatureEnabled).toBe(true)
    expect(settings.topPEnabled).toBe(true)
    expect(localStorage.getItem('settings/consciousness/reasoning')).toBe('false')
    expect(localStorage.getItem('settings/consciousness/temperature-enabled')).toBe('true')
    expect(localStorage.getItem('settings/consciousness/top-p-enabled')).toBe('true')
  }
  finally {
    companion.dispose()
    app.unmount()
    disposePinia(pinia)
    localStorage.clear()
  }
})
