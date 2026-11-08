import { generateText } from '@xsai/generate-text'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getGenerationProvider } from '../../../types'
import { providerMinimax, providerMinimaxGlobal } from './index'

afterEach(() => vi.unstubAllGlobals())

describe('minimax reasoning request policy', () => {
  it.each([providerMinimax, providerMinimaxGlobal])('sends supported low effort for Flash when Thinking is off ($id)', async (definition) => {
    let body: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ id: 'reply', object: 'chat.completion', created: 0, model: 'MiniMax-M3.1-Flash', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hello' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    }))
    const provider = getGenerationProvider(await definition.createProvider({ apiKey: 'test-key' }))!
    const request = provider.generation('MiniMax-M3.1-Flash', { reasoning: 'disabled' })
    if (request.protocol !== 'chat-completions')
      throw new Error('Expected Chat Completions')
    await generateText({ ...request.config, messages: [{ role: 'user', content: 'Hello' }] })
    expect(body?.reasoning_effort).toBe('low')
    expect(body).not.toHaveProperty('thinking')
  })

  it('preserves explicit deep thinking and the provider default when no choice is supplied', async () => {
    const provider = getGenerationProvider(await providerMinimax.createProvider({ apiKey: 'test-key' }))!
    expect(provider.generation('MiniMax-M3.1-Flash', { reasoning: 'enabled' }).config).toHaveProperty('reasoningEffort', 'max')
    expect(provider.generation('MiniMax-M3.1-Flash').config).not.toHaveProperty('reasoningEffort')
  })

  it('uses disabled thinking only for the model that supports it', async () => {
    const provider = getGenerationProvider(await providerMinimax.createProvider({ apiKey: 'test-key' }))!
    expect(provider.generation('MiniMax-M3', { reasoning: 'disabled' }).config).toHaveProperty('thinking.type', 'disabled')
    expect(provider.generation('MiniMax-M3', { reasoning: 'enabled' }).config).toHaveProperty('thinking.type', 'adaptive')
    expect(provider.generation('MiniMax-M2.7', { reasoning: 'disabled' }).config).not.toHaveProperty('thinking')
    expect(provider.generation('MiniMax-M2.7', { reasoning: 'disabled' }).config).not.toHaveProperty('reasoningEffort')
  })
})
