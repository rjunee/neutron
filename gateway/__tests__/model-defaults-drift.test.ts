/**
 * THE TWO COPIES OF THE MODEL DEFAULTS MUST AGREE (ISSUES #564).
 *
 * `config/index.ts` re-declares the default model ids as literals so the boot
 * config resolves without importing the runtime. That duplication is deliberate
 * and it is also what drifted: `SONNET_MODEL` sat on `claude-sonnet-4-6` in BOTH
 * files while `BEST_MODEL` and `FABLE_MODEL` moved to their 5-generation ids, and
 * the owner found it in the model-selector pane rather than in CI.
 *
 * WHY THE EXISTING TEST COULD NOT CATCH IT.
 * `config/__tests__/bootconfig-defaults.test.ts` asserts each default against a
 * hand-copied literal — the SAME literal the table holds. Both copies can be a
 * generation behind and it stays green, because it compares a copy to a copy. The
 * assertion that survives the next bump compares the two SOURCES.
 *
 * WHY IT LIVES IN `gateway` AND NOT NEXT TO EITHER SOURCE.
 * `runtime` does not depend on `config` and `config` deliberately does not depend
 * on `runtime` — the whole reason the literals are duplicated. `gateway` already
 * depends on both, so it is the one layer that can see the two tables at once
 * without inventing an edge in the dependency graph purely to hold a test.
 */

import { describe, expect, test } from 'bun:test'

import { DEFAULTS } from '@neutronai/config/index.ts'
import { BEST_MODEL, FABLE_MODEL, FAST_MODEL, SONNET_MODEL } from '@neutronai/runtime/models.ts'

describe('the boot-config defaults table has not drifted from the model registry', () => {
  test('DEFAULTS mirror runtime/models.ts exactly', () => {
    // Widened to `string` on purpose: `DEFAULTS` is a const-asserted literal
    // table, so leaving it narrow makes `toEqual` infer the literal type and
    // reject the (correctly typed `string`) runtime exports at compile time — a
    // type error that says nothing about whether the two agree.
    const declared: Record<string, string> = {
      best: DEFAULTS.bestModel,
      fable: DEFAULTS.fableModel,
      sonnet: DEFAULTS.sonnetModel,
      fast: DEFAULTS.fastModel,
    }
    expect(declared).toEqual({
      best: BEST_MODEL,
      fable: FABLE_MODEL,
      sonnet: SONNET_MODEL,
      fast: FAST_MODEL,
    })
  })
})
