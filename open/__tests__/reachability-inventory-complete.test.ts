/**
 * THE REACHABILITY GATE'S OWN GATE — has the inventory fallen behind the product?
 *
 * A reachability suite is only worth what its inventory covers, and an inventory
 * maintained by remembering is an inventory that rots. This is the piece that
 * makes it self-extending: it reads the product's real command factories out of
 * `gateway/boot-chat-command-filters.ts` and fails when one of them is neither
 * probed by `reachability.test.ts` nor excluded, in writing, with a reason.
 *
 * So the next `/`-command cannot ship the way `/code` did. Adding the filter turns
 * this gate red, and the two ways to turn it green again are: probe it (the
 * default), or write down why you are not going to and what that costs. Both are
 * decisions. Forgetting is not one of the options.
 *
 * WHY A SOURCE SCAN AND NOT A RUNTIME ONE. "Which commands does the composed chain
 * claim?" cannot be asked of the chain — a `ChatCommandFilter` is an opaque
 * `match()` and does not declare what it answers to. The alternative was to add a
 * `commands: string[]` field to the filter contract and thread it through every
 * implementation, which is a product change made to serve a test. The export list
 * of ONE small, stable file is the cheaper seam, and it is the same list a person
 * reads when they ask what commands exist.
 *
 * FALSE-ALARM SURFACE. Deliberately tiny: one file, one regex, over `export
 * function build…ChatCommandFilter`. It cannot fire on a renamed CSS class, a
 * moved component, or anything in a Core. The scan asserts it found a plausible
 * number of factories, so a refactor that moves this file elsewhere fails LOUDLY
 * as "the scan found nothing" rather than silently passing on an empty set — the
 * failure mode that let a dead gate sit green for days.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CHAT_COMMANDS, CHAT_COMMAND_EXCLUSIONS } from './reachability-inventory.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILTERS_FILE = join(HERE, '..', '..', 'gateway', 'boot-chat-command-filters.ts')

/**
 * Lower bound on how many factories the scan must find. Not an exact count — that
 * would be a second inventory to maintain, and the whole point is to have one.
 * This only has to be high enough that a scan matching nothing (moved file,
 * renamed convention, changed export style) is a failure instead of a pass.
 */
const MIN_EXPECTED_FACTORIES = 4

function exportedFilterFactories(): string[] {
  const source = readFileSync(FILTERS_FILE, 'utf8')
  const names = new Set<string>()
  const re = /^export function (build[A-Za-z0-9_]*ChatCommandFilter)\b/gm
  for (const m of source.matchAll(re)) names.add(m[1] as string)
  return [...names].sort()
}

describe('reachability — the inventory still describes the product', () => {
  test('the factory scan is alive', () => {
    const found = exportedFilterFactories()
    // A scan that matches nothing would make every assertion below vacuously
    // true. That is how a gate becomes decoration.
    expect(found.length).toBeGreaterThanOrEqual(MIN_EXPECTED_FACTORIES)
  })

  test('every chat-command filter in the product is either probed or excluded with a reason', () => {
    const found = exportedFilterFactories()
    const probed = new Set(CHAT_COMMANDS.map((c) => c.filter))
    const excluded = new Set(CHAT_COMMAND_EXCLUSIONS.map((e) => e.filter))

    const unaccounted = found.filter((f) => !probed.has(f) && !excluded.has(f))
    const report =
      unaccounted.length === 0
        ? ''
        : [
            'These chat-command filters exist in the product with no reachability entry.',
            'A filter can be built, unit-tested and merged while the composed chain never reaches it —',
            'that is how `/code` shipped unreachable. Add a probe to CHAT_COMMANDS, or an entry to',
            'CHAT_COMMAND_EXCLUSIONS saying why not:',
            ...unaccounted.map((f) => `  • ${f}`),
          ].join('\n')
    expect(report).toBe('')
  })

  test('the inventory does not describe filters that no longer exist', () => {
    // The other direction. A probe for a deleted filter would fail at runtime with
    // "the owner lost /foo", which is a confusing way to learn that /foo was
    // removed on purpose. Catch it here, where the message is accurate.
    const found = new Set(exportedFilterFactories())
    const stale = [
      ...CHAT_COMMANDS.map((c) => c.filter),
      ...CHAT_COMMAND_EXCLUSIONS.map((e) => e.filter),
    ].filter((f) => !found.has(f))
    expect(stale).toEqual([])
  })

  test('every exclusion carries a real reason', () => {
    // An exclusion is a decision with a cost. A blank `why` is a way of not
    // making the decision while looking like you did.
    const thin = CHAT_COMMAND_EXCLUSIONS.filter((e) => e.why.trim().length < 40).map(
      (e) => e.filter,
    )
    expect(thin).toEqual([])
  })
})
