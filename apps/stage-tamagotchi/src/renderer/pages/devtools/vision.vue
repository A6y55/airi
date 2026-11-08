<script setup lang="ts">
import { errorMessageFrom } from '@moeru/std'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { Alert, Button, FieldCheckbox } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { electronOpenVisionWindow } from '../../../shared/eventa/vision'
import { useVisionCaptureSettingsStore } from '../../stores/vision-capture-settings'

const { t } = useI18n()
const { restoreOnStartup } = storeToRefs(useVisionCaptureSettingsStore())
const openVisionWindow = useElectronEventaInvoke(electronOpenVisionWindow)
const errorMessage = ref('')
const opening = ref(false)

async function openObservation() {
  opening.value = true
  errorMessage.value = ''
  try {
    await openVisionWindow({})
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? 'Unknown error'
  }
  finally {
    opening.value = false
  }
}
</script>

<template>
  <div :class="['flex flex-col gap-6']">
    <p>{{ t('tamagotchi.settings.screen-capture.observation.host-description') }}</p>
    <FieldCheckbox
      v-model="restoreOnStartup"
      :label="t('tamagotchi.settings.screen-capture.observation.startup-label')"
      :description="t('tamagotchi.settings.screen-capture.observation.startup-description')"
    />
    <Button
      :label="t('tamagotchi.settings.screen-capture.observation.open')"
      icon="i-solar:screen-share-line-duotone"
      :loading="opening"
      @click="openObservation()"
    />
    <Alert v-if="errorMessage" tone="danger" role="alert">
      {{ errorMessage }}
    </Alert>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
</route>
