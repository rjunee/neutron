/** Mutant pins for the production wiring: Part A proves evidence semantics through
 * the real inspector/helper, while Part B makes deleting either otherwise deeply
 * nested composer call site or its late binding turn the suite red. */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ActivityInspector,
  activityRowFromToolTap,
  inspectorScopeKey,
} from '../activity-inspector.ts'
import {
  INLINE_EVIDENCE_WINDOW_MS,
  withDerivedInlineActive,
  type InlineEvidenceReader,
} from '@neutronai/work-board/inline-activity.ts'

describe('inline activity wiring — real inspector evidence', () => {
  test('real taps activate, expire without latching, and remain scope-isolated', () => {
    let now = 1_000_000
    const inspector = new ActivityInspector({ now: () => now })
    const reader: InlineEvidenceReader = {}
    reader.lastRealActivityAt = (scope) => inspector.lastRealActivityAt(scope)
    const row = activityRowFromToolTap({
      phase: 'pre',
      tool_name: 'Edit',
      detail: 'src/x.ts',
    })
    inspector.record(inspectorScopeKey('proj-1'), row!)
    const item = { status: 'in_progress', inline_active: false, linked_run_id: null }

    // No work_board_update exists in this path: the real tap is sufficient.
    expect(withDerivedInlineActive([item], reader, inspectorScopeKey('proj-1'), now)[0]?.inline_active).toBe(true)
    expect(withDerivedInlineActive([item], reader, inspectorScopeKey('proj-2'), now)[0]?.inline_active).toBe(false)

    now += INLINE_EVIDENCE_WINDOW_MS
    expect(withDerivedInlineActive([item], reader, inspectorScopeKey('proj-1'), now)[0]?.inline_active).toBe(false)
    inspector.record(inspectorScopeKey('proj-1'), {
      kind: 'keepalive',
      label: 'alive',
      synthetic: true,
    })
    expect(withDerivedInlineActive([item], reader, inspectorScopeKey('proj-1'), now)[0]?.inline_active).toBe(false)
  })

  test('a fresh inspector heals a crashed session stale flag', () => {
    const now = 1_000_000
    const inspector = new ActivityInspector({ now: () => now })
    const reader: InlineEvidenceReader = {
      lastRealActivityAt: (scope) => inspector.lastRealActivityAt(scope),
    }
    const stale = { status: 'in_progress', inline_active: true, linked_run_id: null }
    expect(withDerivedInlineActive([stale], reader, inspectorScopeKey('proj-1'), now)[0]?.inline_active).toBe(false)
  })
})

describe('inline activity wiring — composer source mutant pin', () => {
  test('all three read boundaries and the late binding remain wired', () => {
    // Cheapest honest pin: both closures require a full gateway boot to execute.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'composer.ts'),
      'utf8',
    )
    // Rail extras + the WS frame + the HTTP surface dep (T3) = three call sites.
    expect((src.match(/withDerivedInlineActive\(/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(src.includes('inlineEvidenceReader.lastRealActivityAt =')).toBe(true)
    // Deleting the HTTP surface's dep wiring turns this red.
    expect(src.includes('derive_inline_active:')).toBe(true)
  })
})
