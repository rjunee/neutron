/**
 * X2 test fixture — a Core whose handler ECHOES the per-call ToolCallContext.
 *
 * Proves the install composer's `wrapHandler` actually THREADS the registry's
 * per-call context into the Core handler's second argument (X2, the X6
 * enabler). The handler forwards `ctx` into `deps.backend.capture(ctx)`; the
 * test wires a backend that records it and asserts every field arrives.
 * Exercised by `gateway/__tests__/cores-under-implementation-hardfail.test.ts`.
 */

import { defineCore, type ToolCallContext } from '@neutronai/cores-sdk'

interface CtxEchoBackend {
  capture: (ctx: ToolCallContext) => void
}

export const core = defineCore({
  slug: 'ctxecho_core',
  backendKey: 'backend',
  toolNames: ['ctx_echo'],
  buildTools: (deps: { backend: CtxEchoBackend }) => ({
    ctx_echo: async (_args: unknown, ctx: ToolCallContext): Promise<{ ok: true }> => {
      deps.backend.capture(ctx)
      return { ok: true }
    },
  }),
})
