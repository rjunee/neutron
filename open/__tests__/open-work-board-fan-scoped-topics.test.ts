/**
 * THE WORK BOARD'S LIVE PUSH HAS TO REACH THE TOPIC THE OWNER IS ACTUALLY ON.
 *
 * THE DEFECT (owner-reported 2026-08-11, verbatim: "The workboard is not
 * responding at all to realtime changes"): `fanWorkBoardChanged` addressed its
 * snapshot to `appWsTopicId(OWNER)` — the BASE topic — and only that. A board
 * open on a project lives on `<base>:<project_id>`, and the session registry
 * matches topics EXACTLY, so the frame was delivered to nobody who was looking.
 * The pane changed only on a manual reload, which re-fetches over HTTP.
 *
 * WHAT MADE IT INVISIBLE: the sibling `activity_event` fan in the same file has
 * always fanned to the base topic AND every live scoped topic. So the activity
 * dot pulsed while the board sat dead — two frames, two delivery paths, one of
 * them addressed to where the owner was. A symptom pair that looks like "the
 * board is slow" rather than "the board is unreachable".
 *
 * These tests assert the REGISTRY SEMANTICS that make the bug real, against the
 * production `InMemoryAppWsSessionRegistry` — not a fake. If exact-match ever
 * became prefix-match, the first test fails and this whole class of bug changes
 * shape, which is worth knowing.
 */

import { describe, expect, test } from 'bun:test'

import { InMemoryAppWsSessionRegistry } from '@neutronai/channels/adapters/app-ws/session-registry.ts'
// `AppWsOutbound` is declared in `envelope.ts`; session-registry.ts imports it
// without re-exporting, so importing it from there typechecks nowhere.
import type { AppWsOutbound } from '@neutronai/channels/adapters/app-ws/envelope.ts'

const BASE = 'app:owner'
const SCOPED = 'app:owner:neutron-open'

const boardFrame = (): AppWsOutbound =>
  ({ v: 1, type: 'work_board_changed', items: [], project_id: 'neutron-open', ts: 1 }) as unknown as AppWsOutbound

/** Register a session on a topic and collect what it receives. */
function session(reg: InMemoryAppWsSessionRegistry, topic: string): AppWsOutbound[] {
  const got: AppWsOutbound[] = []
  reg.register(topic, (env: AppWsOutbound) => {
    got.push(env)
  })
  return got
}

describe('the registry matches topics EXACTLY — which is why a base-only fan was invisible', () => {
  test('a send to the BASE topic does NOT reach a session on the SCOPED topic', () => {
    const reg = new InMemoryAppWsSessionRegistry()
    const scoped = session(reg, SCOPED)
    // This is the pre-fix behaviour, in one line.
    reg.send(BASE, boardFrame())
    expect(scoped).toHaveLength(0) // ← the owner's dead board, reproduced
  })

  test('and a send to the SCOPED topic does not reach a base-only session either', () => {
    const reg = new InMemoryAppWsSessionRegistry()
    const base = session(reg, BASE)
    reg.send(SCOPED, boardFrame())
    expect(base).toHaveLength(0)
  })
})

describe('the fix: base + every live scoped topic', () => {
  // The exact shape the composer now uses for the board fan.
  function fanLikeComposer(reg: InMemoryAppWsSessionRegistry, frame: AppWsOutbound): void {
    const scopedPrefix = `${BASE}:`
    reg.send(BASE, frame)
    for (const topic of reg.topics()) {
      if (topic.startsWith(scopedPrefix)) reg.send(topic, frame)
    }
  }

  test('reaches a project board AND the General board in one fan', () => {
    const reg = new InMemoryAppWsSessionRegistry()
    const base = session(reg, BASE)
    const scoped = session(reg, SCOPED)
    fanLikeComposer(reg, boardFrame())
    expect(base).toHaveLength(1)
    expect(scoped).toHaveLength(1)
  })

  test('delivers each frame exactly ONCE per socket — no double-apply', () => {
    // Each socket lives on exactly one topic, so widening the fan cannot
    // duplicate. Asserted because "send to more places" is the kind of fix that
    // trades a silent drop for a silent duplicate.
    const reg = new InMemoryAppWsSessionRegistry()
    const base = session(reg, BASE)
    const a = session(reg, SCOPED)
    const b = session(reg, 'app:owner:pristine')
    fanLikeComposer(reg, boardFrame())
    expect(base).toHaveLength(1)
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  test('a scoped topic that is NOT under this base is never touched', () => {
    const reg = new InMemoryAppWsSessionRegistry()
    const other = session(reg, 'app:someone-else:proj')
    session(reg, BASE)
    fanLikeComposer(reg, boardFrame())
    expect(other).toHaveLength(0)
  })
})

describe('the PRODUCTION fan actually does this (wiring, not just mechanism)', () => {
  test('composer fans the board to scoped topics, exactly as it fans activity_event', async () => {
    const src = await Bun.file(new URL('../composer.ts', import.meta.url)).text()
    const at = src.indexOf('const fanWorkBoardChanged =')
    expect(at).toBeGreaterThan(-1)
    const body = src.slice(at, src.indexOf('work_board_push_failed', at))
    // The two load-bearing lines. Without the loop the frame is base-only again.
    expect(body).toContain('appWsRegistry.topics()')
    expect(body).toContain('startsWith(scopedPrefix)')
  })
})
