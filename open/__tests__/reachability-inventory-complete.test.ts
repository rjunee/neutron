/**
 * THE REACHABILITY GATE'S OWN GATE — has the inventory fallen behind the product?
 *
 * A reachability suite is only worth what its inventory covers, and an inventory
 * maintained by remembering is an inventory that rots. This is the piece that
 * makes it self-extending: it reads the product's real chat-command filter
 * factories out of the source (`chat-command-filter-scan.ts`) and fails when one
 * of them is neither probed by `reachability.test.ts`, nor pinned as known-broken,
 * nor excluded, in writing, with a reason.
 *
 * WHAT THIS FILE GOT WRONG FOR ITS FIRST LIFE — read this before trusting it.
 * It used to scan ONE hardcoded path with ONE regex over `export function
 * build…ChatCommandFilter`, and its own header called that "a deliberately tiny
 * false-alarm surface". It was a deliberately tiny TRUE-alarm surface. The scan
 * saw 4 factories; the product had 11. Five of the seven it missed are live in
 * the composed chain — `/skills`, `/email`, `/research`, and both halves of
 * `/cal` — so unwiring any of them turned nothing red, which is the precise
 * failure this gate was built to make impossible. It was defeated three ways at
 * once: by LOCATION (a filter in any other file), by NAMING (`create…` instead of
 * `build…`), and by a factory called `…Dispatcher` that names the concept nowhere
 * in its signature except its return type. An auditor read the file before this
 * and missed all of it, afterwards saying they had taken the header's
 * self-defence at face value. So: the paragraph below is a statement of coverage,
 * not a reassurance, and where the coverage stops it says so.
 *
 * WHAT IT COVERS. Every exported function in every non-test `.ts`/`.tsx` file
 * under the repo (minus `node_modules`, `vendor/`, build output) whose name OR
 * declared return type ends in `ChatCommandFilter`.
 *
 * WHAT IT DOES NOT COVER, and nothing else does either:
 *   • A factory with an uninformative name and an INFERRED return type. The scan
 *     does not run the type checker; such a factory is invisible to it.
 *   • A filter written inline at its composition site instead of by a factory.
 *   • Whether a factory it found is COMPOSED. This file asks "does it exist and
 *     is it accounted for". Only `reachability.test.ts` types the command, and
 *     only for the inventory's own entries — so the two filters excluded from
 *     probing (`/cal`, `/remind`) have nothing proving they are still wired.
 *   • `vendor/`.
 * If you are here because you are adding a command, the thing to check by hand is
 * the first two bullets.
 *
 * WHY A SOURCE SCAN AND NOT A RUNTIME ONE. "Which commands does the composed
 * chain claim?" cannot be asked of the chain — a `ChatCommandFilter` is an opaque
 * `match()` and does not declare what it answers to. The alternative was to add a
 * `commands: string[]` field to the filter contract and thread it through every
 * implementation, which is a product change made to serve a test.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ChatCommandFilterScanError,
  scanChatCommandFilterFactories,
} from './chat-command-filter-scan.ts'
import {
  CHAT_COMMANDS,
  CHAT_COMMANDS_COVERED_ELSEWHERE,
  CHAT_COMMANDS_KNOWN_UNREACHABLE,
  CHAT_COMMAND_EXCLUSIONS,
} from './reachability-inventory.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')

/**
 * Lower bound on how many factories the scan must find. Not an exact count —
 * that would be a second inventory to maintain, and the whole point is to have
 * one. It only has to be high enough that a scan matching little or nothing (a
 * moved root, a narrowed pattern, a refactor into a shape the parse cannot
 * follow) is a failure instead of a pass. The repo has 11 today; the floor sits
 * just under so that deleting a Core is not a false red, while the four the old
 * hardcoded scan used to see would no longer clear it.
 */
const MIN_EXPECTED_FACTORIES = 8

/**
 * The scan must find factories in more than one top-level directory.
 *
 * This is the anti-regression assertion for the exact defect above: the old scan
 * read a single hardcoded file, and single-file is indistinguishable from
 * healthy when you only count. If a future change narrows the root back down to
 * `gateway/`, the count alone would still clear the floor above — this would not.
 */
const MIN_EXPECTED_DIRS = 2

const factories = (): string[] => scanChatCommandFilterFactories(REPO_ROOT).map((f) => f.name)

describe('reachability — the inventory still describes the product', () => {
  test('the factory scan is alive, and is not reading one directory', () => {
    const found = scanChatCommandFilterFactories(REPO_ROOT)
    // A scan that matches nothing would make every assertion below vacuously
    // true. That is how a gate becomes decoration.
    expect(found.length).toBeGreaterThanOrEqual(MIN_EXPECTED_FACTORIES)
    const dirs = new Set(found.map((f) => f.file.split(sep)[0]))
    expect([...dirs].sort().length).toBeGreaterThanOrEqual(MIN_EXPECTED_DIRS)
  })

  test('every chat-command filter in the product is probed, pinned, or excluded with a reason', () => {
    const found = factories()
    const probed = new Set(CHAT_COMMANDS.map((c) => c.filter))
    const pinned = new Set(CHAT_COMMANDS_KNOWN_UNREACHABLE.map((c) => c.filter))
    const excluded = new Set(CHAT_COMMAND_EXCLUSIONS.map((e) => e.filter))

    const unaccounted = found.filter(
      (f) => !probed.has(f) && !pinned.has(f) && !excluded.has(f),
    )
    const report =
      unaccounted.length === 0
        ? ''
        : [
            'These chat-command filters exist in the product with no reachability entry.',
            'A filter can be built, unit-tested and merged while the composed chain never reaches it —',
            'that is how `/code` shipped unreachable. Add a probe to CHAT_COMMANDS, an entry to',
            'CHAT_COMMANDS_KNOWN_UNREACHABLE if it is broken today, or one to',
            'CHAT_COMMAND_EXCLUSIONS saying why you are not probing it and what that costs:',
            ...unaccounted.map((f) => `  • ${f}`),
          ].join('\n')
    expect(report).toBe('')
  })

  test('the inventory does not describe filters that no longer exist', () => {
    // The other direction. A probe for a deleted filter would fail at runtime with
    // "the owner lost /foo", which is a confusing way to learn that /foo was
    // removed on purpose. Catch it here, where the message is accurate.
    const found = new Set(factories())
    const stale = [
      ...CHAT_COMMANDS.map((c) => c.filter),
      ...CHAT_COMMANDS_KNOWN_UNREACHABLE.map((c) => c.filter),
      ...CHAT_COMMAND_EXCLUSIONS.map((e) => e.filter),
    ].filter((f) => !found.has(f))
    expect(stale).toEqual([])
  })

  test('no filter is classified twice', () => {
    // Probed AND excluded is not a stricter setting, it is an unresolved
    // disagreement: the exclusion says the gate does not watch this, the probe
    // says it does, and whoever reads only one of them is misinformed.
    const seen = new Map<string, string[]>()
    const note = (name: string, list: string): void => {
      seen.set(name, [...(seen.get(name) ?? []), list])
    }
    for (const c of CHAT_COMMANDS) note(c.filter, 'CHAT_COMMANDS')
    for (const c of CHAT_COMMANDS_KNOWN_UNREACHABLE) note(c.filter, 'KNOWN_UNREACHABLE')
    for (const e of CHAT_COMMAND_EXCLUSIONS) note(e.filter, 'EXCLUSIONS')
    const dupes = [...seen.entries()]
      .filter(([, lists]) => lists.length > 1)
      .map(([name, lists]) => `${name} → ${lists.join(' + ')}`)
    expect(dupes).toEqual([])
  })

  test('every exclusion carries a real reason', () => {
    // An exclusion is a decision with a cost. A blank `why` is a way of not
    // making the decision while looking like you did.
    const thin = CHAT_COMMAND_EXCLUSIONS.filter((e) => e.why.trim().length < 40).map(
      (e) => e.filter,
    )
    expect(thin).toEqual([])
  })

  test('every known-unreachable entry states its evidence and its cost', () => {
    // Same bar as an exclusion, doubled: an entry here is an admission that a
    // command is broken, so it owes the reader both why it is broken and what
    // the owner cannot do until it is fixed.
    const thin = CHAT_COMMANDS_KNOWN_UNREACHABLE.filter(
      (c) => c.why.trim().length < 40 || c.cost.trim().length < 40,
    ).map((c) => c.filter)
    expect(thin).toEqual([])
  })

  test('every command this gate cannot see is covered by a test that EXISTS', () => {
    // The three lists above are keyed on filter factories. A command built any
    // other way is invisible to all of them — and invisible is worse than
    // excluded, because an exclusion is at least written down. `/task` was that
    // shape and went unwired for as long as it went unlisted.
    //
    // The cover is only worth anything if the file is really there, so this
    // reads the disk rather than trusting the string. A pointer to a deleted
    // test is the same dangling citation that let three green tests describe a
    // `gateway/index.ts:2434-2455` that has not existed since the OSS split.
    const missing = CHAT_COMMANDS_COVERED_ELSEWHERE.filter(
      (c) => !existsSync(join(REPO_ROOT, c.covered_by)),
    ).map((c) => `${c.command} → ${c.covered_by}`)
    expect(missing).toEqual([])

    // And the reason has to name a MECHANISM. "it is different" is not a reason.
    const thin = CHAT_COMMANDS_COVERED_ELSEWHERE.filter(
      (c) => c.invisible_because.trim().length < 40,
    ).map((c) => c.command)
    expect(thin).toEqual([])
  })

  test('the covered-elsewhere set is pinned, so an entry cannot be quietly dropped', () => {
    // Deliberately an equality against a named set rather than a floor. Every
    // other list here is protected by the scan — drop an entry and the factory
    // it accounted for becomes unclassified and the build fails. These entries
    // have no such backstop precisely BECAUSE the scan cannot see them, so
    // deleting one would silently restore the invisible state this list exists
    // to end. Pinning the set is the only thing standing in the way.
    //
    // Adding a command here is a deliberate act: extend this list in the same
    // commit, and only after its covering test is real.
    expect(CHAT_COMMANDS_COVERED_ELSEWHERE.map((c) => c.command).sort()).toEqual(['/task'])
  })
})

/**
 * THE SCAN'S OWN REFUSALS, each with a fixture that proves it fires.
 *
 * These are the blind-gate cases. Every one of them used to be a silent pass:
 * point the old scan at the wrong path and it returned an empty array, and an
 * empty array made every command "accounted for". A checker that cannot see
 * something has to SAY SO, because a blind gate and a satisfied gate emit the
 * identical green. Sibling precedent for the shape:
 * `declared-composition-fields.test.ts`.
 */
describe('reachability — the scan refuses rather than under-reporting', () => {
  const fixture = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ccf-scan-'))
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(dir, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, body, 'utf8')
    }
    return dir
  }
  const cleanup: string[] = []
  const tmp = (files: Record<string, string>): string => {
    const d = fixture(files)
    cleanup.push(d)
    return d
  }
  afterAll(() => {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true })
  })

  test('a root with no sources at all is a broken gate, not a clean one', () => {
    const dir = tmp({ 'README.md': '# nothing to parse' })
    expect(() => scanChatCommandFilterFactories(dir)).toThrow(ChatCommandFilterScanError)
    expect(() => scanChatCommandFilterFactories(dir)).toThrow(/scan root is wrong/)
  })

  test('sources that never mention the concept is a broken gate too', () => {
    // The rename case: the contract is called something else now, so the reader
    // recognises nothing and would otherwise report a clean, empty product.
    const dir = tmp({ 'src/thing.ts': 'export function hello(): string { return "hi" }\n' })
    expect(() => scanChatCommandFilterFactories(dir)).toThrow(/mention 'ChatCommandFilter'/)
  })

  test('an exported const filter is refused, not skipped', () => {
    const dir = tmp({
      'src/f.ts':
        'import type { ChatCommandFilter } from "./c.ts"\n' +
        'export const sneakyChatCommandFilter = { async match() { return null } }\n',
    })
    expect(() => scanChatCommandFilterFactories(dir)).toThrow(/const\/let rather than/)
  })

  test('an exported const typed as a filter is refused too', () => {
    const dir = tmp({
      'src/f.ts':
        'import type { ChatCommandFilter } from "./c.ts"\n' +
        'export const anonymous: ChatCommandFilter = { async match() { return null } }\n',
    })
    expect(() => scanChatCommandFilterFactories(dir)).toThrow(ChatCommandFilterScanError)
  })

  test('a factory is found by its RETURN TYPE when its name hides it', () => {
    // The `buildCalendarChatCommandDispatcher` shape. Under the old name-only
    // regex this was invisible under every possible search root.
    const dir = tmp({
      'src/f.ts':
        'import type { ChatCommandFilter } from "./c.ts"\n' +
        'export function makeSomething(): ChatCommandFilter { return { async match() { return null } } }\n',
    })
    expect(scanChatCommandFilterFactories(dir).map((f) => f.name)).toEqual(['makeSomething'])
  })

  test('a factory is found by its NAME under any verb', () => {
    const dir = tmp({
      'src/f.ts':
        '// ChatCommandFilter\n' +
        'export function summonWidgetChatCommandFilter(x: number) { return x }\n',
    })
    expect(scanChatCommandFilterFactories(dir).map((f) => f.name)).toEqual([
      'summonWidgetChatCommandFilter',
    ])
  })

  test('the command EXECUTORS next to every factory are not mistaken for factories', () => {
    // `executeSkillForgeCommand` returns `Promise<ChatCommandFilterResult>`. A
    // substring test on the printed return type pulls it in; the suffix rule on
    // resolved type names does not. Without this the inventory would fill with
    // names no owner can type, and an inventory nobody believes is not read.
    const dir = tmp({
      'src/f.ts':
        'import type { ChatCommandFilterResult } from "./c.ts"\n' +
        'export async function executeThing(): Promise<ChatCommandFilterResult> {\n' +
        '  return { text: "x" }\n' +
        '}\n',
    })
    expect(scanChatCommandFilterFactories(dir)).toEqual([])
  })

  test('filters that exist only in tests are not counted as product commands', () => {
    const dir = tmp({
      'src/real.ts': 'export function buildRealChatCommandFilter() { return null }\n',
      'src/__tests__/fake.ts': 'export function buildFakeChatCommandFilter() { return null }\n',
      'src/other.test.ts': 'export function buildOtherChatCommandFilter() { return null }\n',
    })
    expect(scanChatCommandFilterFactories(dir).map((f) => f.name)).toEqual([
      'buildRealChatCommandFilter',
    ])
  })
})
