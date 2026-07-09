/**
 * ISSUES #95 — project identity + context synthesis tests.
 *
 * The drift guard is load-bearing: `03-project-shells` keys its
 * `projects` rows off `slugifyProjectId(name)` and the onboarding-handoff
 * hook keys its per-project proactive seed off `defaultProjectIdSlugifier`
 * (now a re-export of the same function). If the two ever diverge, the
 * named sidebar project and the seed-question topic would split into two
 * disconnected things — exactly the #95 fragmentation. This asserts they
 * stay byte-identical across a representative corpus.
 */

import { describe, expect, test } from 'bun:test'
import {
  PROJECT_CONTEXT_MAX_CHARS,
  RELATED_SIGNAL_CAP,
  findRelatedImportSignal,
  slugifyProjectId,
  synthesizeProjectContext,
  weaveRelatedSignal,
} from '../project-identity.ts'
import { defaultProjectIdSlugifier } from '@neutronai/gateway/realmode-composer/build-onboarding-handoff.ts'
import type { ImportResult } from '../../history-import/types.ts'

function emptyImport(): ImportResult {
  return {
    entities: [],
    topics: [],
    proposed_projects: [],
    proposed_tasks: [],
    proposed_reminders: [],
    voice_signals: {},
    facts: {},
  }
}

describe('slugifyProjectId', () => {
  test('lowercases, dashes runs of non-slug chars, trims, caps', () => {
    expect(slugifyProjectId('Northwind Labs')).toBe('northwind-labs')
    expect(slugifyProjectId('Acme Holdco')).toBe('acme-holdco')
    expect(slugifyProjectId('Topline')).toBe('topline')
    expect(slugifyProjectId('  n8n  Automation  ')).toBe('n8n-automation')
    expect(slugifyProjectId('Home/Assistant!!')).toBe('home-assistant')
    expect(slugifyProjectId('a.b_c-d')).toBe('a.b_c-d')
  })

  test('collapses all-emoji / all-punctuation to the "project" fallback', () => {
    expect(slugifyProjectId('🚀🚀🚀')).toBe('project')
    expect(slugifyProjectId('!!!')).toBe('project')
    expect(slugifyProjectId('')).toBe('project')
  })

  test('caps at 64 chars', () => {
    const long = 'x'.repeat(200)
    expect(slugifyProjectId(long).length).toBe(64)
  })

  test('drift guard — handoff defaultProjectIdSlugifier is identical', () => {
    const corpus = [
      'Northwind',
      'Northwind Labs',
      'Topline',
      'Acme',
      'Acme Holdco',
      'Acme Ventures',
      'Info Playbooks',
      'Vibe Coding',
      'n8n Automation',
      'Home Assistant',
      'LA Property',
      'a.b_c-d',
      '🚀 rocket',
      '!!!',
      '',
      'X'.repeat(200),
    ]
    for (const name of corpus) {
      expect(defaultProjectIdSlugifier(name)).toBe(slugifyProjectId(name))
    }
  })
})

describe('synthesizeProjectContext', () => {
  test('prefers the user-captured rationale', () => {
    const ctx = synthesizeProjectContext(
      { name: 'Northwind', rationale: 'DTC supplement brand launch' },
      null,
    )
    expect(ctx).toContain('DTC supplement brand launch')
    expect(ctx.length).toBeGreaterThan(0)
  })

  test('falls back to the matching import rationale', () => {
    const ir = emptyImport()
    ir.proposed_projects = [
      { name: 'Topline', rationale: 'B2B hospitality JV with Sam Lee', suggested_topics: [] },
    ]
    const ctx = synthesizeProjectContext({ name: 'Topline' }, ir)
    expect(ctx).toContain('B2B hospitality JV')
  })

  test('never returns empty — names the project in the generic path', () => {
    const ctx = synthesizeProjectContext({ name: 'Mystery Project' }, null)
    expect(ctx.length).toBeGreaterThan(0)
    expect(ctx).toContain('Mystery Project')
  })

  test('bounds the paragraph', () => {
    const ctx = synthesizeProjectContext(
      { name: 'Big', rationale: 'word '.repeat(400) },
      null,
    )
    expect(ctx.length).toBeLessThanOrEqual(PROJECT_CONTEXT_MAX_CHARS)
  })

  // GAP2 (2026-06-09) — a freeform-added project with NO matching
  // proposed_projects row but cross-project signal (entities / topics /
  // inferred_interests that name it) gets content-aware context instead
  // of the bland "I don't have history" stub.
  test('GAP2: unmatched project draws content from cross-project import signal', () => {
    const ir = emptyImport()
    ir.proposed_projects = [
      { name: 'Topline', rationale: 'unrelated', suggested_topics: [] },
    ]
    ir.topics = [{ name: 'Biohacking cold plunge', recurrence_score: 0.8, recency_score: 0.9 }]
    ir.inferred_interests = [{ name: 'biohacking', basis: 'mentioned often' }]
    const ctx = synthesizeProjectContext({ name: 'Biohacking' }, ir)
    expect(ctx).not.toContain("don't have history")
    expect(ctx.toLowerCase()).toContain('biohacking')
    expect(ctx).toContain('Biohacking') // names the project
  })

  test('GAP2: falls to the generic stub only when import has zero related signal', () => {
    const ir = emptyImport()
    ir.topics = [{ name: 'Topline sales pipeline', recurrence_score: 0.5, recency_score: 0.5 }]
    const ctx = synthesizeProjectContext({ name: 'Gardening' }, ir)
    expect(ctx).toContain("don't have history")
    expect(ctx).toContain('Gardening')
  })
})

describe('findRelatedImportSignal (GAP2)', () => {
  test('null import → empty signal', () => {
    expect(findRelatedImportSignal('Buddhism', null)).toEqual({
      entities: [],
      topics: [],
      interests: [],
    })
  })

  test('matches by case-insensitive substring in either direction', () => {
    const ir = emptyImport()
    ir.entities = [
      { name: 'Buddhism study group', kind: 'concept', mention_count: 3 },
      { name: 'Topline JV', kind: 'company', mention_count: 9 },
    ]
    ir.topics = [{ name: 'buddhism daily sit', recurrence_score: 0.7, recency_score: 0.6 }]
    ir.inferred_interests = [{ name: 'Buddhism & meditation' }]
    const sig = findRelatedImportSignal('Buddhism', ir)
    expect(sig.entities).toContain('Buddhism study group')
    expect(sig.entities).not.toContain('Topline JV')
    expect(sig.topics).toContain('buddhism daily sit')
    expect(sig.interests).toContain('Buddhism & meditation')
  })

  test('dedups case-insensitively and caps each list', () => {
    const ir = emptyImport()
    ir.topics = Array.from({ length: 10 }, (_, i) => ({
      name: `biohacking topic ${i}`,
      recurrence_score: 0.5,
      recency_score: 0.5,
    }))
    const sig = findRelatedImportSignal('Biohacking', ir)
    expect(sig.topics.length).toBe(RELATED_SIGNAL_CAP)
  })

  test('does NOT match a short signal that only appears INSIDE an unrelated word (Codex P2)', () => {
    // Pre-fix, bare substring matching let "AI" match "Daily Review" (the
    // "ai" inside "Daily") and "HR" match "Charity". Token matching with a
    // 4-char floor kills those false positives.
    const ir = emptyImport()
    ir.topics = [
      { name: 'AI', recurrence_score: 0.9, recency_score: 0.9 },
      { name: 'HR', recurrence_score: 0.9, recency_score: 0.9 },
      { name: 'PR', recurrence_score: 0.9, recency_score: 0.9 },
    ]
    const sig = findRelatedImportSignal('Daily Review', ir)
    expect(sig.topics).not.toContain('AI')
    expect(sig.topics).not.toContain('HR')
    expect(sig.topics).not.toContain('PR')
    expect(sig.topics.length).toBe(0)
  })

  test('matches on a shared whole word-token (not a substring within a word)', () => {
    const ir = emptyImport()
    ir.topics = [
      { name: 'AI research roadmap', recurrence_score: 0.8, recency_score: 0.8 },
      { name: 'daily standup', recurrence_score: 0.8, recency_score: 0.8 },
    ]
    // "Research projects" shares the whole token "research" (≥4) with the
    // first topic; the second shares no ≥4-char token.
    const sig = findRelatedImportSignal('Research projects', ir)
    expect(sig.topics).toContain('AI research roadmap')
    expect(sig.topics).not.toContain('daily standup')
  })
})

describe('weaveRelatedSignal (GAP2)', () => {
  test('empty signal → empty string', () => {
    expect(weaveRelatedSignal('X', { entities: [], topics: [], interests: [] })).toBe('')
  })

  test('weaves topics, entities, interests into a named paragraph', () => {
    const woven = weaveRelatedSignal('Biohacking', {
      entities: ['Whoop band'],
      topics: ['cold plunge protocol'],
      interests: ['biohacking'],
    })
    expect(woven).toContain('Biohacking')
    expect(woven).toContain('cold plunge protocol')
    expect(woven).toContain('Whoop band')
    expect(woven).toContain('biohacking')
  })
})
