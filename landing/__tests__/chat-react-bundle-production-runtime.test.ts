/**
 * The web chat bundle must ship React's PRODUCTION JSX runtime.
 *
 * `resolveChatReactJs` (landing/server.ts) builds the SPA with `Bun.build`.
 * Without `define: { 'process.env.NODE_ENV': '"production"' }`, React core
 * resolves to its production build but the JSX transform does not: Bun emits
 * the DEVELOPMENT runtime, every element is created by `jsxDEV`, and each one
 * records an owner stack via `console.createTask` — measured at ~60% of a
 * project-switch profile (1.4 s self time in `Run console task`) and ~240 KB
 * of extra bundle.
 *
 * This test builds the SAME entrypoint with the SAME exported options the
 * server uses — imported, not copied, so someone editing the server config
 * cannot silently diverge from what is asserted here — and asserts on the
 * BUILT BUNDLE TEXT.
 */

import { describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHAT_REACT_BUNDLE_BUILD_OPTIONS } from '../server.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(dirname(HERE), 'chat-react', 'main.tsx')

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('the web chat bundle', () => {
  test('ships the production JSX runtime, not jsxDEV owner-stack tracking', async () => {
    const result = await Bun.build({
      entrypoints: [ENTRY],
      ...CHAT_REACT_BUNDLE_BUILD_OPTIONS,
    })
    if (!result.success) {
      for (const log of result.logs) console.error('[chat-react prod bundle]', String(log))
    }
    expect(result.success).toBe(true)
    const out = result.outputs[0]
    if (out === undefined) throw new Error('bundle build produced no outputs')
    const js = await out.text()

    // POSITIVE CONTROL first: `car-conv` is a className the real app bundle
    // always carries (ChatApp.tsx conversation surface). An empty or
    // wrong-entry build must fail HERE, not pass the zero-occurrence rules
    // below vacuously.
    expect(js).toContain('car-conv')

    console.error(
      `[chat-react prod bundle] bytes=${js.length}`
        + ` jsxDEV=${count(js, 'jsxDEV')}`
        + ` createTask=${count(js, 'console.createTask')}`
        + ` OwnerStack=${count(js, 'OwnerStack')}`,
    )

    // Dev-runtime artifacts. jsxDEV is <= 3, not === 0: an unreachable shim
    // keeps 3 references even in the production build (854 in the dev build).
    expect(count(js, 'console.createTask')).toBe(0)
    expect(count(js, 'OwnerStack')).toBe(0)
    expect(count(js, 'jsxDEV')).toBeLessThanOrEqual(3)
  }, 120_000)
})
