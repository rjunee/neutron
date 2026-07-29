/**
 * Path 1 onboarding option buttons (2026-06-30) — unit coverage for the
 * structured-choice `[[OPTIONS]]` detection in `build-live-agent-turn.ts`.
 *
 * Two layers:
 *   1. `extractAgentOptions` pure-function parsing (block strip + sanitisation).
 *   2. The live turn emits the parsed options on an ONBOARDING turn (and NOT on
 *      a steady-state turn), persisting them on the durable reply row.
 *
 * Stubbed substrate (no real `claude` spawn); REAL ButtonStore over an on-disk
 * migrated project.db so the persistence assertion runs the gateway's own SQL.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import { VALUE_BYTE_CAP } from '@neutronai/channels/button-primitive.ts'
import type { ChatOutbound } from '@neutronai/landing/server.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import {
  buildLiveAgentTurn,
  extractAgentOptions,
  type LiveAgentOnboardingSeam,
} from '../build-live-agent-turn.ts'
import type { LiveAgentTurnRequest } from '../../http/chat-bridge.ts'

let tmp: string
let db: ProjectDb
let store: ButtonStore
let now = 1_000_000

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-lat-opt-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  now = 1_000_000
  store = new ButtonStore({ db, now: () => now })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeStubSubstrate(reply: string, specs: AgentSpec[]): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      specs.push(spec)
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield { kind: 'token', text: reply }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'stub',
        }
      })()
      return {
        events,
        async respondToTool(): Promise<void> {
          throw new Error('not used')
        },
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

function makeOnboardingSeam(active: boolean): LiveAgentOnboardingSeam {
  return {
    isActive: async (): Promise<boolean> => active,
    systemPreamble: (): string => '<onboarding>preamble</onboarding>',
    uploadAffordance: (): { source: 'chatgpt' | 'claude' } | null => null,
    onTurnComplete: (): void => {},
  }
}

function makeRunner(reply: string, opts: { onboarding?: boolean }) {
  const specs: AgentSpec[] = []
  const runner = buildLiveAgentTurn({
    substrate: makeStubSubstrate(reply, specs),
    personaLoader: { load: async (): Promise<string> => '' },
    buttonStore: store,
    ...(opts.onboarding !== undefined
      ? { onboarding: makeOnboardingSeam(opts.onboarding) }
      : {}),
    project_slug: 'alice',
    owner_home: tmp,
    model: 'test-model',
    now: () => now,
  })
  return runner
}

function makeTurn(sent: ChatOutbound[]): LiveAgentTurnRequest {
  return {
    project_slug: 'alice',
    user_id: 'u-1',
    topic_id: 'app:u-1',
    user_text: 'who should you be?',
    send: (e) => sent.push(e),
    observed_at: now,
  }
}

describe('extractAgentOptions — parsing', () => {
  test('strips the block and returns sanitized options', () => {
    const text =
      'Whose voice should I take on?\n\n[[OPTIONS]]\n- Marcus Aurelius\n- Hermione Granger\n- Something else\n[[/OPTIONS]]'
    const { body, options } = extractAgentOptions(text)
    expect(body).toBe('Whose voice should I take on?')
    expect(options.map((o) => o.body)).toEqual([
      'Marcus Aurelius',
      'Hermione Granger',
      'Something else',
    ])
    // value == the line text (so a tap feeds the agent the choice verbatim).
    expect(options.map((o) => o.value)).toEqual([
      'Marcus Aurelius',
      'Hermione Granger',
      'Something else',
    ])
    // distinct non-empty labels.
    expect(new Set(options.map((o) => o.label)).size).toBe(3)
  })

  test('no block → body unchanged, no options', () => {
    const { body, options } = extractAgentOptions('Just a plain question?')
    expect(body).toBe('Just a plain question?')
    expect(options).toHaveLength(0)
  })

  test('block-only message (no prose) degrades to plain text, no options', () => {
    const text = '[[OPTIONS]]\n- A\n- B\n[[/OPTIONS]]'
    const { body, options } = extractAgentOptions(text)
    expect(options).toHaveLength(0)
    expect(body).toContain('[[OPTIONS]]') // returned as-is (no valid button prompt)
  })

  test('dedupes options and drops blanks; caps the value at the wire budget', () => {
    const longLine = 'X'.repeat(80)
    const text = `Pick:\n[[OPTIONS]]\n- Sage\n- Sage\n-   \n- ${longLine}\n[[/OPTIONS]]`
    const { options } = extractAgentOptions(text)
    // "Sage" once (dedupe), blank dropped, long line kept.
    expect(options.map((o) => o.value)).toContain('Sage')
    expect(options.filter((o) => o.value === 'Sage')).toHaveLength(1)
    for (const o of options) {
      expect(Buffer.byteLength(o.value, 'utf8')).toBeLessThanOrEqual(VALUE_BYTE_CAP)
    }
  })
})

describe('build-live-agent-turn — onboarding option emission', () => {
  const choiceReply =
    'Whose voice should I take on?\n\n[[OPTIONS]]\n- Marcus Aurelius\n- Hermione Granger\n[[/OPTIONS]]'

  test('ONBOARDING turn emits the parsed options on the envelope + persisted row', async () => {
    const sent: ChatOutbound[] = []
    const run = makeRunner(choiceReply, { onboarding: true })
    const result = await run(makeTurn(sent))
    expect(result.outcome).toBe('replied')

    const reply = sent.find((e) => e.type === 'agent_message') as {
      body: string
      options?: ReadonlyArray<{ body: string; value: string }>
      allow_freeform?: boolean
    }
    expect(reply.body).toBe('Whose voice should I take on?')
    expect(reply.allow_freeform).toBe(true)
    expect(reply.options?.map((o) => o.value)).toEqual(['Marcus Aurelius', 'Hermione Granger'])

    // Persisted button_prompts row carries the options + stripped body too
    // (history hydration reads options_json off this row).
    const persisted = db
      .raw()
      .query<{ body: string; options_json: string }, [string]>(
        `SELECT body, options_json FROM button_prompts WHERE prompt_id = ?`,
      )
      .get(result.reply_prompt_id!)
    expect(persisted).not.toBeNull()
    expect(persisted!.body).toBe('Whose voice should I take on?')
    const persistedOptions = JSON.parse(persisted!.options_json) as Array<{ value: string }>
    expect(persistedOptions.map((o) => o.value)).toEqual(['Marcus Aurelius', 'Hermione Granger'])
  })

  test('STEADY-STATE turn never sprouts buttons from the sentinel', async () => {
    const sent: ChatOutbound[] = []
    const run = makeRunner(choiceReply, { onboarding: false })
    const result = await run(makeTurn(sent))
    expect(result.outcome).toBe('replied')
    const reply = sent.find((e) => e.type === 'agent_message') as {
      body: string
      options?: ReadonlyArray<unknown>
    }
    // No onboarding → the raw text (block included) is the body, no options.
    expect(reply.options ?? []).toHaveLength(0)
    expect(reply.body).toContain('[[OPTIONS]]')
  })
})
