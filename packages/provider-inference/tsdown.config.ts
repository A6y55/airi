import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/index.ts', './src/providers/local/sherpaw-transcription/models.ts', './src/providers/cloud/minimax-speech/stream.ts'],
  sourcemap: true,
  unused: true,
})
