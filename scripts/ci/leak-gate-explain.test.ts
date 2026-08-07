/**
 * `leak-gate.sh --explain-denylist` — the diagnostic that makes an over-broad
 * denylist entry identifiable (ISSUES #507).
 *
 * The problem it solves is not a false negative, it is a USELESS SIGNAL. The
 * denylist is a repository secret, so the local mirror is maintained by hand and
 * had drifted broader than CI's: entries CI carries as `word:` were plain
 * substrings locally, so a whole-tree local run reported ~160 findings on files
 * that are green in CI. A gate that always fails is indistinguishable from a gate
 * that found something, so the author learns to ignore it — and the one time it is
 * right, it looks like the 160 times it was not.
 *
 * Two properties are load-bearing and are what these tests defend:
 *
 *   1. It can NEVER be mistaken for a passing gate run. It exits 2 always, and it
 *      is refused outright inside GitHub Actions. A diagnostic that could exit 0
 *      in CI would be a skip flag with a friendly name — and this script's whole
 *      contract is that it has no skip flag.
 *   2. Its counts MIRROR the real rules' case semantics (`ci` for substring, `cs`
 *      for word). A diagnostic that folded case for both would over-report word
 *      entries and send the operator chasing matches the gate never makes, which
 *      is the same class of misleading signal it exists to remove.
 *
 * Every denylist term here is a synthetic string that appears nowhere else.
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'leak-gate.sh')

/** A tiny git repo with known content, so match counts are exact. */
function fixtureTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'leak-explain-'))
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  // The gate enumerates TRACKED files, so the fixture must be a real repo.
  spawnSync('git', ['init', '-q'], { cwd: dir })
  spawnSync('git', ['add', '-A'], { cwd: dir })
  spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'f'], {
    cwd: dir,
  })
  return dir
}

function explain(
  tree: string,
  denylist: string,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const dl = join(mkdtempSync(join(tmpdir(), 'leak-dl-')), 'denylist')
  writeFileSync(dl, denylist)
  const res = spawnSync('bash', [SCRIPT, '--explain-denylist', tree], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LEAK_GATE_PII_DENYLIST_FILE: dl,
      // Never let the ambient CI vars of a real run leak into the fixture.
      GITHUB_ACTIONS: '',
      GITHUB_REPOSITORY: '',
      ...extraEnv,
    },
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

describe('--explain-denylist cannot be mistaken for a gate run', () => {
  test('exits 2 even when nothing matches at all', () => {
    const tree = fixtureTree({ 'a.md': 'nothing interesting here\n' })
    const { status } = explain(tree, 'zqx-absent-term\n')
    // NOT 0. A clean-looking exit 0 is precisely how this would become a skip.
    expect(status).toBe(2)
  })

  test('is REFUSED inside GitHub Actions', () => {
    const tree = fixtureTree({ 'a.md': 'zqx-present-term\n' })
    const { status, stderr } = explain(tree, 'zqx-present-term\n', {
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'rjunee/neutron',
    })
    expect(status).toBe(2)
    expect(stderr).toContain('REFUSED inside')
  })

  test('says plainly that it is a diagnostic and not a verdict', () => {
    const tree = fixtureTree({ 'a.md': 'zqx-present-term\n' })
    const { stdout } = explain(tree, 'zqx-present-term\n')
    expect(stdout).toContain('DIAGNOSTIC, not a gate run')
  })
})

describe('--explain-denylist identifies the over-broad entry', () => {
  test('counts substring matches case-INSENSITIVELY, like the real ci rule', () => {
    const tree = fixtureTree({
      'a.md': 'zqxterm\nZQXTERM\nprefix-zqxterm-suffix\n',
    })
    const { stdout } = explain(tree, 'zqxterm\n')
    const row = stdout.split('\n').find((l) => l.includes('sub') && l.includes('zqxterm'))
    expect(row).toBeDefined()
    // 3 lines: lower, UPPER (case-folded), and the embedded one.
    expect(row).toMatch(/^\s*3\s+sub/)
  })

  test('counts word matches case-SENSITIVELY, like the real cs rule', () => {
    // THE MIRROR PROPERTY. The real word rule is case-sensitive; if this folded
    // case it would report the UPPER line too and overstate the entry.
    const tree = fixtureTree({
      'a.md': 'zqxterm here\nZQXTERM here\nprefix-zqxterm-suffix\n',
    })
    const { stdout } = explain(tree, 'word:zqxterm\n')
    const row = stdout.split('\n').find((l) => l.includes('word') && l.includes('zqxterm'))
    expect(row).toBeDefined()
    // Two matches: the lowercase standalone token, and the hyphen-embedded one
    // (`-` is a non-word character, so it counts as a token boundary). NOT the
    // uppercase line — that is the case-sensitivity this test pins.
    expect(row).toMatch(/^\s*2\s+word/)
  })

  test('flags a substring entry with many matches and names the word: fix', () => {
    const tree = fixtureTree({
      'a.md': Array.from({ length: 9 }, (_, i) => `line ${i} zqxterm embedded`).join('\n'),
    })
    const { stdout } = explain(tree, 'zqxterm\n')
    expect(stdout).toContain('over-broad as a substring?')
    expect(stdout).toContain('word:zqxterm')
  })

  test('does NOT flag a word: entry, however many times it matches', () => {
    // A `word:` entry is already the narrow form — suggesting `word:word:x` would
    // be noise, and noise is the entire defect being fixed.
    const tree = fixtureTree({
      'a.md': Array.from({ length: 9 }, (_, i) => `line ${i} zqxterm here`).join('\n'),
    })
    const { stdout } = explain(tree, 'word:zqxterm\n')
    // Scoped to the ROW: the explanatory header legitimately contains the phrase
    // "over-broad as a substring", so asserting on the whole output would fail
    // against correct behaviour (it did, on first write).
    const row = stdout.split('\n').find((l) => /^\s*\d+\s+word\s/.test(l))
    expect(row).toBeDefined()
    expect(row).not.toContain('over-broad')
  })

  test('skips blank lines and comments rather than counting them as entries', () => {
    const tree = fixtureTree({ 'a.md': 'zqxterm\n' })
    const { stdout } = explain(tree, '# a comment\n\nzqxterm\n')
    expect(stdout).not.toContain('a comment')
    const rows = stdout.split('\n').filter((l) => /^\s*\d+\s+(sub|word)\s/.test(l))
    expect(rows).toHaveLength(1)
  })

  test('reports 0 for an entry that matches nothing, rather than omitting it', () => {
    // An omitted entry reads as "not checked". The count is the point.
    const tree = fixtureTree({ 'a.md': 'unrelated\n' })
    const { stdout } = explain(tree, 'zqx-absent-term\n')
    expect(stdout).toMatch(/^\s*0\s+sub\s+zqx-absent-term/m)
  })

  test('fails loudly when no denylist can be resolved', () => {
    const tree = fixtureTree({ 'a.md': 'x\n' })
    const res = spawnSync('bash', [SCRIPT, '--explain-denylist', tree], {
      encoding: 'utf8',
      env: { ...process.env, LEAK_GATE_PII_DENYLIST_FILE: '/nonexistent/denylist', GITHUB_ACTIONS: '' },
    })
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('no denylist resolved')
  })
})
