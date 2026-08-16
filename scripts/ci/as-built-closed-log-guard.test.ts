/**
 * Mutation coverage for `scripts/ci/as-built-closed-log-guard.sh`.
 *
 * A gate that never fails is indistinguishable from no gate, and this repo has shipped
 * one of those before (the Tier-1 leak rule that printed SILENT for ~3,700 runs). So
 * every case here runs the REAL script against a REAL git repo, and the pass cases are
 * paired with a mutation that must flip the verdict — the "an entry was added" case
 * proves the mutation landed, and the neighbouring cases prove it did not fire on the
 * edits the rule deliberately allows.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const GUARD = resolve(import.meta.dir, 'as-built-closed-log-guard.sh')

const created: string[] = []
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

async function sh(cmd: string[], cwd: string, env?: Record<string, string>): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: stdout + stderr }
}

async function git(repo: string, ...args: string[]): Promise<void> {
  const res = await sh(['git', '-C', repo, ...args], repo)
  if (res.code !== 0) throw new Error(`git ${args.join(' ')}: ${res.out}`)
}

function write(repo: string, rel: string, body: string): void {
  const abs = join(repo, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, body)
}

const CLOSED_SEED = [
  '# AS_BUILT — archive',
  '',
  'Running log of what shipped, newest first.',
  '',
  '## 2026-07-28 — the last entry this file ever took',
  '',
  'body.',
  '',
].join('\n')

/** A repo whose `main` holds the closed log, plus a branch carrying `change`. */
async function repoWithChange(change: (repo: string) => void): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), 'as-built-guard-'))
  created.push(repo)
  await git(repo, 'init', '--initial-branch=main')
  await git(repo, 'config', 'user.email', 'g@neutron.local')
  await git(repo, 'config', 'user.name', 'Guard Test')
  await git(repo, 'config', 'commit.gpgsign', 'false')
  write(repo, 'docs/AS_BUILT.md', CLOSED_SEED)
  write(repo, 'docs/as-built/README.md', '# one file per entry\n')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-m', 'base')
  // `origin/main` without a network: a local ref the guard resolves exactly as it would
  // a fetched one.
  await git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  await git(repo, 'switch', '-c', 'build/x')
  change(repo)
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-m', 'change')
  return repo
}

/** The real script, pointed at the fixture repo through its documented seam. */
function runGuard(repo: string, env?: Record<string, string>) {
  return sh(['bash', GUARD], repo, { AS_BUILT_GUARD_ROOT: repo, ...env })
}

describe('as-built-closed-log-guard.sh', () => {
  test('THE MUTATION: an entry appended to the closed log FAILS, and the message names it', async () => {
    const repo = await repoWithChange((r) => {
      const lines = CLOSED_SEED.split('\n')
      const at = lines.findIndex((l) => l.startsWith('## '))
      write(
        r,
        'docs/AS_BUILT.md',
        [...lines.slice(0, at), '## 2026-08-15 — a build that ignored the README', '', 'body.', '', ...lines.slice(at)].join('\n'),
      )
    })
    const res = await runGuard(repo)
    expect(res.code).toBe(1)
    expect(res.out).toContain('2026-08-15 — a build that ignored the README')
    expect(res.out).toContain('docs/as-built/<YYYY-MM-DD>-<slug>.md')
  })

  test('a per-entry file added under docs/as-built/ PASSES — the intended path is not blocked', async () => {
    const repo = await repoWithChange((r) => {
      write(r, 'docs/as-built/2026-08-15-a-well-behaved-build.md', '## 2026-08-15 — a well behaved build\n\nbody.\n')
    })
    const res = await runGuard(repo)
    expect(res.code).toBe(0)
    expect(res.out).toContain('OK')
  })

  test('editing the closed log WITHOUT adding an entry PASSES — it is a closure, not a freeze', async () => {
    const repo = await repoWithChange((r) => {
      write(r, 'docs/AS_BUILT.md', CLOSED_SEED.replace('Running log', 'Running log (closed)'))
    })
    const res = await runGuard(repo)
    expect(res.code).toBe(0)
  })

  test('a change that touches neither PASSES', async () => {
    const repo = await repoWithChange((r) => write(r, 'src/app.ts', 'export const v = 1\n'))
    expect((await runGuard(repo)).code).toBe(0)
  })

  test('the entry directory disappearing is exit 2, never a silent pass', async () => {
    const repo = await repoWithChange((r) => write(r, 'src/app.ts', 'export const v = 1\n'))
    rmSync(join(repo, 'docs/as-built'), { recursive: true, force: true })
    const res = await runGuard(repo)
    expect(res.code).toBe(2)
    expect(res.out).toContain('Treat as broken')
  })

  test('an unreachable base ref skips rather than blocking a fork', async () => {
    const repo = await repoWithChange((r) => write(r, 'src/app.ts', 'export const v = 1\n'))
    const res = await runGuard(repo, { AS_BUILT_GUARD_BASE_REF: 'origin/does-not-exist' })
    expect(res.code).toBe(0)
    expect(res.out).toContain('skipping')
  })

  test('a base that MOVED under the branch does not attribute someone else’s entry to it', async () => {
    // The three-dot half: main takes an entry AFTER the branch was cut. A two-dot diff
    // would show it as removed/added noise; the merge-base comparison must not blame
    // this branch for a file it never touched.
    const repo = await repoWithChange((r) => write(r, 'src/app.ts', 'export const v = 1\n'))
    await git(repo, 'switch', 'main')
    const lines = CLOSED_SEED.split('\n')
    const at = lines.findIndex((l) => l.startsWith('## '))
    write(
      repo,
      'docs/AS_BUILT.md',
      [...lines.slice(0, at), '## 2026-08-15 — someone else did this', '', 'body.', '', ...lines.slice(at)].join('\n'),
    )
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-m', 'main moves')
    await git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    await git(repo, 'switch', 'build/x')
    const res = await runGuard(repo)
    expect(res.code).toBe(0)
  })
})
