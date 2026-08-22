/**
 * THE IN-FLIGHT COUNTER AT THE BACKGROUND-COMPOSE SEAM.
 *
 * Three schedulers compose on the ONE background `cc-nudge-*` substrate — the
 * fired-reminder dispatcher, the work-wakeup sweep and the terminal-build wake —
 * and all three key the warm child on `metering_context.project_id`. Same
 * substrate + same owner + same project id is the SAME pool key, so for one
 * project those three serialize on a single child. A wakeup firing while another
 * holds that child does not run: it queues, burns its whole turn budget waiting,
 * aborts (`cc-llm-call: aborted`), and the sweep then reports a MECHANISM FAILURE
 * to the owner. Attempts 1, 6 and 12 of exactly that reached his phone on
 * 2026-08-22, interleaved with the reminder body that was occupying the child.
 *
 * `isBackgroundComposeInFlight` is what lets a caller ask BEFORE composing. These
 * tests pin the three properties the gate depends on: it is true only WHILE a
 * compose is running, it is released on every exit path (including the abort),
 * and it is scoped per warm-pool key rather than global.
 */

import { describe, expect, test } from 'bun:test'

import type { AgentSpec } from '@neutronai/runtime/substrate.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import {
  buildSubstrateReminderLlm,
  isBackgroundComposeInFlight,
  resetBackgroundComposeStateForTests,
} from '../dispatcher.ts'

function spec(project_id?: string): AgentSpec {
  return {
    prompt: 'compose something',
    tools: [],
    model_preference: ['model-x'],
    max_tokens: 64,
    ...(project_id === undefined ? {} : { metering_context: { project_id } }),
  }
}

/**
 * A substrate whose stream is held open until the test releases it — the seam
 * needs a compose that is genuinely MID-FLIGHT to observe, and a resolved promise
 * would make every assertion below trivially true after the fact.
 */
function heldSubstrate(): {
  substrate: { start(spec: AgentSpec): SessionHandle }
  release(text: string): void
  fail(message: string): void
} {
  let release: (text: string) => void = () => {}
  let fail: (message: string) => void = () => {}
  const gate = new Promise<string>((resolve, reject) => {
    release = resolve
    fail = (m: string): void => reject(new Error(m))
  })
  const handle: SessionHandle = {
    events: {
      async *[Symbol.asyncIterator](): AsyncIterator<Event> {
        const text = await gate
        yield { kind: 'token', text }
        yield {
          kind: 'completion',
          usage: { input_tokens: 0, output_tokens: 0 },
          substrate_instance_id: 'cc-nudge-test',
        }
      },
    },
    respondToTool: async (): Promise<void> => {},
    cancel: async (): Promise<void> => {},
    tool_resolution: 'internal',
  }
  return { substrate: { start: (): SessionHandle => handle }, release, fail }
}

describe('isBackgroundComposeInFlight', () => {
  test('false before, TRUE while the compose runs, false after it resolves', async () => {
    resetBackgroundComposeStateForTests()
    const held = heldSubstrate()
    const llm = buildSubstrateReminderLlm(held.substrate, { timeout_ms: 10_000 })

    expect(isBackgroundComposeInFlight('proj-a')).toBe(false)
    const pending = llm.compose(spec('proj-a'))
    // The counter is incremented SYNCHRONOUSLY at the call, before the first
    // await — a gate that only became true one microtask later would let a tick
    // that fires in the same turn straight through.
    expect(isBackgroundComposeInFlight('proj-a')).toBe(true)

    held.release('done')
    await pending
    expect(isBackgroundComposeInFlight('proj-a')).toBe(false)
  })

  test('RELEASED ON THE FAILURE PATH TOO — a throw must not gate the caller off forever', async () => {
    resetBackgroundComposeStateForTests()
    const held = heldSubstrate()
    const llm = buildSubstrateReminderLlm(held.substrate, { timeout_ms: 10_000 })

    const pending = llm.compose(spec('proj-a'))
    expect(isBackgroundComposeInFlight('proj-a')).toBe(true)
    held.fail('substrate died')
    await expect(pending).rejects.toThrow()
    // A counter that leaked here would be an UNCONDITIONAL SILENCE of the wakeup
    // — precisely the shortcut this fix is not allowed to take.
    expect(isBackgroundComposeInFlight('proj-a')).toBe(false)
  })

  test('RELEASED ON THE ABORT PATH — the timeout is what produced `cc-llm-call: aborted`', async () => {
    resetBackgroundComposeStateForTests()
    const held = heldSubstrate()
    const llm = buildSubstrateReminderLlm(held.substrate, { timeout_ms: 5 })

    const pending = llm.compose(spec('proj-a'))
    expect(isBackgroundComposeInFlight('proj-a')).toBe(true)
    await expect(pending).rejects.toThrow(/abort/i)
    expect(isBackgroundComposeInFlight('proj-a')).toBe(false)
  })

  test('SCOPED PER WARM-POOL KEY — a busy project does not gate a different one', async () => {
    resetBackgroundComposeStateForTests()
    const held = heldSubstrate()
    const llm = buildSubstrateReminderLlm(held.substrate, { timeout_ms: 10_000 })

    const pending = llm.compose(spec('proj-a'))
    expect(isBackgroundComposeInFlight('proj-a')).toBe(true)
    // Different project id ⇒ different pool key ⇒ a different warm child, which
    // nothing is holding. Gating it would silence a project that is idle.
    expect(isBackgroundComposeInFlight('proj-b')).toBe(false)

    held.release('done')
    await pending
  })

  test('a spec with no metering context lands on the `default` scope, matching the pool fallback', async () => {
    resetBackgroundComposeStateForTests()
    const held = heldSubstrate()
    const llm = buildSubstrateReminderLlm(held.substrate, { timeout_ms: 10_000 })

    const pending = llm.compose(spec())
    expect(isBackgroundComposeInFlight('default')).toBe(true)
    expect(isBackgroundComposeInFlight('proj-a')).toBe(false)

    held.release('done')
    await pending
  })

  test('CONCURRENT composes on one scope release only when the LAST finishes', async () => {
    resetBackgroundComposeStateForTests()
    const first = heldSubstrate()
    const second = heldSubstrate()
    const llmA = buildSubstrateReminderLlm(first.substrate, { timeout_ms: 10_000 })
    const llmB = buildSubstrateReminderLlm(second.substrate, { timeout_ms: 10_000 })

    const a = llmA.compose(spec('proj-a'))
    const b = llmB.compose(spec('proj-a'))
    expect(isBackgroundComposeInFlight('proj-a')).toBe(true)

    first.release('one')
    await a
    // A boolean flag rather than a COUNT would report the scope free here, while
    // the second compose still holds the child.
    expect(isBackgroundComposeInFlight('proj-a')).toBe(true)

    second.release('two')
    await b
    expect(isBackgroundComposeInFlight('proj-a')).toBe(false)
  })
})
