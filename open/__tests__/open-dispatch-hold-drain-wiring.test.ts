/**
 * The dispatch-hold DRAIN wire at the Open composition boundary.
 *
 * ARGUS r4 (major): `gateway/composition/build-core-modules-trident-fire-evidence-wiring.test.ts`
 * proves that a `drain_dispatch_holds` callback HANDED TO `buildCoreModules` is
 * called on the tick's cadence — it injects its own callback, so it says nothing
 * about whether production hands one over at all. Deleting
 * `drain_dispatch_holds: () => tridentHoldSweep()` from `open/composer.ts` left
 * every test in the repo green, and that one line is the ONLY trigger a
 * worktree-only `branch_live` hold can ever have: the hold is waiting on a pid,
 * and a pid exiting fires no terminal observer, so without the cadence drain the
 * card queues forever on a quiet instance.
 *
 * Source-scoped, on the honest-coverage precedent of
 * `open-terminal-build-wake-wiring.test.ts`'s own wiring test: booting the whole
 * graph to observe a sweep would prove this single fact at ~30 s a run.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, '..', 'composer.ts'), 'utf8')

describe('open/composer.ts wires the dispatch-hold drain into the trident tick', () => {
  test('the tick loop is handed the sweep as drain_dispatch_holds', () => {
    expect(SRC.includes('drain_dispatch_holds: () => tridentHoldSweep()')).toBe(true)
    // Exactly one wire: a second would drain twice per tick.
    expect(SRC.split('drain_dispatch_holds:').length).toBe(2)
  })

  test('the sweep is built once and shared with the terminal observers', () => {
    expect(SRC.split('buildDispatchHoldSweep(').length).toBe(2)
    // The construction, the two terminal-observer registrations, and the drain.
    expect((SRC.match(/tridentHoldSweep/g) ?? []).length).toBe(4)
  })
})
