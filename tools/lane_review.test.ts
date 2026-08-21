// tools/lane_review.test.ts — pins the FAIL-CLOSED contract of lane_review.sh.
//
// THE DEFECT THIS PINS (measured 2026-08-18T08:13Z): handed a ref it could not
// resolve, the guard printed `lane_review: unknown ref <ref>` and exited 0.
// Empty output from a guard reads exactly like a clean verdict — three PRs
// (#424 #420 #411) were nearly merged on that silence. "Nothing to check" and
// "checked, all wired" must never look identical, so this suite asserts the
// unknown-ref path DIRECTLY: deleting the fail-closed exit in lane_review.sh
// turns the first test red. A suite that only exercised resolvable refs would
// pass with the hole present and prove nothing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./lane_review.sh', import.meta.url))

let repo: string
let analyzerlessScriptDirectory: string

// Isolate every git invocation from host config (gpg signing, hook paths).
const env = () => ({
  ...process.env,
  HOME: repo,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'lane-review-test',
  GIT_AUTHOR_EMAIL: 'lane-review-test@invalid',
  GIT_COMMITTER_NAME: 'lane-review-test',
  GIT_COMMITTER_EMAIL: 'lane-review-test@invalid',
})

function git(...args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: env() })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stderr}`)
  return r.stdout.trim()
}

function review(...args: string[]): { code: number | null; out: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8', env: env() })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

function reviewFrom(directory: string, ...args: string[]): { code: number | null; out: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    cwd: join(repo, directory),
    encoding: 'utf8',
    env: env(),
  })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

function reviewWithoutAnalyzer(...args: string[]): { code: number | null; out: string } {
  const r = spawnSync('bash', [join(analyzerlessScriptDirectory, 'lane_review.sh'), ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: env(),
  })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

function fixtureBranch(name: string, files: Record<string, string>): void {
  git('checkout', '-q', '-b', name)
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(join(repo, file, '..'), { recursive: true })
    writeFileSync(join(repo, file), source)
  }
  git('add', '-A')
  git('commit', '-q', '-m', `fixture: ${name}`)
  git('checkout', '-q', 'main')
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'lane-review-'))
  analyzerlessScriptDirectory = mkdtempSync(join(tmpdir(), 'lane-review-no-analyzer-'))
  copyFileSync(SCRIPT, join(analyzerlessScriptDirectory, 'lane_review.sh'))
  git('init', '-q', '-b', 'main')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(
    join(repo, 'src', 'app.ts'),
    'export function used(): number {\n  return 1\n}\nconsole.log(used())\n',
  )
  writeFileSync(
    join(repo, 'src', 'star-source.ts'),
    'export function starOnly(): number { return 1 }\n',
  )
  writeFileSync(
    join(repo, 'src', 'existing-route.ts'),
    'export function existingRoute(): number { return 1 }\n',
  )
  writeFileSync(
    join(repo, 'src', 'existing-route-caller.ts'),
    "import { existingRoute } from './existing-route.ts'\nconsole.log(existingRoute())\n",
  )
  writeFileSync(
    join(repo, 'src', 'existing-default.ts'),
    'function alreadyUsed(): number { return 1 }\nconsole.log(alreadyUsed())\n',
  )
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  // The script's default base is origin/main; model it without a network remote.
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')

  // Known-good branch: edits an existing production code path, adds no exports.
  git('checkout', '-q', '-b', 'feature')
  writeFileSync(
    join(repo, 'src', 'app.ts'),
    'export function used(): number {\n  return 2 // behaviour change\n}\nconsole.log(used())\n',
  )
  git('add', '-A')
  git('commit', '-q', '-m', 'edit an existing production path')
  git('checkout', '-q', 'main')

  fixtureBranch('shadowed-binding', {
    'src/new-shadowed.ts': 'export function duplicatedName(): number { return 1 }\n',
    'src/unrelated.ts': [
      'function duplicatedName(): number { return 2 }',
      'console.log(duplicatedName())',
      '',
    ].join('\n'),
  })

  fixtureBranch('module-extensions', {
    'src/orphan.cts': 'export function orphanCts(): number { return 1 }\n',
    'src/orphan.mts': 'export function orphanMts(): number { return 1 }\n',
  })

  fixtureBranch('export-star-only', {
    'src/star-barrel.ts': "export * from './star-source.ts'\n",
  })

  fixtureBranch('aliased-reexport-only', {
    'src/aliased-barrel.ts': "export { starOnly as publicStar } from './star-source.ts'\n",
  })

  fixtureBranch('wired-extends', {
    'src/new-base.ts': 'export class NewBase {}\n',
    'src/subclass.ts': [
      "import { NewBase } from './new-base.ts'",
      'class Subclass extends NewBase {}',
      'new Subclass()',
      '',
    ].join('\n'),
  })

  fixtureBranch('wired-namespace', {
    'src/namespace-export.ts': 'export function namespaceFunction(): number { return 1 }\n',
    'src/namespace-caller.ts': [
      "import * as functions from './namespace-export.ts'",
      'console.log(functions.namespaceFunction())',
      '',
    ].join('\n'),
  })

  fixtureBranch('wired-aliases', {
    'src/alias-exports.ts': [
      'function localFunction(): number { return 1 }',
      'export { localFunction as publicFunction }',
      'export default function realDefault(): number { return 2 }',
      '',
    ].join('\n'),
    'src/alias-caller.ts': [
      "import renamedDefault, { publicFunction as invoked } from './alias-exports.ts'",
      'console.log(invoked(), renamedDefault())',
      '',
    ].join('\n'),
  })

  fixtureBranch('wired-plain-barrel', {
    'src/barrel-api.ts': 'export function viaPlainBarrel(): number { return 1 }\n',
    'src/barrel-middle.ts': "export * from './barrel-api.ts'\n",
    'src/barrel-public.ts': "export * from './barrel-middle.ts'\n",
    'src/barrel-caller.ts': [
      "import { viaPlainBarrel } from './barrel-public.ts'",
      'console.log(viaPlainBarrel())',
      '',
    ].join('\n'),
  })

  fixtureBranch('wired-workspace-barrel', {
    'package.json': JSON.stringify({ private: true, workspaces: ['packages/*'] }),
    'packages/library/package.json': JSON.stringify({
      name: '@acme/library',
      main: './index.ts',
    }),
    'packages/library/api.ts': 'export function originalWorkspace(): number { return 1 }\n',
    'packages/library/direct.ts': 'export function viaWorkspaceSubpath(): number { return 2 }\n',
    'packages/library/internal.ts': "export { originalWorkspace as viaWorkspace } from './api.ts'\n",
    'packages/library/index.ts': "export { viaWorkspace } from './internal.ts'\n",
    'src/workspace-caller.ts': [
      "import { viaWorkspace } from '@acme/library'",
      "import { viaWorkspaceSubpath } from '@acme/library/direct.ts'",
      'console.log(viaWorkspace(), viaWorkspaceSubpath())',
      '',
    ].join('\n'),
  })

  fixtureBranch('wired-dynamic-import', {
    'src/dynamic-api.ts': 'export function dynamicallyCalled(): number { return 1 }\n',
    'src/dynamic-caller.ts': [
      'async function run(): Promise<number> {',
      "  const { dynamicallyCalled: invoke } = await import('./dynamic-api.ts')",
      '  return invoke()',
      '}',
      'void run()',
      '',
    ].join('\n'),
  })

  fixtureBranch('wired-commonjs-require', {
    'src/require-api.cts': 'export function requiredApi(): number { return 1 }\n',
    'src/require-caller.cjs': [
      "const { requiredApi: invoke } = require('./require-api.cts')",
      'console.log(invoke())',
      '',
    ].join('\n'),
  })

  fixtureBranch('shadowed-commonjs-require', {
    'src/shadowed-require-api.cts': 'export function shadowedRequireApi(): number { return 1 }\n',
    'src/shadowed-require-caller.cjs': [
      'function require() { return { shadowedRequireApi: () => 2 } }',
      "const { shadowedRequireApi } = require('./shadowed-require-api.cts')",
      'console.log(shadowedRequireApi())',
      '',
    ].join('\n'),
  })

  fixtureBranch('nested-test-only', {
    'pkg/tests/helper.ts': 'export function testHelper(): number { return 1 }\n',
  })

  fixtureBranch('self-contained-exports', {
    'src/self-contained.ts': [
      'export function alpha(): number { return beta() }',
      'export function beta(): number { return alpha() }',
      'export class Widget { static make(): Widget { return new Widget() } }',
      '',
    ].join('\n'),
  })

  fixtureBranch('wired-definition-chain', {
    'src/chained-api.ts': [
      'export function chainedHelper(): number { return 1 }',
      'export function chainedEntry(): number { return chainedHelper() }',
      '',
    ].join('\n'),
    'src/chained-caller.ts': [
      "import { chainedEntry } from './chained-api.ts'",
      'console.log(chainedEntry())',
      '',
    ].join('\n'),
  })

  fixtureBranch('new-alias-route', {
    'src/existing-route.ts': [
      'export function existingRoute(): number { return 1 }',
      'export { existingRoute as newlyExposed }',
      '',
    ].join('\n'),
  })

  fixtureBranch('commonjs-default', {
    'src/plugin.cjs': 'module.exports = function newPlugin() { return 1 }\n',
  })

  fixtureBranch('namespace-destructure', {
    'src/destructure-api.ts': 'export function throughDestructure(): number { return 1 }\n',
    'src/destructure-caller.ts': [
      "import * as api from './destructure-api.ts'",
      'const { throughDestructure } = api',
      'console.log(throughDestructure())',
      '',
    ].join('\n'),
  })

  fixtureBranch('ambient-only', {
    'src/ambient.ts': 'export declare function ambientOnly(): number\n',
  })

  fixtureBranch('docs-caller', {
    'src/docs-orphan.ts': 'export function calledOnlyFromDocs(): number { return 1 }\n',
    'docs/research/prototype.mjs': [
      "import { calledOnlyFromDocs } from '../../src/docs-orphan.ts'",
      'console.log(calledOnlyFromDocs())',
      '',
    ].join('\n'),
  })

  fixtureBranch('commonjs-publication', {
    'src/publication.cjs': [
      'function publicationOnly() { return 1 }',
      'module.exports.publicationOnly = publicationOnly',
      '',
    ].join('\n'),
  })

  fixtureBranch('default-existing-use', {
    'src/existing-default.ts': [
      'function alreadyUsed(): number { return 1 }',
      'console.log(alreadyUsed())',
      'export default alreadyUsed',
      '',
    ].join('\n'),
  })

  // Unwired branch: adds an exported symbol with ZERO production callers —
  // the class this tool exists to catch (#400).
  git('checkout', '-q', '-b', 'unwired')
  writeFileSync(
    join(repo, 'src', 'orphan.ts'),
    'export function orphanNeverCalled(): number {\n  return 3\n}\n',
  )
  git('add', '-A')
  git('commit', '-q', '-m', 'add an export nothing calls')
  git('checkout', '-q', 'main')

  // Every runtime export form below used to evade the line regex, turning an
  // unwired branch into the affirmatively false "nothing to verify" verdict.
  git('checkout', '-q', '-b', 'export-forms')
  writeFileSync(
    join(repo, 'src', 'default.ts'),
    'export default function orphanDefault(): number {\n  return 1\n}\n',
  )
  writeFileSync(
    join(repo, 'src', 'forms.ts'),
    [
      'export abstract class AbstractOrphan { abstract run(): void }',
      'export enum OrphanEnum { Value }',
      'export let orphanLet = 1',
      'export async function* orphanGenerator() { yield 1 }',
      'function orphanExportList(): number { return 1 }',
      'export { orphanExportList }',
      '',
    ].join('\n'),
  )
  git('add', '-A')
  git('commit', '-q', '-m', 'add unwired exports in common forms')
  git('checkout', '-q', 'main')

  // An anonymous default has no local name, but its public `default` binding
  // can still be followed through a default import. Unused remains unwired.
  git('checkout', '-q', '-b', 'anonymous-default')
  writeFileSync(join(repo, 'src', 'anonymous.ts'), 'export default () => 1\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'add anonymous default export')
  git('checkout', '-q', 'main')

  // Path transport must remain byte-safe. `git diff --name-only` C-quotes the
  // second path by default, while an unquoted shell expansion splits the first.
  git('checkout', '-q', '-b', 'unusual-paths')
  writeFileSync(
    join(repo, 'src', 'orphan file.ts'),
    'export function orphanInSpacedFile(): number { return 1 }\n',
  )
  writeFileSync(
    join(repo, 'src', 'café.ts'),
    'export function orphanInUnicodeFile(): number { return 1 }\n',
  )
  git('add', '-A')
  git('commit', '-q', '-m', 'add unwired exports under unusual paths')
  git('checkout', '-q', 'main')

  // Text mentions are not callers. Neither the comment nor the string below
  // is a runtime identifier reference.
  git('checkout', '-q', '-b', 'comment-only')
  writeFileSync(
    join(repo, 'src', 'comment-orphan.ts'),
    'export function mentionedOnlyInProse(): number { return 1 }\n',
  )
  writeFileSync(
    join(repo, 'src', 'prose.ts'),
    [
      '// mentionedOnlyInProse is deliberately not invoked',
      "const description = 'mentionedOnlyInProse is not a caller'",
      'void description',
      '',
    ].join('\n'),
  )
  git('add', '-A')
  git('commit', '-q', '-m', 'mention an unwired export only in prose')
  git('checkout', '-q', 'main')

  // A local barrel export is metadata, not product reachability.
  git('checkout', '-q', '-b', 'reexport-only')
  writeFileSync(
    join(repo, 'src', 'thing.ts'),
    'export function barrelOrphan(): number { return 1 }\n',
  )
  writeFileSync(
    join(repo, 'src', 'barrel.ts'),
    "import { barrelOrphan } from './thing.ts'\nexport { barrelOrphan }\n",
  )
  git('add', '-A')
  git('commit', '-q', '-m', 're-export without a runtime caller')
  git('checkout', '-q', 'main')

  // Positive caller control for the syntax-aware search.
  git('checkout', '-q', '-b', 'wired-export')
  writeFileSync(
    join(repo, 'src', 'wired.ts'),
    [
      'export function newlyWired(): number { return 1 }',
      'const result = newlyWired()',
      'void result',
      '',
    ].join('\n'),
  )
  git('add', '-A')
  git('commit', '-q', '-m', 'add a called export')
  git('checkout', '-q', 'main')

  // The ref shape callers actually hold: a branch that exists ONLY as a
  // remote-tracking ref, with no local branch of that name (#424 #420 #411).
  git('update-ref', 'refs/remotes/origin/trident/only-remote', git('rev-parse', 'feature'))
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(analyzerlessScriptDirectory, { recursive: true, force: true })
})

describe('lane_review.sh fail-closed contract', () => {
  test('T1: an unresolvable ref exits NON-ZERO and names the ref — silence is never approval', () => {
    const { code, out } = review('no-such-branch')
    // The defect: this exited 0. Deleting the fail-closed exit turns this red.
    expect(code).not.toBe(0)
    expect(code).toBe(2) // documented contract: 2 = the check itself could not run
    expect(out).toContain('no-such-branch')
    expect(out).toContain('could not be resolved')
    expect(out).not.toContain('delivers behaviour: yes')
  })

  test('T1: an unresolvable BASE also exits non-zero', () => {
    const { code, out } = review('feature', 'no-such-base')
    expect(code).toBe(2)
    expect(out).toContain('no-such-base')
    expect(out).toContain('could not be resolved')
  })

  test('T4 positive control: a behaviour-changing branch exits 0 with its verdict line', () => {
    const { code, out } = review('feature')
    expect(code).toBe(0)
    expect(out).toContain('=== delivers behaviour: yes')
  })

  test('T3: an empty new-symbol set is STATED in words, not implied by empty output', () => {
    const { out } = review('feature')
    expect(out).toContain('no new exported symbols — nothing to verify')
  })

  test('T2: a bare lane ref resolves against origin/ and the output names the resolution', () => {
    const { code, out } = review('trident/only-remote')
    expect(code).toBe(0)
    expect(out).toContain("resolved 'trident/only-remote' -> 'origin/trident/only-remote'")
    expect(out).toContain('=== delivers behaviour: yes')
  })

  test('positive control: the unwired class still fires — a caller-less export exits 1, named', () => {
    const { code, out } = review('unwired')
    expect(code).toBe(1)
    expect(out).toContain('orphanNeverCalled')
    expect(out).toContain('NO non-test production caller')
  })

  test('an analyzer launch failure exits 2 instead of masquerading as findings', () => {
    const { code, out } = reviewWithoutAnalyzer('unwired')
    expect(code).toBe(2)
    expect(out).toContain('bound production-caller analysis failed')
    expect(out).toContain('refusing to answer')
    expect(out).not.toContain('delivers behaviour: yes')
  })

  test('a nested tests/ directory is classified as test-only by the shell and analyzer', () => {
    const { code, out } = review('nested-test-only')
    expect(code).toBe(1)
    expect(out).toContain('FINDING: TEST-ONLY')
    expect(out).not.toContain('delivers behaviour: yes')
    expect(out).not.toContain('no new exported symbols')
  })

  test('all common runtime export forms are extracted and fail when unwired', () => {
    const { code, out } = review('export-forms')
    expect(code).toBe(1)
    for (const symbol of [
      'orphanDefault',
      'AbstractOrphan',
      'OrphanEnum',
      'orphanLet',
      'orphanGenerator',
      'orphanExportList',
    ]) {
      expect(out).toContain(`FINDING: ${symbol} has NO non-test production caller`)
    }
    expect(out).not.toContain('no new exported symbols')
  })

  test('an anonymous default export is reported as unwired instead of disappearing', () => {
    const { code, out } = review('anonymous-default')
    expect(code).toBe(1)
    expect(out).toContain('FINDING: default has NO non-test production caller')
    expect(out).not.toContain('delivers behaviour: yes')
  })

  test('spaces and non-ASCII path names cannot erase exported symbols', () => {
    const { code, out } = review('unusual-paths')
    expect(code).toBe(1)
    expect(out).toContain('FINDING: orphanInSpacedFile')
    expect(out).toContain('FINDING: orphanInUnicodeFile')
    expect(out).not.toContain('no new exported symbols')
  })

  test('running from a subdirectory analyzes the full repository tree', () => {
    const { code, out } = reviewFrom('src', 'unwired')
    expect(code).toBe(1)
    expect(out).toContain('FINDING: orphanNeverCalled')
    expect(out).not.toContain('no new exported symbols')
  })

  test('.mts and .cts production exports cannot disappear', () => {
    const { code, out } = review('module-extensions')
    expect(code).toBe(1)
    expect(out).toContain('FINDING: orphanMts')
    expect(out).toContain('FINDING: orphanCts')
  })

  test('export-star additions remain visible and are not callers', () => {
    const { code, out } = review('export-star-only')
    expect(code).toBe(1)
    expect(out).toContain('FINDING: starOnly')
    expect(out).not.toContain('ok: starOnly')
  })

  test('an aliased re-export is metadata, not a production caller', () => {
    const { code, out } = review('aliased-reexport-only')
    expect(code).toBe(1)
    expect(out).toContain('FINDING: publicStar')
    expect(out).not.toContain('ok: publicStar')
  })

  test('an unrelated same-named local does not satisfy a new export', () => {
    const { code, out } = review('shadowed-binding')
    expect(code).toBe(1)
    expect(out).toContain('FINDING: duplicatedName')
    expect(out).not.toContain('ok: duplicatedName')
  })

  test('a class heritage expression is a runtime caller', () => {
    const { code, out } = review('wired-extends')
    expect(code).toBe(0)
    expect(out).toContain('ok: NewBase called by src/subclass.ts')
  })

  test('a namespace-import property use is bound to its export', () => {
    const { code, out } = review('wired-namespace')
    expect(code).toBe(0)
    expect(out).toContain('ok: namespaceFunction called by src/namespace-caller.ts')
  })

  test('aliased named and renamed default imports retain their bindings', () => {
    const { code, out } = review('wired-aliases')
    expect(code).toBe(0)
    expect(out).toContain('ok: publicFunction called by src/alias-caller.ts')
    expect(out).toContain('ok: realDefault called by src/alias-caller.ts')
  })

  test('callers through multiple plain export-star barrels retain their bindings', () => {
    const { code, out } = review('wired-plain-barrel')
    expect(code).toBe(0)
    expect(out).toContain('ok: viaPlainBarrel called by src/barrel-caller.ts')
    expect(out).not.toContain('FINDING: viaPlainBarrel')
  })

  test('workspace package specifiers resolve through package barrels', () => {
    const { code, out } = review('wired-workspace-barrel')
    expect(code).toBe(0)
    expect(out).toContain('ok: viaWorkspace called by src/workspace-caller.ts')
    expect(out).toContain('ok: viaWorkspaceSubpath called by src/workspace-caller.ts')
    expect(out).not.toContain('FINDING: viaWorkspace')
  })

  test('dynamic import destructuring is a production caller', () => {
    const { code, out } = review('wired-dynamic-import')
    expect(code).toBe(0)
    expect(out).toContain('ok: dynamicallyCalled called by src/dynamic-caller.ts')
  })

  test('CommonJS require destructuring in .cjs is a production caller', () => {
    const { code, out } = review('wired-commonjs-require')
    expect(code).toBe(0)
    expect(out).toContain('ok: requiredApi called by src/require-caller.cjs')
  })

  test('a locally shadowed require function cannot manufacture a caller', () => {
    const { code, out } = review('shadowed-commonjs-require')
    expect(code).toBe(1)
    expect(out).toContain('FINDING: shadowedRequireApi has NO non-test production caller')
    expect(out).not.toContain('ok: shadowedRequireApi')
  })

  test('self and mutual references inside new definitions are not product reachability', () => {
    const { code, out } = review('self-contained-exports')
    expect(code).toBe(1)
    expect(out).toContain('FINDING: alpha')
    expect(out).toContain('FINDING: beta')
    expect(out).toContain('FINDING: Widget')
    expect(out).not.toContain('ok:')
  })

  test('a proven-wired new entry point also wires the new helper it calls', () => {
    const { code, out } = review('wired-definition-chain')
    expect(code).toBe(0)
    expect(out).toContain('ok: chainedEntry called by src/chained-caller.ts')
    expect(out).toContain('ok: chainedHelper called by src/chained-api.ts')
    expect(out).not.toContain('FINDING: chainedHelper')
  })

  test('a new alias route cannot inherit callers of the existing route', () => {
    const { code, out } = review('new-alias-route')
    expect(code).toBe(1)
    expect(out).toContain('FINDING: newlyExposed has NO non-test production caller')
    expect(out).not.toContain('ok: newlyExposed')
  })

  test('a CommonJS module.exports default is a runtime export', () => {
    const { code, out } = review('commonjs-default')
    expect(code).toBe(1)
    expect(out).toContain('FINDING: default has NO non-test production caller')
    expect(out).not.toContain('no new exported symbols')
  })

  test('destructuring a namespace import retains the exported route', () => {
    const { code, out } = review('namespace-destructure')
    expect(code).toBe(0)
    expect(out).toContain('ok: throughDestructure called by src/destructure-caller.ts')
  })

  test('ambient declarations are not reported as runtime exports', () => {
    const { code, out } = review('ambient-only')
    expect(code).toBe(0)
    expect(out).toContain('no new exported symbols — nothing to verify')
    expect(out).not.toContain('ambientOnly has NO non-test production caller')
  })

  test('a docs prototype cannot manufacture a production caller', () => {
    const { code, out } = review('docs-caller')
    expect(code).toBe(1)
    expect(out).toContain('FINDING: calledOnlyFromDocs has NO non-test production caller')
    expect(out).not.toContain('ok: calledOnlyFromDocs')
  })

  test('publishing a CommonJS named export is not its own caller', () => {
    const { code, out } = review('commonjs-publication')
    expect(code).toBe(1)
    expect(out).toContain('FINDING: publicationOnly has NO non-test production caller')
    expect(out).not.toContain('ok: publicationOnly')
  })

  test('adding a default route cannot inherit a pre-existing local call', () => {
    const { code, out } = review('default-existing-use')
    expect(code).toBe(1)
    expect(out).toContain('FINDING: default has NO non-test production caller')
    expect(out).not.toContain('ok: default')
  })

  test('comments and strings are not production callers', () => {
    const { code, out } = review('comment-only')
    expect(code).toBe(1)
    expect(out).toContain('FINDING: mentionedOnlyInProse has NO non-test production caller')
    expect(out).not.toContain('ok: mentionedOnlyInProse')
  })

  test('a bare local re-export is not a production caller', () => {
    const { code, out } = review('reexport-only')
    expect(code).toBe(1)
    expect(out).toContain('FINDING: barrelOrphan has NO non-test production caller')
    expect(out).not.toContain('ok: barrelOrphan')
  })

  test('syntax-aware caller search retains a real-use positive control', () => {
    const { code, out } = review('wired-export')
    expect(code).toBe(0)
    expect(out).toContain('ok: newlyWired called by src/wired.ts')
    expect(out).toContain('=== delivers behaviour: yes')
  })
})
