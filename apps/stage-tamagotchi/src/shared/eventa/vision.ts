import { defineInvokeEventa } from '@moeru/eventa'

/** Opens the single observation window. Restore requests run once per desktop main process. */
export const electronOpenVisionWindow = defineInvokeEventa<void, { restore?: boolean }>('eventa:invoke:electron:vision:open')
