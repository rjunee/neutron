/**
 * RA5 §(a) — the live-agent scope fragment surfaces the backend-neutral
 * `memory_search` recall tool in the prompt (and never the old `gbrain_search`).
 *
 * The tool rename is only half the requirement: the plan says "Update the
 * system-prompt hint" so the agent actually reaches for memory recall instead of
 * only grepping the filesystem. These assertions pin the RENDERED prompt text,
 * so a regression (dropping the hint, or reintroducing the old name) fails here.
 */
import { describe, expect, test } from 'bun:test'

import { buildLiveAgentScopeFragment } from '../live-agent-scope-fragment.ts'
import { MEMORY_SEARCH_TOOL } from '@neutronai/gbrain-memory/agent-tool.ts'

describe('buildLiveAgentScopeFragment — RA5 memory-recall hint', () => {
  test('General scope names memory_search and NOT gbrain_search', () => {
    const frag = buildLiveAgentScopeFragment({ scope: 'general' })
    expect(frag).toContain('memory_search')
    // The registered tool name is the exact string the agent must be steered to.
    expect(frag).toContain(MEMORY_SEARCH_TOOL)
    expect(frag).not.toContain('gbrain_search')
    // Still steers to the on-disk workspace too (both recall paths present).
    expect(frag).toContain('working directory')
  })

  test('General scope distinguishes memory_search from doc_search / message_search', () => {
    const frag = buildLiveAgentScopeFragment({ scope: 'general' })
    expect(frag).toContain('doc_search')
    expect(frag).toContain('message_search')
  })

  test('project scope surfaces memory_search, keeps the doc-link marker, leaks no backend name', () => {
    const frag = buildLiveAgentScopeFragment({ scope: 'project', project_id: 'gondor' })
    // Project turns also use long-term recall — the tool must be present here too.
    expect(frag).toContain(MEMORY_SEARCH_TOOL)
    expect(frag).toContain('memory_search')
    expect(frag).toContain('docs:/gondor/')
    expect(frag).toContain('project topic')
    expect(frag).not.toContain('gbrain_search')
  })
})
