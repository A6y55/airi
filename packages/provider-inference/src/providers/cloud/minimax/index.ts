import type { ChatRequestOptions } from '../../../types'

import { createMinimax, createMinimaxCn } from '@xsai-ext/providers/create'
import { z } from 'zod'

import { ProviderValidationCheck } from '../../../types'
import { createOpenAICompatibleValidators } from '../../../validators'
import { defineProvider } from '../../registry'

const minimaxCnConfigSchema = z.object({
  apiKey: z
    .string('API Key'),
  baseUrl: z
    .string('Base URL')
    .optional()
    .default('https://api.minimaxi.com/v1/'),
})

type MinimaxCnConfig = z.input<typeof minimaxCnConfigSchema>

const minimaxGlobalConfigSchema = z.object({
  apiKey: z
    .string('API Key'),
  baseUrl: z
    .string('Base URL')
    .optional()
    .default('https://api.minimax.io/v1/'),
})

type MinimaxGlobalConfig = z.input<typeof minimaxGlobalConfigSchema>

/** M3.1 Flash requires thinking. The low-latency choice uses its supported low effort instead of the rejected disabled mode. */
function withMinimaxReasoning(provider: ReturnType<typeof createMinimax>) {
  return {
    ...provider,
    chat(model: string, options?: ChatRequestOptions) {
      const request = provider.chat(model)
      if (!options?.reasoning)
        return request
      if (model === 'MiniMax-M3.1-Flash')
        return { ...request, reasoningEffort: options.reasoning === 'enabled' ? 'max' : 'low' }
      if (model === 'MiniMax-M3')
        return { ...request, thinking: { type: options.reasoning === 'enabled' ? 'adaptive' : 'disabled' } }
      return request
    },
  }
}

export const providerMinimax = defineProvider<MinimaxCnConfig, 'minimax'>({
  id: 'minimax',
  name: 'MiniMax',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.minimax.title'),
  description: 'minimaxi.com',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.minimax.description'),
  tasks: ['chat'],
  capabilities: { chat: { reasoning: { modes: ['enabled', 'disabled'] } } },
  icon: 'i-lobe-icons:minimax',
  iconColor: 'i-lobe-icons:minimax-color',

  createProviderConfig: ({ t }) => minimaxCnConfigSchema.extend({
    apiKey: minimaxCnConfigSchema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.placeholder'),
      type: 'password',
    }),
    baseUrl: minimaxCnConfigSchema.shape.baseUrl.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.placeholder'),
    }),
  }),
  createProvider(config) {
    return withMinimaxReasoning(createMinimaxCn(config.apiKey, config.baseUrl))
  },

  validationRequiredWhen(config) {
    return !!config.apiKey?.trim()
  },
  validators: {
    ...createOpenAICompatibleValidators({
      checks: [ProviderValidationCheck.Connectivity, ProviderValidationCheck.ModelList, ProviderValidationCheck.ChatCompletions],
    }),
  },
})

export const providerMinimaxGlobal = defineProvider<MinimaxGlobalConfig, 'minimax-global'>({
  id: 'minimax-global',
  name: 'MiniMax Global',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.minimax-global.title'),
  description: 'minimax.io',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.minimax-global.description'),
  tasks: ['chat'],
  capabilities: { chat: { reasoning: { modes: ['enabled', 'disabled'] } } },
  icon: 'i-lobe-icons:minimax',
  iconColor: 'i-lobe-icons:minimax-color',

  createProviderConfig: ({ t }) => minimaxGlobalConfigSchema.extend({
    apiKey: minimaxGlobalConfigSchema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.placeholder'),
      type: 'password',
    }),
    baseUrl: minimaxGlobalConfigSchema.shape.baseUrl.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.placeholder'),
    }),
  }),
  createProvider(config) {
    return withMinimaxReasoning(createMinimax(config.apiKey, config.baseUrl))
  },

  validationRequiredWhen(config) {
    return !!config.apiKey?.trim()
  },
  validators: {
    ...createOpenAICompatibleValidators({
      checks: [ProviderValidationCheck.Connectivity, ProviderValidationCheck.ModelList, ProviderValidationCheck.ChatCompletions],
    }),
  },
})
