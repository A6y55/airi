<script setup lang="ts">
import type { CompanionMemoryDocument } from '../../../shared/eventa/companion'

import { errorMessageFrom } from '@moeru/std'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useChatStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useSpeechOutputControlStore } from '@proj-airi/stage-ui/stores/speech-output-control'
import { Button, FieldCheckbox, FieldInput, SettingsCard, Textarea } from '@proj-airi/ui'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import {
  companionClearMemories,
  companionExportMemories,
  companionListMemories,
  companionReadMemory,
  companionRemoveMemory,
  companionSaveConfig,
  companionSearchMemory,
  companionTestProvider,
  companionWriteMemory,
} from '../../../shared/eventa/companion'
import { useCompanionStore } from '../../stores/companion'

const { t } = useI18n()
const text = (key: string, values: Record<string, unknown> = {}) => t(`tamagotchi.companion.${key}`, values)
const companion = useCompanionStore()
const cards = useAiriCardStore()
const sessions = useChatSessionStore()
const chat = useChatStore()
const speechOutput = useSpeechOutputControlStore()
const characterId = computed(() => cards.activeCardId)
const binaryPath = ref('')
const memoryEnabled = ref(true)
const busy = ref(false)
const feedback = ref('')
const failure = ref('')
const documents = ref<CompanionMemoryDocument[]>([])
const selectedId = ref('')
const content = ref('')
const confirmClear = ref(false)
const query = ref('')
const results = ref('')
const sourceCount = ref(0)
const saveConfig = useElectronEventaInvoke(companionSaveConfig)
const testProvider = useElectronEventaInvoke(companionTestProvider)
const listMemories = useElectronEventaInvoke(companionListMemories)
const readMemory = useElectronEventaInvoke(companionReadMemory)
const writeMemory = useElectronEventaInvoke(companionWriteMemory)
const removeMemory = useElectronEventaInvoke(companionRemoveMemory)
const clearMemories = useElectronEventaInvoke(companionClearMemories)
const exportMemories = useElectronEventaInvoke(companionExportMemories)
const searchMemory = useElectronEventaInvoke(companionSearchMemory)

async function run(action: () => Promise<void>) {
  busy.value = true
  failure.value = ''
  feedback.value = ''
  try {
    await action()
  }
  catch (cause) {
    failure.value = errorMessageFrom(cause) ?? 'Operation failed.'
  }
  finally {
    busy.value = false
  }
}

async function reload() {
  const owner = characterId.value
  const list = await listMemories({ characterId: owner })
  if (owner !== characterId.value)
    return
  documents.value = list
  if (!list.some(item => item.id === selectedId.value)) {
    selectedId.value = ''
    content.value = ''
  }
}

async function loadConfig() {
  const settings = await companion.refresh()
  binaryPath.value = settings.binaryPath
  memoryEnabled.value = settings.memoryEnabled
  await reload()
}

async function save() {
  await saveConfig({
    memoryEnabled: memoryEnabled.value,
    binaryPath: binaryPath.value.trim(),
  })
  await companion.refresh()
  await companion.syncMemoryProvider()
  feedback.value = text('saved')
}

async function select(id: string) {
  const owner = characterId.value
  const value = await readMemory({ characterId: owner, id })
  if (owner !== characterId.value)
    return
  selectedId.value = id
  content.value = value
}

async function saveDocument() {
  await writeMemory({ characterId: characterId.value, id: selectedId.value, content: content.value })
  await reload()
  feedback.value = text('saved')
}

async function removeDocument() {
  await removeMemory({ characterId: characterId.value, id: selectedId.value })
  await reload()
}

async function clear() {
  if (!confirmClear.value)
    return
  const owner = characterId.value
  const previousSession = sessions.index?.characters[owner]?.activeSessionId
  if (previousSession) {
    await speechOutput.requestStopSpeaking({ reason: 'manual-chat', sessionId: previousSession })
    for (const turn of chat.activeTurns.filter(turn => turn.sessionId === previousSession))
      await chat.cancelTurn(turn)
  }
  await clearMemories({ characterId: owner })
  // Old dialogue can repeat deleted facts and write them back into memory. Keep it archived, outside the new context.
  const sessionId = await sessions.createSession(owner, { setActive: characterId.value === owner })
  if (characterId.value === owner)
    await sessions.setActiveSession(sessionId)
  confirmClear.value = false
  results.value = ''
  await reload()
  feedback.value = text('cleared')
}

async function exportArchive() {
  const path = await exportMemories({ characterId: characterId.value })
  if (path)
    feedback.value = text('exported', { path })
}

async function search() {
  const result = await searchMemory({ characterId: characterId.value, query: query.value.trim() })
  results.value = result.context || text('no-results')
  sourceCount.value = result.sourceCount
}

watch(characterId, () => {
  selectedId.value = ''
  content.value = ''
  results.value = ''
  confirmClear.value = false
  void run(reload)
})
onMounted(() => run(loadConfig))
</script>

<template>
  <div :class="['flex flex-col gap-4', 'pb-12']">
    <p :class="['text-sm text-neutral-500 dark:text-neutral-400']">
      {{ text('privacy') }}
    </p>
    <SettingsCard>
      <h2 :class="['text-lg font-medium']">
        {{ text('keys') }}
      </h2>
      <p :class="['text-sm text-neutral-500 dark:text-neutral-400']">
        {{ text('provider-note') }}
      </p>
      <FieldInput v-model="binaryPath" :label="text('sag-path')" :disabled="busy" />
      <FieldCheckbox v-model="memoryEnabled" :label="text('memory-enabled')" :description="text('memory-description')" :disabled="busy" />
      <div :class="['flex flex-wrap gap-2']">
        <Button color="primary" variant="primary" :disabled="busy" @click="run(save)">
          {{ text('save') }}
        </Button>
        <Button :disabled="busy || !companion.config?.jevConfigured" @click="run(async () => { await testProvider({ provider: 'jev' }); feedback = text('connected') })">
          {{ text('test-jev') }}
        </Button>
      </div>
      <p v-if="companion.config?.sagVersion" :class="['text-sm']">
        {{ text('sag-version', { version: companion.config.sagVersion }) }}
      </p>
      <p v-if="companion.config?.sagError" role="alert" :class="['text-sm text-red-600 dark:text-red-400', 'break-words']">
        {{ companion.config.sagError }}
      </p>
    </SettingsCard>

    <p v-if="failure || companion.error" role="alert" :class="['text-sm text-red-600 dark:text-red-400', 'break-words']">
      {{ failure || companion.error }}
    </p>
    <p v-if="feedback" role="status" :class="['text-sm', 'break-words']">
      {{ feedback }}
    </p>

    <SettingsCard>
      <h2 :class="['text-lg font-medium']">
        {{ text('memory') }} · {{ cards.activeCard?.name }}
      </h2>
      <p :class="['text-xs text-neutral-500 dark:text-neutral-400', 'break-all']">
        {{ text('archive-path', { path: companion.config?.archivePath ?? '' }) }}
      </p>
      <div :class="['flex flex-wrap gap-2']">
        <Button :disabled="busy" @click="run(reload)">
          {{ text('reload') }}
        </Button>
        <Button :disabled="busy" @click="run(exportArchive)">
          {{ text('export') }}
        </Button>
      </div>
      <p v-if="!documents.length" :class="['text-sm text-neutral-500 dark:text-neutral-400']">
        {{ text('empty') }}
      </p>
      <div :class="['flex max-h-48 flex-col gap-1 overflow-y-auto']">
        <Button v-for="document in documents" :key="document.id" :disabled="busy" :aria-pressed="selectedId === document.id" @click="run(() => select(document.id))">
          {{ document.title }}
        </Button>
      </div>
      <template v-if="selectedId">
        <label for="companion-memory-content">{{ text('edit') }}</label>
        <Textarea id="companion-memory-content" v-model="content" :disabled="busy" :rows="12" />
        <div :class="['flex gap-2']">
          <Button :disabled="busy" @click="run(saveDocument)">
            {{ text('save-memory') }}
          </Button>
          <Button color="red" :disabled="busy" @click="run(removeDocument)">
            {{ text('delete-memory') }}
          </Button>
        </div>
      </template>
      <FieldInput v-model="query" :label="text('query')" :disabled="busy" />
      <Button :disabled="busy || !query.trim() || !companion.config?.jevConfigured" @click="run(search)">
        {{ text('search') }}
      </Button>
      <template v-if="results">
        <p :class="['text-sm']">
          {{ text('sources', { count: sourceCount }) }}
        </p>
        <pre :class="['max-h-72 overflow-y-auto whitespace-pre-wrap break-words', 'text-xs']">{{ results }}</pre>
      </template>
      <FieldCheckbox v-model="confirmClear" :label="text('confirm-clear')" :disabled="busy" />
      <Button color="red" :disabled="busy || !confirmClear" @click="run(clear)">
        {{ text('clear') }}
      </Button>
    </SettingsCard>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: tamagotchi.companion.title
  descriptionKey: tamagotchi.companion.description
  settingsEntry: true
  order: -10
  icon: i-solar:heart-bold-duotone
</route>
