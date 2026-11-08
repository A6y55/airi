import type { TranscriptionProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import { number, object, optional, safeParse, string } from 'valibot'
import { z } from 'zod'

import { defineProvider } from '../../registry'

const defaultBaseUrl = 'https://api.minimax.cn/v1/'
const defaultModel = 'asr-1.0'

const configSchema = z.object({
  apiKey: z.string().trim().min(1, 'API key is required.'),
  baseUrl: z.string().trim().url().default(defaultBaseUrl),
  model: z.string().default(defaultModel),
})

type MinimaxTranscriptionConfig = z.input<typeof configSchema>

const responseSchema = object({
  text: string(),
  duration: optional(number()),
  trace_id: optional(string()),
})

/** Adapts the SDK multipart upload to MiniMax ASR. The caller owns cancellation and the audio file. */
function createTranscriptionProvider(config: MinimaxTranscriptionConfig): TranscriptionProviderWithExtraOptions<string, Record<string, unknown>> {
  const baseURL = `${(config.baseUrl ?? defaultBaseUrl).trim().replace(/\/+$/, '')}/`
  const apiKey = config.apiKey.trim()

  return {
    transcription: (model, options) => ({
      baseURL,
      apiKey,
      model: model || config.model || defaultModel,
      language: typeof options?.language === 'string' ? options.language : undefined,
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        init?.signal?.throwIfAborted()
        if (!(init?.body instanceof FormData))
          throw new Error('MiniMax ASR requires an audio file upload.')

        const file = init.body.get('file')
        if (!(file instanceof Blob))
          throw new Error('MiniMax ASR requires an audio file upload.')

        const body = new FormData()
        body.set('file', file, file instanceof File ? file.name : 'recording.wav')
        body.set('model', String(init.body.get('model') || defaultModel))
        // Hearing filters verbose segments by avg_logprob, which MiniMax does not provide.
        // JSON preserves the transcript and lets Hearing report that confidence filtering is unavailable.
        body.set('response_format', 'json')
        body.set('stream', 'false')

        const headers = new Headers(init.headers)
        headers.delete('Content-Type')
        headers.set('Authorization', `Bearer ${apiKey}`)
        const language = init.body.get('language')
        if (typeof language === 'string' && language.trim())
          headers.set('language', language.trim())

        // MiniMax uses speech_to_text, not the SDK's audio/transcriptions endpoint.
        const response = await fetch(new URL('speech_to_text', baseURL), {
          method: 'POST',
          headers,
          body,
          signal: init.signal,
        })
        // The SDK preserves the HTTP status and the API error body in APICallError.
        if (!response.ok)
          return response

        const result = safeParse(responseSchema, await response.json())
        if (!result.success)
          throw new Error('MiniMax ASR returned an invalid response: expected a text field.')

        return Response.json(result.output)
      },
    }),
  }
}

export const providerMinimaxAudioTranscription = defineProvider<MinimaxTranscriptionConfig, 'minimax-audio-transcription'>({
  id: 'minimax-audio-transcription',
  name: 'MiniMax',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.minimax.title'),
  description: 'api.minimax.cn',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.minimax.description'),
  tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt'],
  icon: 'i-lobe-icons:minimax',
  iconColor: 'i-lobe-icons:minimax-color',
  capabilities: {
    transcription: { protocol: 'http', generateOutput: true, streamOutput: false, streamInput: false },
  },
  createProviderConfig: ({ t }) => configSchema.extend({
    apiKey: configSchema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.placeholder'),
      type: 'password',
    }),
    baseUrl: configSchema.shape.baseUrl.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.placeholder'),
    }),
  }),
  createProvider: createTranscriptionProvider,
  validationRequiredWhen: config => Boolean(config.apiKey?.trim()),
  validators: {
    validateConfig: [
      ({ t }) => ({
        id: 'minimax-audio-transcription:check-config',
        name: t('settings.pages.providers.catalog.edit.validators.openai-compatible.check-config.title'),
        validator: async (config) => {
          const result = configSchema.safeParse(config)
          const errors = result.success ? [] : result.error.issues.map(issue => ({ error: new Error(issue.message) }))
          return {
            errors,
            reason: errors.map(item => item.error.message).join(', '),
            reasonKey: '',
            valid: result.success,
          }
        },
      }),
    ],
  },
  extraMethods: {
    listModels: async () => [
      { id: defaultModel, name: 'MiniMax ASR 1.0', provider: 'minimax-audio-transcription', description: 'api.minimax.cn', contextLength: 0, deprecated: false },
    ],
  },
})
