/**
 * pane-ownership-is-one-fact.test.ts — #539, Argus r40.
 *
 * THE DEFECT THIS PREVENTS is not a bug in a function; it is a shape. `pane_handle` and
 * `adoption_claim_*` describe ONE fact — who is serving which pane — and while they were
 * ordinary record fields, any writer could move one without the other. Two defects came
 * out of that in a single round:
 *
 *   - a FRESH SPAWN wrote the handle and no claim, so a row was owned and unclaimed; an
 *     adopter starting while that gateway was alive claimed it and attached a second
 *     wrapper, and the spawner could not notice, because renewal returns immediately for
 *     a session with no claim of its own;
 *   - a REPLACEMENT SPAWN dropped the handle and KEPT the dead child's claim, so the row
 *     asserted ownership for a child that no longer existed and a restart inside the
 *     takeover window refused adoption on the strength of it.
 *
 * Four careful call sites is exactly what produced both. So the fields are written in ONE
 * module, through four named transitions (`ownPane`, `disownPane`, `handOverPane`,
 * `refreshPaneClaim`), and this case fails the build if any other module writes them
 * directly. **A table would not have saved the fifth path; this does.**
 *
 * READS ARE FINE and deliberately not banned — deciding on a row means reading it. What
 * is banned is WRITING: an object-literal key, a property assignment, or a destructure
 * that strips one of them out of a row.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SUBSYSTEM = join(HERE, '..')

/** The one module allowed to write these fields. */
const FUNNEL = 'repl-registry.ts'

const FIELDS = ['pane_handle', 'adoption_claim_at', 'adoption_claim_by', 'adoption_claim_pid']

/** A write is: an object-literal key (`pane_handle:`), an assignment (`.pane_handle =`),
 *  or a rest-destructure that removes it (`pane_handle: _x, ...rest`). All three are how
 *  the two defects were actually written. */
function writesOf(source: string): string[] {
  const hits: string[] = []
  for (const [i, rawLine] of source.split('\n').entries()) {
    const line = rawLine.trim()
    // Comments describe the rule constantly; they are not writes.
    if (line.startsWith('*') || line.startsWith('//')) continue
    for (const f of FIELDS) {
      if (new RegExp(`\\b${f}\\s*:`).test(line) || new RegExp(`\\.${f}\\s*=[^=]`).test(line)) {
        hits.push(`${i + 1}: ${line.slice(0, 110)}`)
      }
    }
  }
  return hits
}

describe('pane ownership is written in exactly one place', () => {
  it('no module outside the funnel writes the handle or its claim', () => {
    const offenders: Record<string, string[]> = {}
    for (const name of readdirSync(SUBSYSTEM)) {
      if (!name.endsWith('.ts') || name === FUNNEL) continue
      const hits = writesOf(readFileSync(join(SUBSYSTEM, name), 'utf8'))
      if (hits.length > 0) offenders[name] = hits
    }
    // Named rather than counted, so a failure says WHICH line to route through the funnel.
    expect(offenders).toEqual({})
  })

  it('...and the funnel itself still writes them, so the check is not vacuous', () => {
    // THE POSITIVE CONTROL, and it earns its place: a regex that matched nothing anywhere
    // would pass the case above for the wrong reason, and a renamed field would make the
    // whole guard silently inert.
    const funnel = readFileSync(join(SUBSYSTEM, FUNNEL), 'utf8')
    const hits = writesOf(funnel)
    expect(hits.length).toBeGreaterThanOrEqual(FIELDS.length)
    for (const f of FIELDS) {
      expect(funnel).toContain(f)
    }
  })
})
