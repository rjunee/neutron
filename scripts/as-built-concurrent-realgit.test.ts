/**
 * REAL-GIT proof that two concurrent builds can both land their plan AND their
 * as-built entry onto a base that moved under them.
 *
 * This is the acceptance test for the doc-layout split, and it is written so that it
 * CANNOT pass vacuously. The property "the merge is clean" is trivially true of any
 * two branches that changed nothing interesting, so every clean-merge assertion here
 * is paired with a CONTROL that replays the identical two builds over the OLD layout
 * and proves the merge really does blow up — same fixture, same branches, same moved
 * base, only the storage shape differs. If the harness ever stops being able to detect
 * a conflict, the control goes red first.
 *
 * Nothing is mocked. A real `git init` repo, real commits, a real intervening commit
 * on `main` after both branches are cut, and real `git merge`. The conflicting paths
 * are read back from git's own index (`git diff --name-only --diff-filter=U`), not
 * inferred from an exit code, so the test asserts WHICH file failed and not merely
 * that something did.
 *
 * The third case is the reason the layout is a filename and not a merge driver: with
 * `merge=union` configured on the shared log, git reports success and splices the two
 * entries line-wise into each other. That case asserts the damage rather than
 * describing it.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { entryFileName, orderEntryFiles, renderLog } from './as-built-log.ts'

const created: string[] = []
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

async function git(repo: string, ...args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { ok: code === 0, stdout, stderr }
}

async function gitOk(repo: string, ...args: string[]): Promise<void> {
  const res = await git(repo, ...args)
  if (!res.ok) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
}

function write(repo: string, rel: string, body: string): void {
  const abs = join(repo, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, body)
}

function read(repo: string, rel: string): string {
  return readFileSync(join(repo, rel), 'utf8')
}

/** The paths git currently reports as UNMERGED. Git's own answer, not an inference. */
async function conflictedPaths(repo: string): Promise<string[]> {
  const res = await git(repo, 'diff', '--name-only', '--diff-filter=U')
  return res.stdout.split('\n').filter(Boolean).sort()
}

// ── the fixture's two builds ────────────────────────────────────────────────────
// Deliberately similar to each other: same date, same section headings, same closing
// line. Real as-built entries share exactly this much boilerplate, and it is what
// makes a line-wise merge splice them together.

interface Build {
  branch: string
  slug: string
  date: string
  title: string
  para: string
}

const ALPHA: Build = {
  branch: 'build/alpha',
  slug: 'alpha-reads-its-own-config',
  date: '2026-08-16',
  title: 'alpha reads its own config',
  para: 'The alpha loader resolved its path from the caller instead of the module, so a run started from another directory read nothing at all.',
}

const BRAVO: Build = {
  branch: 'build/bravo',
  slug: 'bravo-stops-retrying-forever',
  date: '2026-08-16',
  title: 'bravo stops retrying forever',
  para: 'The bravo retry had no ceiling, so one unreachable host held the queue open until the process was killed by hand.',
}

function entryBody(b: Build): string {
  return `## ${b.date} — ${b.title}\n\n${b.para}\n\n**Tests.** green.\n`
}

function planBody(b: Build): string {
  return `# IMPLEMENTATION_PLAN — ${b.title}\n\n- [x] ${b.title}\n- [ ] follow-up\n`
}

const ARCHIVE_SEED = [
  '# AS_BUILT — archive (FROZEN)',
  '',
  'Running log of what shipped, newest first. One entry per merged change.',
  '',
  '## 2026-08-14 — the seed entry that was already there',
  '',
  'Pre-existing history. It must survive every merge in this file.',
  '',
].join('\n')

/** The one-file log as it was: a header, then entries, newest first. */
const LEGACY_LOG_SEED = [
  '# AS_BUILT',
  '',
  'Running log of what shipped, newest first. One entry per merged change.',
  '',
  '## 2026-08-14 — the seed entry that was already there',
  '',
  'Pre-existing history. It must survive every merge in this file.',
  '',
].join('\n')

/** Insert an entry at the top of the one-file log — under the three header lines. */
function prependLegacyEntry(existing: string, b: Build): string {
  const lines = existing.split('\n')
  const first = lines.findIndex((l) => l.startsWith('## '))
  return [...lines.slice(0, first), ...entryBody(b).split('\n'), ...lines.slice(first)].join('\n')
}

/**
 * `legacy` — both scratch docs shared, i.e. the layout as it was.
 * `union-log` — per-build plans (already fixed) + the shared log with `merge=union`,
 *   which isolates the driver as the ONLY variable under test.
 * `split` — the per-entry layout the repo has had since 2026-07-28 and now enforces.
 */
type Layout = 'legacy' | 'union-log' | 'split'

const sharesPlan = (l: Layout): boolean => l === 'legacy'
const sharesLog = (l: Layout): boolean => l !== 'split'

async function seed(layout: Layout): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), 'as-built-realgit-'))
  created.push(repo)
  await gitOk(repo, 'init', '--initial-branch=main')
  await gitOk(repo, 'config', 'user.email', 'build@neutron.local')
  await gitOk(repo, 'config', 'user.name', 'Build Test')
  await gitOk(repo, 'config', 'commit.gpgsign', 'false')

  write(repo, 'src/app.ts', 'export const version = 1\n')
  if (sharesLog(layout)) {
    write(repo, 'docs/AS_BUILT.md', LEGACY_LOG_SEED)
  } else {
    write(repo, 'docs/AS_BUILT.md', ARCHIVE_SEED)
    write(repo, 'docs/as-built/README.md', '# docs/as-built/ — one file per entry\n')
  }
  if (sharesPlan(layout)) {
    write(repo, 'IMPLEMENTATION_PLAN.md', '# IMPLEMENTATION_PLAN\n\n- [ ] nothing yet\n')
  }
  if (layout === 'union-log') {
    write(repo, '.gitattributes', 'docs/AS_BUILT.md merge=union\n')
  }
  await gitOk(repo, 'add', '-A')
  await gitOk(repo, 'commit', '-m', 'base')
  return repo
}

/** One build: cut the branch from the current base, write its plan + entry, commit. */
async function buildOn(repo: string, layout: Layout, b: Build, base: string): Promise<void> {
  await gitOk(repo, 'switch', '-c', b.branch, base)
  if (sharesPlan(layout)) write(repo, 'IMPLEMENTATION_PLAN.md', planBody(b))
  else write(repo, `.trident/plans/${b.branch}.md`, planBody(b))
  if (sharesLog(layout)) write(repo, 'docs/AS_BUILT.md', prependLegacyEntry(read(repo, 'docs/AS_BUILT.md'), b))
  else write(repo, `docs/as-built/${entryFileName(b.date, b.slug)}`, entryBody(b))
  await gitOk(repo, 'add', '-A')
  await gitOk(repo, 'commit', '-m', `build ${b.slug}`)
  await gitOk(repo, 'switch', 'main')
}

interface Replay {
  repo: string
  /** The result of merging the SECOND build after the first already landed. */
  second: GitResult
  secondConflicts: string[]
}

/**
 * Both builds cut from the same base, then `main` MOVES under them, then both publish.
 * The intervening commit touches source only — so anything that conflicts below
 * conflicts on the doc files and on nothing else.
 */
async function replayConcurrentBuilds(layout: Layout): Promise<Replay> {
  const repo = await seed(layout)
  const base = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim()

  await buildOn(repo, layout, ALPHA, base)
  await buildOn(repo, layout, BRAVO, base)

  // main moves after both branches were cut — the stale-base half of the replay.
  write(repo, 'src/app.ts', 'export const version = 2\n')
  await gitOk(repo, 'add', '-A')
  await gitOk(repo, 'commit', '-m', 'unrelated: main moves under both builds')

  const firstLanded = await git(repo, 'merge', '--no-edit', ALPHA.branch)
  if (!firstLanded.ok) throw new Error(`the FIRST build failed to land, which is not the case under test: ${firstLanded.stderr}`)

  const second = await git(repo, 'merge', '--no-edit', BRAVO.branch)
  const secondConflicts = second.ok ? [] : await conflictedPaths(repo)
  return { repo, second, secondConflicts }
}

describe('two concurrent builds, one moved base — the OLD layout (control: the failure is real)', () => {
  test('the second build cannot land: it conflicts on the shared plan and the shared log, and on nothing else', async () => {
    const { second, secondConflicts } = await replayConcurrentBuilds('legacy')

    expect(second.ok).toBe(false)
    // Exactly the two shared scratch docs. The source file both builds left alone does
    // not appear, which is what makes this a doc-format failure rather than bad luck.
    expect(secondConflicts).toEqual(['IMPLEMENTATION_PLAN.md', 'docs/AS_BUILT.md'])
  })
})

describe('two concurrent builds, one moved base — the per-entry layout', () => {
  test('both builds land clean: no conflict on the plan, no conflict on the log', async () => {
    const { repo, second, secondConflicts } = await replayConcurrentBuilds('split')

    expect(second.stderr + second.stdout).not.toContain('CONFLICT')
    expect(secondConflicts).toEqual([])
    expect(second.ok).toBe(true)

    // Both builds' work is actually present — a clean merge that dropped a side would
    // also produce zero conflicts.
    expect(read(repo, `.trident/plans/${ALPHA.branch}.md`)).toBe(planBody(ALPHA))
    expect(read(repo, `.trident/plans/${BRAVO.branch}.md`)).toBe(planBody(BRAVO))
    expect(read(repo, `docs/as-built/${entryFileName(ALPHA.date, ALPHA.slug)}`)).toBe(entryBody(ALPHA))
    expect(read(repo, `docs/as-built/${entryFileName(BRAVO.date, BRAVO.slug)}`)).toBe(entryBody(BRAVO))

    // And the pre-split history is untouched by either build.
    expect(read(repo, 'docs/AS_BUILT.md')).toBe(ARCHIVE_SEED)
  })

  test('the rendered log reads newest-first and holds every entry WHOLE', async () => {
    const { repo } = await replayConcurrentBuilds('split')
    const names = orderEntryFiles([
      `${entryFileName(BRAVO.date, BRAVO.slug)}`,
      'README.md',
      `${entryFileName(ALPHA.date, ALPHA.slug)}`,
    ])
    const rendered = renderLog({
      entries: names.map((name) => ({ name, body: read(repo, `docs/as-built/${name}`) })),
      archive: read(repo, 'docs/AS_BUILT.md'),
    })

    // README.md is not an entry and never reaches the log body.
    expect(names).toEqual([entryFileName(ALPHA.date, ALPHA.slug), entryFileName(BRAVO.date, BRAVO.slug)])

    // Newest-first: today's two entries, then the 2026-08-14 archive entry.
    expect(rendered.indexOf(ALPHA.title)).toBeLessThan(rendered.indexOf(BRAVO.title))
    expect(rendered.indexOf(BRAVO.title)).toBeLessThan(rendered.indexOf('the seed entry that was already there'))

    // WHOLE entries: each body appears as one contiguous block, byte for byte.
    expect(rendered).toContain(entryBody(ALPHA).trim())
    expect(rendered).toContain(entryBody(BRAVO).trim())

    // One header for the whole document, and the archive's own title is not spliced in
    // between the entries.
    expect(rendered.split('\n').filter((l) => l.startsWith('# ')).length).toBe(1)
  })
})

describe('a union merge driver is NOT a substitute (control: it corrupts entries silently)', () => {
  test('git reports success and the two entries are spliced into each other', async () => {
    const { second, repo } = await replayConcurrentBuilds('union-log')

    // The dangerous half: no conflict, no signal, nothing to notice.
    expect(second.ok).toBe(true)

    const merged = read(repo, 'docs/AS_BUILT.md')
    // Both headings survive, which is exactly why this looks like it worked...
    expect(merged).toContain(ALPHA.title)
    expect(merged).toContain(BRAVO.title)

    // ...and the FIRST entry is not intact. The union matched the boilerplate the two
    // entries share, kept one copy of it, and the surviving copy went to whichever
    // entry ended up last — so the other one lost its tail.
    expect(merged.includes(entryBody(ALPHA).trim())).toBe(false)
    expect(merged.includes(entryBody(BRAVO).trim())).toBe(true)

    // The concrete loss, counted: two entries were written, each carrying its own
    // `**Tests.** green.` line, and the merged log holds ONE.
    expect(merged.split('**Tests.** green.').length - 1).toBe(1)

    // And a heading now sits directly on the previous entry's last prose line, with no
    // blank line between them — two half-entries under one roof.
    expect(merged).toContain(`${ALPHA.para}\n## ${BRAVO.date} — ${BRAVO.title}`)
  })
})
