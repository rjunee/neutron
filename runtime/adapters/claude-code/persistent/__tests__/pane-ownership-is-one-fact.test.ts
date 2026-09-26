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
 *
 * WHAT IT DOES NOT COVER, stated rather than left to be discovered. The scan is this
 * directory's non-test modules. Two exclusions are deliberate and one is a bound:
 *
 *   - TEST FILES write these fields constantly and must — a fixture builds rows by hand,
 *     and banning that would leave the suite unable to construct the states it checks;
 *   - the FUNNEL itself, obviously, which the second case pins;
 *   - and code OUTSIDE this directory is not scanned. Nothing out there writes them today
 *     (checked: a repo-wide grep for these keys returns only this directory and its
 *     tests), and nothing outside can reasonably want to — a writer would have to import
 *     `ReplRegistryRecord` and reach past four exported transitions to do it. If that ever
 *     changes, the scan root is one constant.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { disownPane, type ReplRegistryRecord } from '../repl-registry.ts'
import { dropLocalOwnership, isHeldLocally, noteLocalOwnership } from '../local-ownership.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SUBSYSTEM = join(HERE, '..')

/** The one module allowed to write these fields. */
const FUNNEL = 'repl-registry.ts'

const FIELDS = [
  'pane_handle',
  'adoption_claim_at',
  'adoption_claim_by',
  'adoption_claim_pid',
  // r47 — the spawn reservation is the same kind of fact (who may touch this transcript) and
  // is written through the same funnel, so it is covered by the same check rather than by a
  // second one nobody would remember to extend.
  'spawn_reservation_at',
  'spawn_reservation_by',
  'spawn_reservation_pid',
]

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

/** Treat transition calls as writes unless their copies only feed a pure comparison. */
const TRANSITIONS = [
  'ownPane',
  'disownPane',
  'handOverPane',
  'refreshPaneClaim',
  'reservePaneSpawn',
  'releasePaneSpawnReservation',
]

/** Only direct, unshadowed imports comparing two disowned identifier operands qualify.
 * Mask the callee names, not the line: another transition on that line must still fail.
 * Assignments, nested calls and other argument expressions never qualify. */
function maskPureOwnershipComparisons(source: string): string {
  const ast = ts.createSourceFile('ownership-scan.ts', source, ts.ScriptTarget.Latest, true)
  const imports = new Map([['isDeepStrictEqual', 'node:util'], ['disownPane', './repl-registry.ts']])
  const found = new Set<string>()
  let ambiguous = false
  const masks: [number, number][] = []
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && imports.has(node.text)) {
      const parent = node.parent
      if (ts.isImportSpecifier(parent) && parent.name === node && parent.propertyName === undefined) {
        const declaration = parent.parent.parent.parent
        if (ts.isImportDeclaration(declaration) && ts.isStringLiteral(declaration.moduleSpecifier) &&
            declaration.moduleSpecifier.text === imports.get(node.text) &&
            !parent.isTypeOnly && !declaration.importClause?.isTypeOnly) found.add(node.text)
        else ambiguous = true
      } else if (!(ts.isCallExpression(parent) && parent.expression === node)) {
        // Includes shadowing parameters/declarations and reassignment of either import.
        ambiguous = true
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === 'isDeepStrictEqual' && !node.questionDotToken && node.arguments.length === 2) {
      const operands = node.arguments
      if (operands.every(arg => ts.isCallExpression(arg) && ts.isIdentifier(arg.expression) &&
          arg.expression.text === 'disownPane' && !arg.questionDotToken && arg.arguments.length === 1 &&
          ts.isIdentifier(arg.arguments[0]!))) {
        for (const arg of operands) {
          const callee = (arg as ts.CallExpression).expression
          masks.push([callee.getStart(ast), callee.end])
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (ambiguous || found.size !== imports.size) return source
  for (const [start, end] of masks.sort((a, b) => b[0] - a[0])) {
    source = source.slice(0, start) + ' '.repeat(end - start) + source.slice(end)
  }
  return source
}

/**
 * Which registry entry point encloses each transition CALL — found by walking back to the
 * nearest preceding `with…Registry(` in the file. Entry-point tracking remains a lexical
 * heuristic; the AST above only identifies the narrowly allowed pure comparison operands.
 */
function transitionsNotUnderTheOwnedEntryPoint(source: string): string[] {
  const lines = maskPureOwnershipComparisons(source).split('\n')
  const originalLines = source.split('\n')
  const bad: string[] = []
  let enclosing: 'owned' | 'plain' | 'none' = 'none'
  for (const [i, rawLine] of lines.entries()) {
    const line = rawLine.trim()
    if (line.startsWith('*') || line.startsWith('//')) continue
    if (line.includes('withOwnedRegistry(')) enclosing = 'owned'
    else if (line.includes('withRegistry(')) enclosing = 'plain'
    for (const t of TRANSITIONS) {
      // A CALL, not an import or a type reference.
      if (!new RegExp(`\\b${t}\\s*\\(`).test(line)) continue
      if (enclosing !== 'owned') bad.push(`${i + 1}: ${originalLines[i]!.trim().slice(0, 100)}`)
    }
  }
  return bad
}

describe('an ownership write goes through the entry point that consumes the lock outcome', () => {
  const comparisonImports = "import { isDeepStrictEqual } from 'node:util'\nimport { disownPane } from './repl-registry.ts'\n"
  const comparison = 'isDeepStrictEqual(disownPane(row), disownPane(before))'

  it('permits pure normalization in the real recovery consumer and still detects an adjacent write', () => {
    const source = readFileSync(join(SUBSYSTEM, 'startup-recovery.ts'), 'utf8')
    expect(source).toContain(comparison)
    expect(transitionsNotUnderTheOwnedEntryPoint(source)).toEqual([])
    const mutated = source.replace(comparison, `(${comparison}, registry[key] = disownPane(row))`)
    expect(transitionsNotUnderTheOwnedEntryPoint(mutated)).toHaveLength(1)
  })

  it('permits the comparison outside a write or under either registry entry point', () => {
    for (const prefix of ['', 'withRegistry(path, registry => {\n', 'withOwnedRegistry(path, registry => {\n']) {
      expect(transitionsNotUnderTheOwnedEntryPoint(comparisonImports + prefix + comparison)).toEqual([])
    }
  })

  it('rejects assignments, nested transitions, adjacent writes and shadowed comparators', () => {
    for (const expression of [
      'isDeepStrictEqual(disownPane(registry[key] = row), disownPane(before))',
      'isDeepStrictEqual(registry[key] = disownPane(row), disownPane(before))',
      'isDeepStrictEqual(disownPane(ownPane(row, owner)), disownPane(before))',
      `${comparison}; registry[key] = disownPane(row)`,
      `${comparison}; registry[key] = disownPane (row)`,
      `function check(isDeepStrictEqual) { return ${comparison} }`,
      `function check(disownPane) { return ${comparison} }`,
    ]) {
      expect(transitionsNotUnderTheOwnedEntryPoint(comparisonImports + expression).length).toBeGreaterThan(0)
    }
    expect(transitionsNotUnderTheOwnedEntryPoint(comparisonImports.replace('node:util', './custom.ts') + comparison).length).toBeGreaterThan(0)
  })

  it('requires the owned entry point for every transition that supplies a row', () => {
    for (const transition of TRANSITIONS) {
      const write = `registry[key] = ${transition}(row)`
      expect(transitionsNotUnderTheOwnedEntryPoint(write)).toHaveLength(1)
      expect(transitionsNotUnderTheOwnedEntryPoint(`withRegistry(path, registry => {\n${write}`)).toHaveLength(1)
      expect(transitionsNotUnderTheOwnedEntryPoint(`withOwnedRegistry(path, registry => {\n${write}`)).toEqual([])
    }
  })

  it('disown normalization preserves the input and retains non-ownership differences', () => {
    const base = { sessionId: 'conversation', sessionKey: 'key', cwd: '/project', channelName: 'channel', has_session: true }
    const row: ReplRegistryRecord = Object.freeze({ ...base, pane_handle: 'pane', adoption_claim_by: 'guard-purity-owner', adoption_claim_at: 1, adoption_claim_pid: 123 })
    const before = structuredClone(row)
    noteLocalOwnership(row.adoption_claim_by)
    try {
      expect(isHeldLocally(row.adoption_claim_by)).toBe(true)
      expect(disownPane(row)).toEqual(base)
      expect(disownPane(row)).not.toBe(row)
      expect(row).toEqual(before)
      expect(isHeldLocally(row.adoption_claim_by)).toBe(true)
      expect(disownPane({ ...row, sessionId: 'replacement' })).not.toEqual(disownPane(row))
    } finally {
      dropLocalOwnership(row.adoption_claim_by)
    }
  })

  it('ownership writes require withOwnedRegistry', () => {
    // ARGUS r41. `withFlockSync` runs its callback even when `flock` FAILS and
    // `withRegistry` saves what it returns, so an ownership write that does not consume
    // the acquisition outcome rewrites the whole registry from a snapshot nobody had the
    // right to read — dropping a concurrent gateway's rows. Four sites had needed that
    // rule already; the two round forty ADDED shipped without it, written after the rule
    // existed by someone who knew it.
    //
    // `withOwnedRegistry` makes the failure disposition a REQUIRED parameter, and this
    // case makes reaching for the wrong entry point visible at the call site instead of
    // invisible by omission — which is the difference between a mechanism and a rule.
    const offenders: Record<string, string[]> = {}
    for (const name of readdirSync(SUBSYSTEM)) {
      if (!name.endsWith('.ts') || name === FUNNEL) continue
      const bad = transitionsNotUnderTheOwnedEntryPoint(readFileSync(join(SUBSYSTEM, name), 'utf8'))
      if (bad.length > 0) offenders[name] = bad
    }
    expect(offenders).toEqual({})
  })

  it('...and transitions ARE called out there, so the check is not vacuous', () => {
    // The positive control: if every transition call moved into the funnel, or a rename
    // made the names stop matching, the case above would pass while checking nothing.
    let found = 0
    for (const name of readdirSync(SUBSYSTEM)) {
      if (!name.endsWith('.ts') || name === FUNNEL) continue
      const src = readFileSync(join(SUBSYSTEM, name), 'utf8')
      for (const t of TRANSITIONS) if (new RegExp(`\\b${t}\\(`).test(src)) found += 1
    }
    expect(found).toBeGreaterThanOrEqual(4)
  })
})

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
