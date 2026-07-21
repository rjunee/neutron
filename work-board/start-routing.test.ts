/**
 * #379 — the ▶ START / job-dispatch routes BY TASK TYPE, not by assuming every
 * card is a Trident build. A 'research' card must dispatch via ATLAS
 * (agent-dispatch); a 'build' card via the Trident loop. Pre-#379 the play
 * button stamped 'building' / Trident on EVERYTHING.
 */
import { describe, expect, test } from 'bun:test'

import { routeBoardStart, startDispatchTargetForTaskType } from './start-routing.ts'

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
