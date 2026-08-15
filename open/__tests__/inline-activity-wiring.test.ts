/** Mutant pins for the production wiring. Part A runs the REAL composition — the
 * real tap mapper, the real ActivityInspector, the real `inspectorScopeKey` and the
 * real deriver the composer builds — so a wrong scope key, a stale clock or a
 * mis-classified tool fails here rather than passing a source-text regex. Part B
 * only pins that the composer still calls that one deriver at every read boundary,
 * which is the single thing no unit test can see. */
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
  isInlineEvidenceEdge,
  makeInlineActivityDeriver,
  type InlineEvidenceReader,
} from '@neutronai/work-board/inline-activity.ts'

/** Exactly the composition `open/composer.ts` performs: an empty holder bound to
 *  the inspector AFTER construction, and one deriver over `inspectorScopeKey`. */
function composeLikeTheComposer(now: () => number): {
  inspector: ActivityInspector
  derive: ReturnType<typeof makeInlineActivityDeriver>
} {
  const inspector = new ActivityInspector({ now })
  const reader: InlineEvidenceReader = {}
  const derive = makeInlineActivityDeriver({ reader, scopeKey: inspectorScopeKey, now })
  reader.lastWriteActivityAt = (scope): number => inspector.lastWriteActivityAt(scope)
  return { inspector, derive }
}

/** What the Pre/PostToolUse hook actually POSTs, mapped by the real mapper. */
function tap(
  inspector: ActivityInspector,
  project_id: string,
  input: { tool_name: string; detail?: string; args?: string },
): void {
  const row = activityRowFromToolTap({
    phase: 'pre',
    tool_name: input.tool_name,
    detail: input.detail ?? '',
    ...(input.args !== undefined ? { args: input.args } : {}),
  })
  if (row !== null) inspector.record(inspectorScopeKey(project_id), row)
}

const CARD = { status: 'in_progress', inline_active: false, linked_run_id: null }

describe('inline activity wiring — real inspector evidence', () => {
  test('(a) a real write tap activates the bound card, with no flag write anywhere', () => {
    const t = { v: 1_000_000 }
    const { inspector, derive } = composeLikeTheComposer(() => t.v)
    tap(inspector, 'proj-1', { tool_name: 'Edit', detail: 'src/x.ts' })

    expect(derive([CARD], 'proj-1')[0]?.inline_active).toBe(true)
    // Scope isolation: another project's board is unaffected.
    expect(derive([CARD], 'proj-2')[0]?.inline_active).toBe(false)
  })

  test('(a) a mutating shell call counts; a read-only one does not', () => {
    const t = { v: 1_000_000 }
    const { inspector, derive } = composeLikeTheComposer(() => t.v)
    tap(inspector, 'proj-1', {
      tool_name: 'Bash',
      detail: 'git status',
      args: JSON.stringify({ command: 'git status', description: 'look' }),
    })
    expect(derive([CARD], 'proj-1')[0]?.inline_active).toBe(false)

    tap(inspector, 'proj-1', {
      tool_name: 'Bash',
      detail: 'git commit -m x',
      args: JSON.stringify({ command: 'git commit -m x', description: 'commit' }),
    })
    expect(derive([CARD], 'proj-1')[0]?.inline_active).toBe(true)
  })

  test('(c) a whole conversation turn — no write — leaves every card quiet', () => {
    // THE REGRESSION THIS PINS: wired to the wedge clock instead of the write
    // clock, asking the agent one unrelated question marked every runless
    // in-progress card active for 90 s and hid ▶ on both clients.
    const t = { v: 1_000_000 }
    const { inspector, derive } = composeLikeTheComposer(() => t.v)
    const scope = inspectorScopeKey('proj-1')
    inspector.turnStarted(scope)
    tap(inspector, 'proj-1', { tool_name: 'Read', detail: 'src/x.ts' })
    tap(inspector, 'proj-1', { tool_name: 'Grep', detail: 'needle' })
    // The agent's own reply, exactly as the dev-channel tool taps it.
    tap(inspector, 'proj-1', { tool_name: 'mcp__neutron-abc__reply', args: 'here you go' })
    inspector.turnFinished(scope)

    const cards = [CARD, { ...CARD, inline_active: true }, { ...CARD, status: 'upcoming' }]
    expect(derive(cards, 'proj-1').map((c) => c.inline_active)).toEqual([false, false, false])
  })

  test('(c) LATCH-PROOF: real evidence expires on the wire and keepalives cannot renew it', () => {
    const t = { v: 1_000_000 }
    const { inspector, derive } = composeLikeTheComposer(() => t.v)
    tap(inspector, 'proj-1', { tool_name: 'Edit', detail: 'src/x.ts' })
    expect(derive([CARD], 'proj-1')[0]?.inline_active).toBe(true)

    t.v += INLINE_EVIDENCE_WINDOW_MS
    expect(derive([CARD], 'proj-1')[0]?.inline_active).toBe(false)
    inspector.record(inspectorScopeKey('proj-1'), {
      kind: 'keepalive',
      label: 'alive',
      synthetic: true,
    })
    expect(derive([CARD], 'proj-1')[0]?.inline_active).toBe(false)
  })

  test('(b) a fresh inspector heals a crashed session stale flag', () => {
    const { derive } = composeLikeTheComposer(() => 1_000_000)
    const stale = { status: 'in_progress', inline_active: true, linked_run_id: null }
    expect(derive([stale], 'proj-1')[0]?.inline_active).toBe(false)
  })
})

describe('inline activity wiring — composer source mutant pin', () => {
  test('all five read boundaries and the late binding remain wired', () => {
    // Cheapest honest pin: every closure requires a full gateway boot to execute.
    // The SEMANTICS live in the deriver above; this only holds the call sites on.
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, '..', 'composer.ts'), 'utf8')
    // One construction…
    expect(src.includes('makeInlineActivityDeriver({')).toBe(true)
    // …and every read boundary pinned BY NAME rather than by a call COUNT: a
    // count goes red on a benign refactor and cannot tell a call from a comment,
    // whereas each of these names the site it protects.
    for (const [site, pattern] of [
      ['rail extras', /deriveInlineActivity\(workBoardStore\.list\(scopeKey\)/],
      ['WS work_board_changed frame', /deriveInlineActivity\(workBoardStore\.list\(changedKey\)/],
      // The injected board the AGENT reads must be derived, not the stored flag.
      ['per-turn <work_board> fragment', /formatWorkBoardFragment\(\s*deriveInlineActivity\(/],
      ['HTTP surface dep (T3)', /trident_runs: boardRunAccess,[\s\S]{0,900}?derive_inline_active:/],
      ['work_board agent-tools dep (T4)', /store: workBoardStore,[\s\S]{0,400}?derive_inline_active:/],
      // The tap's OFF→ON edge: without it an already-open board never learns that
      // inline work started, because nothing else fans a frame for it.
      ['tool-tap evidence edge', /isInlineEvidenceEdge\(before, after\)[\s\S]{0,120}?fanWorkBoardChanged\(/],
    ] as const) {
      expect(`${site}: ${String(pattern.test(src))}`).toBe(`${site}: true`)
    }
    expect(src.includes('inlineEvidenceReader.lastWriteActivityAt =')).toBe(true)
    // …and the gateway must still thread the tools dep through to the surface.
    const coreModules = readFileSync(
      join(here, '..', '..', 'gateway', 'composition', 'build-core-modules.ts'),
      'utf8',
    )
    expect(coreModules.includes('deriveInlineActive')).toBe(true)
  })
})
