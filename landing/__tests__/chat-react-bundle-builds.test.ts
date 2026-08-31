/**
 * The web chat bundle must BUILD, and when it doesn't, the failure must say why.
 *
 * `GET /chat-react.js` answers 404 when `Bun.build` fails (`landing/server.ts`
 * `resolveChatReactJs` returns null), and the bundler's diagnostics go to the
 * system-event journal — which no CI log shows. So the existing serving test can
 * only ever report `Expected: 200 / Received: 404`: the owner's chat client is
 * completely broken and the only evidence is a status code.
 *
 * This test runs the same build directly and PRINTS the bundler's logs, so a
 * resolution error, a browser-incompatible import, or a syntax error in anything
 * reachable from `chat-react/main.tsx` names itself.
 */

import { describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHAT_REACT_BUNDLE_BUILD_OPTIONS } from '../server.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(dirname(HERE), 'chat-react', 'main.tsx')

describe('the web chat bundle', () => {
  test('builds from chat-react/main.tsx for the browser', async () => {
    const result = await Bun.build({
      entrypoints: [ENTRY],
      ...CHAT_REACT_BUNDLE_BUILD_OPTIONS,
    })
    if (!result.success) {
      // Not decoration: this is the whole reason the test exists.
      for (const log of result.logs) console.error('[chat-react bundle]', String(log))
    }
    expect(result.success).toBe(true)
    expect(result.outputs.length).toBeGreaterThan(0)
  }, 120_000)
})
