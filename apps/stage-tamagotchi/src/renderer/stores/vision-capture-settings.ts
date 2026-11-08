import type { VisionWorkloadId } from '@proj-airi/stage-ui/composables'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'

/** Durable capture choices. Native source IDs, permissions, and running state never survive a session. */
export const useVisionCaptureSettingsStore = defineStore('vision-capture-settings', () => {
  const restoreOnStartup = useLocalStorageManualReset('settings/vision/restore-on-startup', false)
  const sendContextUpdates = useLocalStorageManualReset('settings/vision/publish-context', false)
  const captureDownscalePercent = useLocalStorageManualReset('settings/vision/capture-downscale-percent', 100)
  const selectedWorkload = useLocalStorageManualReset<VisionWorkloadId>('settings/vision/capture-workload', 'screen:interpret')

  return { restoreOnStartup, sendContextUpdates, captureDownscalePercent, selectedWorkload }
})
