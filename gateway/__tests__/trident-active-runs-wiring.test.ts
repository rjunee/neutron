/**
 * THE LINE WITHOUT WHICH THE TEST-BUDGET CHAIN IS INERT.
 *
 * `trident/test-strategy.ts` divides the box's cores across the builds actually in
 * flight, `orchestrator.resolve_active_runs` is the seam that supplies that count, and
 * `launch()` consumes it — all of which work perfectly in isolation while every build
 * assumes an idle box, unless the COMPOSER (which is the only layer holding a
 * `TridentRunStore`) actually wires the producer.
 *
 * That is exactly how `resolve_phase_models` shipped inert, and it was found by review
 * rather than by a test. So this is a source assertion, in the style of
 * `trident-phase-models-producer.test.ts`: the composition is not reachable from a unit
 * test, but its ABSENCE is the defect, and absence is checkable.
 */

import { describe, expect, it } from 'bun:test'

/** Strip comments so a mention in prose can never satisfy an assertion. */
const strip = (src: string): string =>
  src
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

describe('the COMPOSER supplies the live-run-count resolver', () => {
  it('wires resolve_active_runs from the trident run store', async () => {
    const src = strip(
      await Bun.file(new URL('../composition/build-core-modules.ts', import.meta.url)).text(),
    )
    expect(src.includes('orchestratorOpts.resolve_active_runs = () =>')).toBe(true)
    expect(src.includes('store.listNonTerminal(')).toBe(true)
  })

  it('counts only the BUILD phases — a run parked in planning or review burns tokens, not cores', async () => {
    const src = strip(
      await Bun.file(new URL('../composition/build-core-modules.ts', import.meta.url)).text(),
    )
    const wiring = src.slice(src.indexOf('orchestratorOpts.resolve_active_runs'))
    const line = wiring.slice(0, wiring.indexOf('\n', wiring.indexOf('.filter(')))
    expect(line).toContain("'forge-init'")
    expect(line).toContain("'forge-fix'")
  })

  it('wires it UNCONDITIONALLY — the store is always constructed in that scope', async () => {
    // A guarded assignment would leave the common path (no explicit trident wiring)
    // budgeting for an idle box, which is the inert-feature shape this file exists for.
    const src = strip(
      await Bun.file(new URL('../composition/build-core-modules.ts', import.meta.url)).text(),
    )
    const line = src
      .split('\n')
      .find((l) => l.includes('orchestratorOpts.resolve_active_runs'))
    expect(line).toBeDefined()
    expect(String(line).trim().startsWith('orchestratorOpts.resolve_active_runs')).toBe(true)
  })

  it('the ORCHESTRATOR actually threads test_strategy into the fire', async () => {
    const src = strip(
      await Bun.file(new URL('../../trident/orchestrator.ts', import.meta.url)).text(),
    )
    const call = src.slice(src.indexOf('const firePromise = fireWorkflow({'))
    const block = call.slice(0, call.indexOf('\n    })'))
    expect(block.includes('test_strategy,')).toBe(true)
  })
})
