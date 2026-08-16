/**
 * Subprocess self-tests for scripts/ci/check-governed-repo-attributes.ts — the
 * gate that asserts a governed repo's append-only build log is union-merged.
 *
 * WHY SUBPROCESS AND NOT UNIT. The gate shipped with 17 green unit tests over
 * its pure helpers and an in-memory probe, and NOTHING executed the gate. Two
 * false successes lived underneath that green: a `.gitattributes` whose union
 * line was overridden by a later rule, and one overridden by a later wildcard.
 * Both are covered below, and both fail without the fix — the helper tests
 * cannot see either, because the bug was never in a helper. It was in deciding
 * the verdict from a helper at all.
 *
 * Every case runs the REAL gate against a THROWAWAY fixture directory, so no
 * assertion depends on the state of this repo, and each asserts BOTH the exit
 * code and the output, because a gate that exits 1 with the wrong explanation
 * sends the next reader to the wrong file.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GATE = fileURLToPath(new URL('./check-governed-repo-attributes.ts', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

const created: string[] = []
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

/**
 * A throwaway directory shaped like a repo. `governed` writes the root SPEC.md
 * that makes the convention apply; `attributes` is the tracked file, omitted
 * entirely when undefined.
 */
function fixture(opts: { governed?: boolean; logs?: string[]; attributes?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'governed-attrs-'))
  created.push(dir)
  if (opts.governed !== false) writeFileSync(join(dir, 'SPEC.md'), '# spec\n')
  for (const log of opts.logs ?? ['docs/AS_BUILT.md']) {
    const path = join(dir, log)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '# log\n')
  }
  if (opts.attributes !== undefined) writeFileSync(join(dir, '.gitattributes'), opts.attributes)
  return dir
}

/** Make `dir` a real repo carrying the untracked overlay the installer writes. */
function initRepoWithOverlay(dir: string, overlay: string): void {
  spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' })
  mkdirSync(join(dir, '.git', 'info'), { recursive: true })
  writeFileSync(join(dir, '.git', 'info', 'attributes'), overlay)
}

function runGate(root: string): { status: number; out: string } {
  const res = spawnSync('bun', [GATE, root], { cwd: REPO_ROOT, encoding: 'utf8' })
  return { status: res.status ?? -1, out: `${res.stdout}${res.stderr}` }
}

describe('check-governed-repo-attributes (subprocess)', () => {
  test('PASSES when the tracked rule is union', () => {
    const dir = fixture({ attributes: 'docs/AS_BUILT.md merge=union\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('✅')
    expect(out).toContain('merge=union')
  })

  test('FAILS when a LATER duplicate rule overrides the union line', () => {
    // The reproduction the shipped gate reported ✅ on. git 2.50.1 resolves the
    // LAST matching rule, so the tracked floor here is `as-built-log`, not
    // union — and every fresh clone gets a plain content conflict on the log.
    const dir = fixture({
      attributes: 'docs/AS_BUILT.md merge=union\ndocs/AS_BUILT.md merge=as-built-log\n',
    })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('not union-merged')
    expect(out).toContain('merge=as-built-log')
    // The remediation must show the override, not tell the reader to add a line
    // that is already on line 1.
    expect(out).toContain('the LAST wins')
    expect(out).toContain('line 2:')
  })

  test('FAILS when a LATER WILDCARD overrides the exact-path union line', () => {
    // No exact-pattern matcher can see this one at all: the union line is
    // present, correct, and beaten by `docs/*.md`.
    const dir = fixture({
      attributes: 'docs/AS_BUILT.md merge=union\ndocs/*.md merge=binary\n',
    })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('merge=binary')
    expect(out).toContain('overrides it')
  })

  test('FAILS when no rule reaches the log at all', () => {
    const dir = fixture({ attributes: '# nothing here\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('unspecified')
    expect(out).toContain('docs/AS_BUILT.md merge=union')
  })

  test('FAILS when .gitattributes is absent entirely', () => {
    const dir = fixture({})
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('unspecified')
  })

  test('FAILS on another BUILT-IN driver, which is not union', () => {
    // `binary` is somebody's choice and a fixer must not overwrite it — but the
    // property this gate holds is "the log union-merges", and binary does not.
    // A fixer must not overwrite; a gate must not bless. Same fact, two jobs.
    const dir = fixture({ logs: ['AS-BUILT.md'], attributes: 'AS-BUILT.md merge=binary\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain("'binary' is a built-in driver, but it is not union")
  })

  test('FAILS on a CUSTOM driver, and says what git actually does', () => {
    // Measured on git 2.50.1: with no merge.<name>.* config the merge does NOT
    // abort — it falls back to the text merge and conflicts. The gate's old
    // text promised exit 128 unconditionally, which is a different case.
    const dir = fixture({ attributes: 'docs/AS_BUILT.md merge=as-built-log\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('is a CUSTOM driver')
    expect(out).toContain('falls back to the ordinary text merge')
    expect(out).toContain('$GIT_COMMON_DIR/info/attributes')
    // The corrected claim must not be re-asserted as the unconditional one.
    expect(out).not.toContain('breaks every fresh clone')
  })

  test('PASSES an UNGOVERNED directory untouched — no SPEC.md, nothing to enforce', () => {
    const dir = fixture({ governed: false, attributes: '# nothing here\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('not a governed repo')
  })

  test('PASSES a governed repo with no build log to protect', () => {
    const dir = fixture({ logs: [], attributes: '# nothing here\n' })
    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('no append-only build log found')
  })

  test('checks EVERY log a repo keeps, not just the first', () => {
    const dir = fixture({
      logs: ['docs/AS_BUILT.md', 'AS-BUILT.md'],
      attributes: 'docs/AS_BUILT.md merge=union\n',
    })
    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('AS-BUILT.md → merge=unspecified')
  })

  test('a local overlay upgrade does NOT paper over a broken tracked floor', () => {
    // The layering this gate has to keep straight. `install-merge-drivers.sh`
    // binds the entry-aware driver in the untracked $GIT_COMMON_DIR/info/
    // attributes, which OUTRANKS .gitattributes — so in this clone git answers
    // `as-built-log` for a repo whose tracked union line is gone. Asking the
    // clone would pass it. The floor is what travels; the upgrade is not.
    const dir = fixture({ attributes: '# the union line was deleted\n' })
    initRepoWithOverlay(dir, 'docs/AS_BUILT.md merge=as-built-log\n')
    // Control: this clone really does resolve to the overlay.
    const local = spawnSync('git', ['-C', dir, 'check-attr', 'merge', '--', 'docs/AS_BUILT.md'], {
      encoding: 'utf8',
    })
    expect(local.stdout.trim()).toBe('docs/AS_BUILT.md: merge: as-built-log')

    const { status, out } = runGate(dir)
    expect(status).toBe(1)
    expect(out).toContain('unspecified')
  })

  test('an intact floor PLUS a local upgrade passes, and says so without gating on it', () => {
    const dir = fixture({ attributes: 'docs/AS_BUILT.md merge=union\n' })
    initRepoWithOverlay(dir, 'docs/AS_BUILT.md merge=as-built-log\n')
    const { status, out } = runGate(dir)
    expect(status).toBe(0)
    expect(out).toContain('✅')
    expect(out).toContain('informational, not gated')
    expect(out).toContain('as-built-log')
  })

  test('this repo — the governed tree the gate ships in — passes its own gate', () => {
    const { status, out } = runGate(REPO_ROOT)
    expect(out).toContain('docs/AS_BUILT.md')
    expect(status).toBe(0)
  })
})
