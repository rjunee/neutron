/**
 * Item 5 (ISSUES #208) — unit tests for the production opening-message
 * composer (`build-project-opening-message.ts`).
 *
 * The composer is the LLM half of the free-form opening: plain-text
 * output (no JSON envelope), materialized docs as the primary prompt
 * source, deterministic-prose fallback on ANY failure. The client is
 * stubbed (the real one is the CC-substrate-backed shim from
 * `buildGatewayAnthropicMessagesClient` — no direct api.anthropic.com).
 */

import { describe, expect, test } from 'bun:test'
import {
  buildProjectOpeningMessageComposer,
  buildOpeningUserContent,
  extractOpeningBody,
  PROJECT_OPENING_COMPOSER_TIMEOUT_MS_DEFAULT,
  OPENING_PROMPT_DOC_MAX_CHARS,
} from '../build-project-opening-message.ts'
import { OPENING_MESSAGE_MAX_CHARS, type ComposeProjectOpeningInput } from '../build-onboarding-handoff.ts'
import type { AnthropicMessagesClient } from '@neutronai/onboarding/interview/anthropic-client.ts'
import { BEST_MODEL } from '@neutronai/runtime/models.ts'

function makeInput(overrides: Partial<ComposeProjectOpeningInput> = {}): ComposeProjectOpeningInput {
  return {
    name: 'Acme',
    imported_project: {
      name: 'Acme',
      rationale: 'Convertible note + operating agreement work.',
      suggested_topics: ['acme-convertible-note'],
    },
    import_result: null,
    project_docs: {
      readme: '# Acme\n\nDTC skincare venture; launch is two weeks out.',
      transcript_summary: 'Key decision: the note converts at a $8M cap.',
      status_md: null,
    },
    project_slug: 'sam',
    user_id: 'u-1',
    ...overrides,
  }
}

function stubClient(
  respond: (input: {
    model: string
    system?: string
    messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>
    max_tokens: number
    signal?: AbortSignal
  }) => Promise<string>,
): AnthropicMessagesClient {
  return {
    messages: {
      create: async (input) => ({ content: [{ text: await respond(input) }] }),
    },
  }
}

describe('buildProjectOpeningMessageComposer', () => {
  test('happy path: plain-text LLM body returned verbatim; prompt carries the docs + name on BEST_MODEL', async () => {
    let seenModel = ''
    let seenSystem = ''
    let seenUser = ''
    const client = stubClient(async (input) => {
      seenModel = input.model
      seenSystem = input.system ?? ''
      seenUser = input.messages[0]!.content
      return 'Acme is your skincare venture - launch is two weeks out.\n\nWant me to chase the note?'
    })
    const compose = buildProjectOpeningMessageComposer({ anthropicClient: client })
    const out = await compose(makeInput())
    expect(out.body).toBe(
      'Acme is your skincare venture - launch is two weeks out.\n\nWant me to chase the note?',
    )
    expect(seenModel).toBe(BEST_MODEL)
    // System prompt encodes the Item 5 shape rules.
    expect(seenSystem).toContain('Exactly ONE next move')
    expect(seenSystem).toContain('Never use em dashes')
    expect(seenSystem).toContain('NEVER lead with mention counts')
    // User payload carries the materialized docs as the primary source.
    expect(seenUser).toContain('<project-readme>')
    expect(seenUser).toContain('DTC skincare venture')
    expect(seenUser).toContain('<transcript-summary>')
    expect(seenUser).toContain('$8M cap')
    expect(seenUser).toContain('Project name: Acme')
  })

  test('client throw → deterministic fallback prose (never empty)', async () => {
    const client: AnthropicMessagesClient = {
      messages: {
        create: async () => {
          throw new Error('substrate down')
        },
      },
    }
    const compose = buildProjectOpeningMessageComposer({ anthropicClient: client })
    const out = await compose(makeInput())
    expect(out.body.length).toBeGreaterThan(0)
    // Deterministic path lifts the README first paragraph.
    expect(out.body).toContain('DTC skincare venture')
  })

  test('timeout aborts the call and falls back deterministically', async () => {
    const client: AnthropicMessagesClient = {
      messages: {
        create: (input) =>
          new Promise((_, reject) => {
            input.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      },
    }
    const compose = buildProjectOpeningMessageComposer({
      anthropicClient: client,
      timeout_ms: 20,
    })
    const out = await compose(makeInput())
    expect(out.body).toContain('DTC skincare venture')
  })

  test('empty LLM body → deterministic fallback', async () => {
    const client = stubClient(async () => '   ')
    const compose = buildProjectOpeningMessageComposer({ anthropicClient: client })
    const out = await compose(makeInput())
    expect(out.body).toContain('DTC skincare venture')
  })

  test('runaway LLM body (> 4× cap) → deterministic fallback', async () => {
    const client = stubClient(async () => 'X'.repeat(OPENING_MESSAGE_MAX_CHARS * 4 + 1))
    const compose = buildProjectOpeningMessageComposer({ anthropicClient: client })
    const out = await compose(makeInput())
    expect(out.body).toContain('DTC skincare venture')
  })

  test('default timeout is 8s (above the old 6s seed composer — doc-context prompt)', () => {
    expect(PROJECT_OPENING_COMPOSER_TIMEOUT_MS_DEFAULT).toBe(8_000)
  })
})

describe('buildOpeningUserContent', () => {
  test('no docs + no import row → explicit NONE block instructing the honest ask', () => {
    const content = buildOpeningUserContent(
      makeInput({
        imported_project: null,
        project_docs: { readme: null, transcript_summary: null, status_md: null },
      }),
    )
    expect(content).toContain('Import history: NONE.')
    expect(content).toContain('ask what it is and what they want you to track')
    expect(content).not.toContain('<project-readme>')
  })

  test('import row only (docs missing — materialization raced/failed) → rationale + topics block', () => {
    const content = buildOpeningUserContent(
      makeInput({ project_docs: { readme: null, transcript_summary: null, status_md: null } }),
    )
    expect(content).toContain('Import synthesis rationale: Convertible note')
    expect(content).toContain('- acme-convertible-note')
    expect(content).not.toContain('<project-readme>')
  })

  test('doc content is capped and control chars are stripped; name newlines collapse', () => {
    const content = buildOpeningUserContent(
      makeInput({
        name: 'Sneaky\nProject',
        project_docs: {
          readme: `badchar\n\n\n\n\n${'R'.repeat(OPENING_PROMPT_DOC_MAX_CHARS + 500)}`,
          transcript_summary: null,
          status_md: null,
        },
      }),
    )
    expect(content).toContain('Project name: Sneaky Project')
    expect(content).not.toContain('')
    expect(content).not.toContain('\n\n\n')
  })

  test('cross-import facts surface when import_result is present', () => {
    const content = buildOpeningUserContent(
      makeInput({
        import_result: {
          entities: [],
          topics: [],
          proposed_projects: [],
          proposed_tasks: [],
          proposed_reminders: [],
          voice_signals: {} as never,
          facts: { key_people: ['Casey'], companies: ['Acme'] },
        } as never,
      }),
    )
    expect(content).toContain('Key people across imports: Casey')
    expect(content).toContain('Companies across imports: Acme')
  })
})

describe('extractOpeningBody', () => {
  test('plain text passes through trimmed', () => {
    expect(extractOpeningBody('  Hello.\n\nNext?  ')).toBe('Hello.\n\nNext?')
  })

  test('strips a stray code fence', () => {
    expect(extractOpeningBody('```\nFenced body.\n\nNext?\n```')).toBe('Fenced body.\n\nNext?')
  })

  test('rejects empty and oversize bodies', () => {
    expect(extractOpeningBody('')).toBeNull()
    expect(extractOpeningBody('```\n```')).toBeNull()
    expect(extractOpeningBody('Y'.repeat(OPENING_MESSAGE_MAX_CHARS * 4 + 1))).toBeNull()
  })
})
