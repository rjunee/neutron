/**
 * K11a6-completion survivor — the LIVE onboarding LLM envelope's
 * never-ask-timezone rule, ported VERBATIM from the engine-free describe of
 * the dying `timezone-autoskip.test.ts` (which otherwise pins the deleted
 * `engine.start` browser-`?tz=` capture and co-deletes with K11b1).
 *
 * `skills/_envelope.md` is retained-LIVE: it is loaded by the prod composer
 * surfaces (`gateway/http/app-ws-surface.ts`, `landing/chat-react/
 * controller.ts`) and `known_timezone` is surfaced by the retained
 * `phase-spec-resolver.ts`. This was the SOLE test asserting the rule —
 * the K8 coverage-loss rule requires the port before the drive suite dies.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('live envelope — never ask for the timezone', () => {
  test('the LLM envelope carries the never-ask-timezone rule', () => {
    const envelope = readFileSync(
      join(import.meta.dir, '..', 'skills', '_envelope.md'),
      'utf8',
    )
    expect(envelope).toContain('NEVER ask the user for their timezone')
    expect(envelope).toContain('known_timezone')
  })
})
