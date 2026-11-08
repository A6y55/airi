<script setup lang="ts">
import type { TranscriptionProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import { TranscriptionPlayground, TranscriptionProviderSettings } from '@proj-airi/stage-ui/components'
import { useProviderValidation } from '@proj-airi/stage-ui/composables/use-provider-validation'
import { useHearingStore } from '@proj-airi/stage-ui/stores/modules/hearing'
import { useProviderConfigStore } from '@proj-airi/stage-ui/stores/providers/config'
import { useProviderStore } from '@proj-airi/stage-ui/stores/providers/provider'
import { Alert, FieldCombobox } from '@proj-airi/ui'
import { computed, onMounted } from 'vue'

const providerId = 'minimax-audio-transcription'
const defaultModel = 'asr-1.0'
const hearingStore = useHearingStore()
const providersStore = useProviderStore()
const providerStore = useProviderConfigStore()
const { t, isValid, isValidating, validationMessage } = useProviderValidation(providerId)

const model = computed({
  get: () => {
    const configuredModel = providerStore.getProviderConfig(providerId)?.model
    return typeof configuredModel === 'string' && configuredModel ? configuredModel : defaultModel
  },
  set: async (value: string) => {
    await providerStore.setProviderModel(providerId, value)
  },
})
const providerModels = computed(() => providersStore.getModelsForProvider(providerId))
const apiKeyConfigured = computed(() => Boolean(providerStore.getProviderConfig(providerId)?.apiKey))

onMounted(async () => {
  await providersStore.initializeProvider(providerId)
  await providersStore.fetchModelsForProvider(providerId)
})

async function handleGenerateTranscription(file: File) {
  const provider = await providersStore.getProviderInstance<TranscriptionProviderWithExtraOptions<string, Record<string, unknown>>>(providerId)
  if (!provider)
    throw new Error('Failed to initialize MiniMax ASR.')

  return hearingStore.transcription(providerId, provider, model.value, file, 'json')
}
</script>

<template>
  <TranscriptionProviderSettings :provider-id="providerId" :default-model="defaultModel">
    <template #basic-settings>
      <FieldCombobox
        v-model="model"
        :label="t('settings.pages.modules.consciousness.sections.section.provider-model-selection.manual_model_name')"
        :options="providerModels.map(item => ({ value: item.id, label: item.name }))"
        :disabled="providerModels.length === 0"
      />
      <Alert
        v-if="!isValid && isValidating === 0 && validationMessage"
        tone="danger"
        :title="t('settings.dialogs.onboarding.validationFailed')"
      >
        {{ validationMessage }}
      </Alert>
    </template>
    <template #playground>
      <TranscriptionPlayground
        :generate-transcription="handleGenerateTranscription"
        :api-key-configured="apiKeyConfigured"
      />
    </template>
  </TranscriptionProviderSettings>
</template>

<route lang="yaml">
meta:
  layout: settings
  stageTransition:
    name: slide
</route>
