import type { MinimaxSpeechEvent, MinimaxSpeechOptions } from '@proj-airi/provider-inference/minimax-speech'

import { defineEventa, defineInvokeEventa } from '@moeru/eventa'

/** Session IDs are scoped to the originating WebContents. Speech IPC never accepts credentials or endpoint overrides. */
export const minimaxSpeechStart = defineInvokeEventa<void, MinimaxSpeechOptions & { id: string }>('eventa:invoke:minimax-speech:start')
export const minimaxSpeechAppend = defineInvokeEventa<void, { id: string, text: string }>('eventa:invoke:minimax-speech:append')
export const minimaxSpeechFinish = defineInvokeEventa<void, { id: string }>('eventa:invoke:minimax-speech:finish')
export const minimaxSpeechCancel = defineInvokeEventa<void, { id: string }>('eventa:invoke:minimax-speech:cancel')
export const minimaxSpeechEvent = defineEventa<{ id: string, event: MinimaxSpeechEvent }>('eventa:minimax-speech:event')
