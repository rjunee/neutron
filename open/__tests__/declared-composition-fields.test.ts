/**
 * Proof that the parse-only declaration reader is right, and that every shape it
 * cannot follow is REFUSED rather than under-reported.
 *
 * `declared-composition-fields.ts` supplies the DECLARED half of the
 * composition-field coverage gate. Its answer is load-bearing in a direction
 * that fails silently: if it returns FEWER fields than really exist, the missing
 * ones simply leave the gate's world — they stop being classified, stop being
 * ratcheted, and the gate goes green while a `push_dispatcher`-shaped hole sits
 * open. Nothing downstream would notice. So the reader is checked two ways here.
 *
 * 1. AGAINST THE TYPE CHECKER. `ts.createProgram` + `getPropertiesOfType` is the
 *    most authoritative answer available — it is TypeScript resolving its own
 *    type. The parser must agree with it EXACTLY, on names and on optionality.
 *    This is the test that lets the gate use the fast reader: without it, "the
 *    parse looks right" is an assertion rather than a measurement. It costs
 *    ~15 s (the checker resolves the transitive import graph), which is why the
 *    gate itself does not do this on every run — it happens once, here.
 *
 * 2. AGAINST THE SHAPES IT CANNOT READ. Each refusal path gets a fixture, so
 *    "it fails loudly" is demonstrated rather than claimed. A reader whose error
 *    branches have never executed is a reader whose error branches might be
 *    returning an empty list.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

import {
  DeclaredFieldsError,
  MIN_EXPECTED_DECLARED_FIELDS,
  readDeclaredCompositionFields,
} from './declared-composition-fields.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')

/** The full type checker's answer for `CompositionInput`: name + optionality. */
function checkerFields(root: string): { name: string; optional: boolean }[] {
  const entry = resolve(root, 'gateway/composition/input/composition-input.ts')
  const cfgPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json')
  if (cfgPath === undefined) throw new Error('no tsconfig.json at repo root')
  const cfg = ts.parseJsonConfigFileContent(
    ts.readConfigFile(cfgPath, (p) => ts.sys.readFile(p)).config as unknown,
    ts.sys,
    root,
  )
  const program = ts.createProgram([entry], {
    ...cfg.options,
    noEmit: true,
    // The gate only needs the shape of ONE interface. Skipping lib/type
    // resolution keeps this to ~15 s instead of ~30 s and cannot change the
    // answer: the members are declared right there in the 12 input files.
    noLib: true,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
    types: [],
  })
  const sf = program.getSourceFile(entry)
  if (!sf) throw new Error(`type checker could not load ${entry}`)
  let iface: ts.InterfaceDeclaration | undefined
  ts.forEachChild(sf, (n) => {
    if (ts.isInterfaceDeclaration(n) && n.name.text === 'CompositionInput') iface = n
  })
  if (!iface) throw new Error('no interface CompositionInput')
  const checker = program.getTypeChecker()
  return checker
    .getPropertiesOfType(checker.getTypeAtLocation(iface.name))
    .map((p) => ({ name: p.getName(), optional: (p.flags & ts.SymbolFlags.Optional) !== 0 }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

describe('declared-composition-fields — the parser agrees with the type checker', () => {
  test(
    'every CompositionInput field, and its optionality, matches getPropertiesOfType exactly',
    () => {
      const parsed = readDeclaredCompositionFields(REPO_ROOT).map((f) => ({
        name: f.name,
        optional: f.optional,
      }))
      const checked = checkerFields(REPO_ROOT)

      // Compared as whole arrays so a mismatch PRINTS both sides — a bare
      // length assertion would say "76 !== 75" and leave you grepping.
      expect(parsed).toEqual(checked)
      expect(parsed.length).toBeGreaterThanOrEqual(MIN_EXPECTED_DECLARED_FIELDS)
    },
    120_000,
  )

  test('declaration sites point at real lines in real files', () => {
    // The gate prints `file:line` at a reviewer when a field is unclassified.
    // A plausible-looking but wrong citation wastes the one person who was
    // going to check.
    const fields = readDeclaredCompositionFields(REPO_ROOT)
    for (const f of fields) {
      expect(f.file.startsWith('gateway/composition/input/')).toBe(true)
      expect(f.line).toBeGreaterThan(0)
      expect(readFileSync(resolve(REPO_ROOT, f.file), 'utf8').length).toBeGreaterThan(0)
    }
    // Spot-check the citation end to end: the line the reader points at must be the
    // line the field is on. The field that MOTIVATED this gate was `push_dispatcher`
    // — declared, consumed, set by no composer — and it was deleted on 2026-08-09
    // (its notification is composed at delivery now, not on the reminder tick), so
    // the sample moved to another `misc-input.ts` object field of the same shape.
    const sample = fields.find((f) => f.name === 'work_board')
    expect(sample).toBeDefined()
    const lines = readFileSync(resolve(REPO_ROOT, sample!.file), 'utf8').split('\n')
    expect(lines[sample!.line - 1]).toContain('work_board')
  })
})

describe('declared-composition-fields — refuses what it cannot read', () => {
  let dir: string | undefined

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  /** Lay out a miniature repo with the real path shape and the given sources. */
  function fixture(files: Record<string, string>): string {
    dir = mkdtempSync(join(tmpdir(), 'neutron-declared-fields-'))
    mkdirSync(join(dir, 'gateway', 'composition', 'input'), { recursive: true })
    for (const [rel, body] of Object.entries(files)) {
      writeFileSync(join(dir, 'gateway', 'composition', 'input', rel), body)
    }
    return dir
  }

  /** A sub-interface with enough fields to clear the floor. */
  function bulkInterface(name: string, n: number): string {
    const members = Array.from({ length: n }, (_, i) => `  field_${i}?: string`).join('\n')
    return `export interface ${name} {\n${members}\n}\n`
  }

  const BULK = MIN_EXPECTED_DECLARED_FIELDS + 5

  test('a healthy fixture reads clean — the refusals below are not just "any fixture fails"', () => {
    const root = fixture({
      'a-input.ts': bulkInterface('AInput', BULK),
      'composition-input.ts':
        `import type { AInput } from './a-input.ts'\n` +
        `export interface CompositionInput extends AInput { own_field: number }\n`,
    })
    const fields = readDeclaredCompositionFields(root)
    expect(fields.length).toBe(BULK + 1)
    expect(fields.find((f) => f.name === 'own_field')?.optional).toBe(false)
    expect(fields.find((f) => f.name === 'field_0')?.optional).toBe(true)
  })

  test('a renamed or moved CompositionInput is a broken gate, not a clean sweep', () => {
    const root = fixture({ 'composition-input.ts': `export interface SomethingElse { a?: string }\n` })
    expect(() => readDeclaredCompositionFields(root)).toThrow(DeclaredFieldsError)
    expect(() => readDeclaredCompositionFields(root)).toThrow(/no 'interface CompositionInput'/)
  })

  test('a generic/utility type in the extends chain is refused, not silently skipped', () => {
    // `extends Pick<AInput, 'x'>` resolves to fields this reader cannot
    // enumerate. Skipping it would drop them from the gate with no signal.
    const root = fixture({
      'a-input.ts': bulkInterface('AInput', BULK),
      'composition-input.ts':
        `import type { AInput } from './a-input.ts'\n` +
        `export interface CompositionInput extends Pick<AInput, 'field_0'> {}\n`,
    })
    expect(() => readDeclaredCompositionFields(root)).toThrow(/generic type/)
  })

  test('an index signature is refused — the gate keys on names and has none to key on', () => {
    const root = fixture({
      'a-input.ts': `export interface AInput {\n  [k: string]: unknown\n}\n`,
      'composition-input.ts':
        `import type { AInput } from './a-input.ts'\n` +
        `export interface CompositionInput extends AInput {}\n`,
    })
    expect(() => readDeclaredCompositionFields(root)).toThrow(/not a plain property/)
  })

  test('a sub-interface arriving from a package is refused, not dropped', () => {
    const root = fixture({
      'composition-input.ts':
        `import type { AInput } from '@somewhere/else'\n` +
        `export interface CompositionInput extends AInput {}\n`,
    })
    expect(() => readDeclaredCompositionFields(root)).toThrow(/non-relative specifier/)
  })

  test('an extends name with no import at all is refused', () => {
    const root = fixture({ 'composition-input.ts': `export interface CompositionInput extends AInput {}\n` })
    expect(() => readDeclaredCompositionFields(root)).toThrow(/no relative import/)
  })

  test('a nested extends chain is refused — one level is all this reader flattens', () => {
    const root = fixture({
      'b-input.ts': bulkInterface('BInput', BULK),
      'a-input.ts': `import type { BInput } from './b-input.ts'\nexport interface AInput extends BInput { a?: string }\n`,
      'composition-input.ts':
        `import type { AInput } from './a-input.ts'\n` +
        `export interface CompositionInput extends AInput {}\n`,
    })
    expect(() => readDeclaredCompositionFields(root)).toThrow(/itself\s+extends something/)
  })

  test('a duplicated field name is refused', () => {
    const root = fixture({
      'a-input.ts': bulkInterface('AInput', BULK),
      'b-input.ts': `export interface BInput {\n  field_0?: string\n}\n`,
      'composition-input.ts':
        `import type { AInput } from './a-input.ts'\n` +
        `import type { BInput } from './b-input.ts'\n` +
        `export interface CompositionInput extends AInput, BInput {}\n`,
    })
    expect(() => readDeclaredCompositionFields(root)).toThrow(/declared twice/)
  })

  test('a declared set below the floor fails rather than reading as "all wired"', () => {
    // This is the shape that would be MOST dangerous if it passed: three fields
    // read, three fields classified, gate green, and the other seventy-odd gone.
    const root = fixture({
      'a-input.ts': bulkInterface('AInput', 3),
      'composition-input.ts':
        `import type { AInput } from './a-input.ts'\n` +
        `export interface CompositionInput extends AInput {}\n`,
    })
    expect(() => readDeclaredCompositionFields(root)).toThrow(/below the floor/)
  })
})
