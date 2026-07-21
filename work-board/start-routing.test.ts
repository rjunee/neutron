/**
 * #379 — the ▶ START / job-dispatch routes BY TASK TYPE, not by assuming every
 * card is a Trident build. A 'research' card must dispatch via ATLAS
 * (agent-dispatch); a 'build' card via the Trident loop. Pre-#379 the play
 * button stamped 'building' / Trident on EVERYTHING.
 */
import { describe, expect, test } from 'bun:test'

import {
  applyResearchOutcome,
  routeBoardStart,
  startDispatchTargetForTaskType,
} from './start-routing.ts'

describe('start-routing — task-type dispatch decision', () => {
  test('a research card targets ATLAS, a build card targets Trident', () => {
    expect(startDispatchTargetForTaskType('research')).toBe('atlas')
    expect(startDispatchTargetForTaskType('build')).toBe('trident')
  })

  test('routeBoardStart runs the RESEARCH dispatcher (Atlas) for a research card', async () => {
    let research = 0
    let build = 0
    const out = await routeBoardStart(
      { task_type: 'research' },
      {
        research: async () => {
          research += 1
          return 'atlas-run'
        },
        build: async () => {
          build += 1
          return 'trident-run'
        },
      },
    )
    expect(out).toBe('atlas-run')
    expect(research).toBe(1)
    expect(build).toBe(0) // the build/Trident path did NOT fire for research
  })

  test('routeBoardStart runs the BUILD dispatcher (Trident) for a build card', async () => {
    let research = 0
    let build = 0
    const out = await routeBoardStart(
      { task_type: 'build' },
      {
        research: async () => {
          research += 1
          return 'atlas-run'
        },
        build: async () => {
          build += 1
          return 'trident-run'
        },
      },
    )
    expect(out).toBe('trident-run')
    expect(build).toBe(1)
    expect(research).toBe(0) // the research/Atlas path did NOT fire for a build
  })
})

describe('applyResearchOutcome — #379 blocker: the ▶-research TERMINAL wiring', () => {
  function spyBoard(): {
    board: {
      complete: (s: string, i: string) => Promise<unknown>
      failUnlinkedRun: (s: string, i: string, r: string) => Promise<void>
    }
    completeCalls: Array<[string, string]>
    failCalls: Array<[string, string, string]>
  } {
    const completeCalls: Array<[string, string]> = []
    const failCalls: Array<[string, string, string]> = []
    return {
      board: {
        complete: async (s, i) => {
          completeCalls.push([s, i])
          return null
        },
        failUnlinkedRun: async (s, i, r) => {
          failCalls.push([s, i, r])
        },
      },
      completeCalls,
      failCalls,
    }
  }

  test('a FINISHED run completes the card (done → pane auto-closes), never fails it', async () => {
    const b = spyBoard()
    await applyResearchOutcome(b.board, 'proj', 'card-1', { status: 'finished', run_id: 'atlas-1' })
    expect(b.completeCalls).toEqual([['proj', 'card-1']])
    expect(b.failCalls).toEqual([]) // the crash path must NOT fire on success
  })

  // The exact gap that let the blocker ship: no crashed-completion test existed.
  for (const status of ['crashed', 'cancelled', 'timed_out'] as const) {
    test(`a ${status} run FAILS the card (clear link + status=failed), never completes it`, async () => {
      const b = spyBoard()
      await applyResearchOutcome(b.board, 'proj', 'card-1', { status, run_id: 'atlas-1' })
      // Pre-#379 the composer only handled `finished`, so a non-success terminal
      // did NOTHING → the card stayed in_progress forever. It must fail it.
      expect(b.failCalls).toEqual([['proj', 'card-1', 'atlas-1']])
      expect(b.completeCalls).toEqual([]) // must NOT complete a crashed run
    })
  }
})
