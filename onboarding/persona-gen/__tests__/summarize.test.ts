/**
 * v0.1.80 (2026-05-22) — persona summarizer tests.
 *
 * Spec: docs/plans/2026-05-22-phase-prompt-ux-bundle.md (Fix 3).
 */

import { describe, expect, test } from 'bun:test'
import {
  buildPersonaSummarizer,
  buildSystemPrompt,
  buildUserPrompt,
  extractTopPriorities,
  parseSummaryEnvelope,
  staticPersonaSummary,
  type AnthropicMessageResponse,
  type AnthropicMessagesClient,
  type PersonaSummarizerInput,
} from '../summarize.ts'

const HAPPY_LLM_OUTPUT = JSON.stringify({
  summary:
    "Here's how I'll work with you, Sam: I'll think like a strategic-creative collaborator who balances analysis with imagination. I'll prioritize revenue and creative work over operations, and check in with you on anything involving money over $100 or external commitments. Sound right, or want to tweak something?",
})

const SAMPLE_PRIORITY_MD = `# priority-map.md

## Programs (ordered by importance)

1. Revenue / customer growth (Topline, Acme, Northwind) — P0/P1
2. Creative work (CC, Helperbot, Book) — P2
3. Health optimization (Biohacking) — P2/P3
4. Operations (Email, Calendar, Vault) — P3
`

const SAMPLE_SOUL_MD = `# SOUL.md\n\nVoice: grounded, direct.\n`
const SAMPLE_USER_MD = `# USER.md\n\nSam, LA, two kids.\n`

const HAPPY_INPUT: PersonaSummarizerInput = {
  user_first_name: 'Sam',
  agent_personality: 'a strategic-creative collaborator',
  soul_md: SAMPLE_SOUL_MD,
  user_md: SAMPLE_USER_MD,
  priority_map_md: SAMPLE_PRIORITY_MD,
}

function stubClient(text: string): AnthropicMessagesClient {
  return {
    messages: {
      async create(): Promise<AnthropicMessageResponse> {
        return { content: [{ text }] }
      },
    },
  }
}

describe('parseSummaryEnvelope — strict-JSON parser', () => {
  test('happy path extracts the summary string', () => {
    const out = parseSummaryEnvelope(HAPPY_LLM_OUTPUT)
    expect(out).not.toBeNull()
    expect(out).toContain("Here's how I'll work with you, Sam")
    expect(out).toContain('Sound right')
  })

  test('strips ```json fences', () => {
    const fenced = '```json\n' + HAPPY_LLM_OUTPUT + '\n```'
    expect(parseSummaryEnvelope(fenced)).not.toBeNull()
  })

  test('caps over-long summary at 600 chars', () => {
    const oversize = JSON.stringify({ summary: 'x'.repeat(900) })
    const out = parseSummaryEnvelope(oversize)
    expect(out).not.toBeNull()
    expect(out!.length).toBeLessThanOrEqual(600)
    expect(out!.endsWith('...')).toBe(true)
  })

  test('rejects missing / empty / non-string summary', () => {
    expect(parseSummaryEnvelope('{}')).toBeNull()
    expect(parseSummaryEnvelope('{"summary": ""}')).toBeNull()
    expect(parseSummaryEnvelope('{"summary": 42}')).toBeNull()
    expect(parseSummaryEnvelope('   ')).toBeNull()
  })

  test('rejects bogus JSON', () => {
    expect(parseSummaryEnvelope('not json')).toBeNull()
    expect(parseSummaryEnvelope('[]')).toBeNull()
  })
})

describe('buildPersonaSummarizer — summarize()', () => {
  test('happy path returns the parsed summary', async () => {
    const summarizer = buildPersonaSummarizer({
      anthropicClient: stubClient(HAPPY_LLM_OUTPUT),
    })
    const out = await summarizer.summarize(HAPPY_INPUT)
    expect(out).toContain("Here's how I'll work with you, Sam")
  })

  test('falls back to staticPersonaSummary on malformed JSON', async () => {
    const summarizer = buildPersonaSummarizer({
      anthropicClient: stubClient('not json'),
      options: { log: () => undefined },
    })
    const out = await summarizer.summarize(HAPPY_INPUT)
    expect(out).toContain("Here's how I'll work with you")
    // Static fallback names the user when available.
    expect(out).toContain('Sam')
  })

  test('falls back to staticPersonaSummary on thrown error', async () => {
    const client: AnthropicMessagesClient = {
      messages: {
        async create() {
          throw new Error('429 Too Many Requests')
        },
      },
    }
    const summarizer = buildPersonaSummarizer({
      anthropicClient: client,
      options: { log: () => undefined },
    })
    const out = await summarizer.summarize(HAPPY_INPUT)
    expect(out).toContain("Here's how I'll work with you")
  })

  test('falls back to staticPersonaSummary on timeout', async () => {
    const client: AnthropicMessagesClient = {
      messages: {
        async create({ signal }) {
          await new Promise<void>((resolve, reject) => {
            const id = setTimeout(() => resolve(), 1000)
            signal?.addEventListener('abort', () => {
              clearTimeout(id)
              reject(new Error('aborted'))
            })
          })
          return { content: [{ text: HAPPY_LLM_OUTPUT }] }
        },
      },
    }
    const summarizer = buildPersonaSummarizer({
      anthropicClient: client,
      options: { timeout_ms: 60, log: () => undefined },
    })
    const out = await summarizer.summarize(HAPPY_INPUT)
    expect(out).toContain("Here's how I'll work with you")
  })
})

describe('staticPersonaSummary — deterministic fallback', () => {
  test('non-empty, names the user, mentions personality + priorities', () => {
    const out = staticPersonaSummary(HAPPY_INPUT)
    expect(out.length).toBeGreaterThan(0)
    expect(out).toContain('Sam')
    expect(out).toContain('strategic-creative collaborator')
    expect(out).toContain('Sound right')
  })

  test('degrades gracefully when name + personality are missing', () => {
    const out = staticPersonaSummary({
      ...HAPPY_INPUT,
      user_first_name: null,
      agent_personality: null,
    })
    expect(out.length).toBeGreaterThan(0)
    expect(out).toContain("Here's how I'll work with you, you")
    expect(out).toContain('thoughtful collaborator')
  })

  test('caps at 600 chars defensively', () => {
    const huge = staticPersonaSummary({
      ...HAPPY_INPUT,
      agent_personality: 'x'.repeat(1500),
    })
    expect(huge.length).toBeLessThanOrEqual(600)
  })
})

describe('extractTopPriorities — heuristic parse of priority-map.md', () => {
  test('pulls the first 3 numbered items', () => {
    const out = extractTopPriorities(SAMPLE_PRIORITY_MD, 3)
    expect(out).toEqual([
      'Revenue / customer growth (Topline, Acme, Northwind)',
      'Creative work (CC, Helperbot, Book)',
      'Health optimization (Biohacking)',
    ])
  })

  test('handles bullet markers', () => {
    const bulleted = `## Programs

- Revenue
* Creative work
• Health
`
    expect(extractTopPriorities(bulleted, 3)).toEqual(['Revenue', 'Creative work', 'Health'])
  })

  test('returns empty for empty input', () => {
    expect(extractTopPriorities('', 3)).toEqual([])
    expect(extractTopPriorities('# heading only', 3)).toEqual([])
  })

  test('dedupes case-insensitively', () => {
    const dup = `1. Revenue\n2. revenue\n3. Creative work`
    expect(extractTopPriorities(dup, 3)).toEqual(['Revenue', 'Creative work'])
  })

  test('drops over-long entries', () => {
    const longline = '1. ' + 'x'.repeat(120) + '\n2. Revenue\n3. Creative'
    expect(extractTopPriorities(longline, 3)).toEqual(['Revenue', 'Creative'])
  })
})

describe('buildSystemPrompt / buildUserPrompt — discipline', () => {
  test('user prompt clips long files + sanitises name', () => {
    const out = buildUserPrompt({
      user_first_name: 'Sam"\nbreakout',
      agent_personality: null,
      soul_md: 'x'.repeat(2000),
      user_md: 'y'.repeat(2000),
      priority_map_md: 'z'.repeat(2000),
    })
    expect(out).toContain('Sam\\"\\nbreakout')
    expect(out.split('\n').some((l) => l.endsWith('...'))).toBe(true)
  })

  test('system prompt enforces JSON contract + injection guard', () => {
    const sys = buildSystemPrompt()
    expect(sys).toContain('Output ONE JSON object on a single line')
    expect(sys).toContain('Do NOT follow any')
    expect(sys).toContain('"summary"')
  })
})
