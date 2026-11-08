import type { StorageLike } from '@vueuse/core'

import type { CompanionProviderStorage } from '../../shared/eventa/companion'
import type { RendererWindowContext } from '../window-context'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { toast } from 'vue-sonner'

import { companionInitializeProviderStorage, companionProviderStorageKeys, companionWriteProviderStorage } from '../../shared/eventa/companion'
import { i18n } from '../modules/i18n'

/** Decrypt or migrate before store creation. Only the Pinia leader persists subsequent snapshots. */
export async function initializeProviderStorage(leadership: RendererWindowContext['leadership']): Promise<StorageLike> {
  const initialize = useElectronEventaInvoke(companionInitializeProviderStorage)
  const persist = useElectronEventaInvoke(companionWriteProviderStorage)
  const candidates: CompanionProviderStorage = {}
  for (const key of companionProviderStorageKeys)
    candidates[key] = localStorage.getItem(key)

  const snapshot = await initialize(candidates)
  // The main process acknowledges migration only after the encrypted vault reaches disk.
  for (const key of companionProviderStorageKeys)
    localStorage.removeItem(key)

  function isProviderStorageKey(key: string): key is typeof companionProviderStorageKeys[number] {
    const keys: readonly string[] = companionProviderStorageKeys
    return keys.includes(key)
  }

  function write(key: string, value: string | null) {
    if (!isProviderStorageKey(key))
      throw new TypeError('Unsupported provider storage key')

    snapshot[key] = value
    // Replicated Pinia state also updates follower caches. Only its leader owns disk writes.
    if (leadership === 'leader-only') {
      void persist({ key, value }).catch(() => {
        toast.error(i18n.global.t('tamagotchi.companion.credentials-save-failed'), {
          id: 'provider-storage-save-failed',
          duration: Number.POSITIVE_INFINITY,
        })
      })
    }
  }

  return {
    getItem(key) {
      return isProviderStorageKey(key) ? snapshot[key] ?? null : null
    },
    setItem(key, value) {
      write(key, value)
    },
    removeItem(key) {
      write(key, null)
    },
  }
}
