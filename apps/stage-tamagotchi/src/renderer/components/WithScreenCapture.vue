<script setup lang="ts">
import type { SourcesOptions } from 'electron'

import { errorMessageFrom } from '@moeru/std'
import { useElectronScreenCapture } from '@proj-airi/electron-screen-capture/vue'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { Alert, Button } from '@proj-airi/ui'
import { useWindowFocus } from '@vueuse/core'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { onMounted, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  sourcesOptions: SourcesOptions
}>()

const emit = defineEmits<{
  permissionGranted: []
  permissionRevoked: []
}>()

const sourcesOptions = toRef(props, 'sourcesOptions')

const hasPermissions = ref(false)
const showDialog = ref(false)
const permissionError = ref('')

const { t } = useI18n()
const {
  getSources,
  setSource,
  resetSource,
  selectWithSource,
  checkMacOSPermission,
  requestMacOSPermission,
} = useElectronScreenCapture(getElectronEventaContext(), sourcesOptions)

const focused = useWindowFocus()

async function checkPermissions() {
  try {
    permissionError.value = ''
    hasPermissions.value = window.platform !== 'darwin' || await checkMacOSPermission() === 'granted'
    showDialog.value = !hasPermissions.value
  }
  catch (error) {
    hasPermissions.value = false
    permissionError.value = errorMessageFrom(error) ?? 'Unknown error'
  }
}

async function requestPermission() {
  if (window.platform === 'darwin') {
    await requestMacOSPermission()
  }
}

onMounted(async () => {
  await checkPermissions()
})

watch(focused, async (isFocused) => {
  if (isFocused) {
    await checkPermissions()
  }
})

watch(hasPermissions, (nextHasPermissions, previousHasPermissions) => {
  if (nextHasPermissions && !previousHasPermissions) {
    emit('permissionGranted')
  }
  else if (!nextHasPermissions && previousHasPermissions) {
    emit('permissionRevoked')
  }
})
</script>

<template>
  <Alert v-if="permissionError" tone="danger" role="alert">
    {{ permissionError }}
  </Alert>
  <slot
    v-bind="{
      getSources,
      setSource,
      resetSource,
      selectWithSource,
      hasPermissions,
      checkPermissions,
      requestPermission,
    }"
  />

  <DialogRoot :open="showDialog">
    <DialogPortal>
      <DialogOverlay :class="['fixed inset-0 z-9999', 'bg-black/50 backdrop-blur-sm', 'data-[state=closed]:animate-fadeOut data-[state=open]:animate-fadeIn']" />
      <DialogContent
        :class="[
          'fixed left-1/2 top-1/2 z-9999 max-h-full max-w-2xl w-[92dvw]',
          'flex flex-col items-start gap-4 overflow-y-scroll scrollbar-none',
          'transform -translate-x-1/2 -translate-y-1/2 rounded-2xl p-6',
          'bg-white dark:bg-neutral-900 shadow-xl outline-none backdrop-blur-md',
          'data-[state=closed]:animate-contentHide data-[state=open]:animate-contentShow',
        ]"
      >
        <DialogTitle :class="['m-0 text-lg font-semibold']">
          {{ t('tamagotchi.settings.screen-capture.permissions-prompt.title') }}
        </DialogTitle>

        <DialogDescription>
          {{ t('tamagotchi.settings.screen-capture.permissions-prompt.description') }}

          <ol :class="['mt-4 list-decimal pl-5 text-sm']">
            <li :class="['mb-1']">
              {{ t('tamagotchi.settings.screen-capture.permissions-prompt.instructions.step-1') }}
            </li>
            <li>
              {{ t('tamagotchi.settings.screen-capture.permissions-prompt.instructions.step-2') }}
              <br>
              <span :class="['text-neutral-500']">
                {{ t('tamagotchi.settings.screen-capture.permissions-prompt.instructions.step-2-note') }}
              </span>
            </li>
          </ol>
        </DialogDescription>

        <div :class="['flex flex-row justify-end gap-2 mt-4 w-full']">
          <Button @click="showDialog = false">
            {{ t('tamagotchi.settings.screen-capture.permissions-prompt.dismiss') }}
          </Button>
          <Button @click="requestMacOSPermission()">
            {{ t('tamagotchi.settings.screen-capture.permissions-prompt.open-preferences') }}
          </Button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
