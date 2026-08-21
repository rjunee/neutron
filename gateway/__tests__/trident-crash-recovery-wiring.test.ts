/**
 * T4's composition half: deleting the one `begin_crash_recovery` wiring line in
 * `build-core-modules.ts` silently restores production's reap-on-crash behavior
 * while every `trident/` unit test stays green. This composer is
 * unreachable as a focused unit, so the established source-pin pattern is the
 * narrow test that proves the production callback remains connected.
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

describe('the COMPOSER supplies crash-recovery claims', () => {
  it('wires begin_crash_recovery directly to the trident run store', async () => {
    const src = strip(
      await Bun.file(new URL('../composition/build-core-modules.ts', import.meta.url)).text(),
    )

    expect(
      src.includes('orchestratorOpts.begin_crash_recovery = (id) => store.beginCrashRecovery(id)'),
    ).toBe(true)
    expect(
      src.includes('orchestratorOpts.begin_infra_retry = (id) => store.beginInfraRetry(id)'),
    ).toBe(true)
  })
})
