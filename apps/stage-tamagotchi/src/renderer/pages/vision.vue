<script setup lang="ts">
import { useI18n } from 'vue-i18n'

import VisionCapture from '../components/vision-capture.vue'

const { t } = useI18n()
</script>

<template>
  <main :class="['h-full overflow-y-auto p-6', 'flex flex-col gap-6']">
    <h1 :class="['text-xl font-semibold']">
      {{ t('tamagotchi.settings.screen-capture.observation.title') }}
    </h1>
    <p :class="['text-sm text-neutral-500 dark:text-neutral-400']">
      {{ t('tamagotchi.settings.screen-capture.observation.host-description') }}
    </p>
    <VisionCapture />
  </main>
</template>

<route lang="yaml">
meta:
  layout: plain
</route>
