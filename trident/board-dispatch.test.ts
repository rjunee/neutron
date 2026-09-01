import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { TridentRunStore } from './store.ts'
import {
  detectReviewIntent,
  dispatchBoardBoundBuild,
  makeDispatchLandedProbe,
  type BoardBoundBuildDeps,
  type TridentBoardBinder,
} from './board-dispatch.ts'
import { makeCredentialedHostRunner } from './git-mode.ts'
import type { EnvCapableHostRunner, HostCommandResult } from './git-mode.ts'
import { slugifyTask } from './slugify-task.ts'

let tmp: string
let db: ProjectDb
let store: TridentRunStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-board-dispatch-'))
  seedMigratedDb(join(tmp, 'project.db'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  store = new TridentRunStore(db)
  cardLink = null
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * The card's board link, read LAZILY by the fixture below so a test can create its
 * prior run first. Seeding fails closed without it (`board-dispatch.ts`): a card that
 * does not name the run whose commit it is adopting takes the fresh dispatch. Null
 * outside the seed suite, which is the shape every other suite here wants.
 */
let cardLink: string | null = null

const board: TridentBoardBinder = {
  get: () => ({
    id: 'ready',
    title: 'wire the CSV export button to the new endpoint with tests',
    design_doc_ref: null,
    linked_run_id: cardLink,
  }),
  attachRun: async () => {},
}

const ok = (stdout = ''): HostCommandResult => ({ ok: true, stdout, stderr: '', exit_code: 0 })

function makeRepo(withOrigin: boolean): string {
  const dir = join(tmp, withOrigin ? 'repo-with-origin' : 'repo-local')
  mkdirSync(dir)
  expect(Bun.spawnSync(['git', 'init'], { cwd: dir }).exitCode).toBe(0)
  if (withOrigin) {
    expect(
      Bun.spawnSync(['git', '-C', dir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git']).exitCode,
    ).toBe(0)
  }
  return dir
}

function installGhShim(): string {
  const shimDir = join(tmp, 'shim')
  mkdirSync(shimDir)
  const ghPath = join(shimDir, 'gh')
  writeFileSync(
    ghPath,
    `#!/bin/sh\nprintf '%s' "\${GH_TOKEN:-ABSENT}" > "${join(tmp, 'gh-observed')}"\nprintf '%s\\n' "$*" >> "${join(tmp, 'gh-argv')}"\nexit 0\n`,
  )
  chmodSync(ghPath, 0o755)
  return shimDir
}

function dispatch(repoDir: string, secretsStore: { get: () => Promise<string | null> }, resolveMergeMode?: () => Promise<'local'>) {
  return dispatchBoardBoundBuild(
    { task: 'build the thing', board_item_id: 'ready' },
    {
      store,
      board,
      project_slug: 'proj-1',
      repo_path: tmp,
      owner_handle: 'owner',
      secretsStore,
      resolveBuildRepo: async () => repoDir,
      resolveRalph: async () => false,
      ...(resolveMergeMode === undefined ? {} : { resolveMergeMode }),
    },
  )
}

function localDeps(boardOverride: TridentBoardBinder = board): BoardBoundBuildDeps {
  return {
    store,
    board: boardOverride,
    project_slug: 'proj-1',
    repo_path: tmp,
    resolveBuildRepo: async () => tmp,
    resolveMergeMode: async () => 'local',
    resolveRalph: async () => false,
  }
}

describe('review-only dispatch contract', () => {
  test('a review-shaped task with no bound_pr is REFUSED at dispatch, naming bound_pr', async () => {
    let createCalls = 0
    let attachCalls = 0
    const originalCreate = store.create.bind(store)
    store.create = async (input) => {
      createCalls += 1
      return originalCreate(input)
    }
    const recordingBoard: TridentBoardBinder = {
      ...board,
      attachRun: async () => {
        attachCalls += 1
      },
    }

    const result = await dispatchBoardBoundBuild(
      { task: 'run a review round on PR #515', board_item_id: 'ready' },
      localDeps(recordingBoard),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('review_needs_bound_pr')
    expect(result.message).toContain('bound_pr')
    expect(result.message).toContain('515')
    expect(createCalls).toBe(0)
    expect(attachCalls).toBe(0)
  })

  test.each([
    ['run a review round on PR #515', 515],
    ['review PR #524', 524],
    ['Re-review PR #515 after the fixes', 515],
    ['please do a review round of PR 542', 542],
    ['Perform a review pass on PR #7', 7],
  ] as const)('detectReviewIntent matches %s', (task, pr) => {
    expect(detectReviewIntent(task)).toBe(pr)
  })

  test.each([
    'fix the review-gate check so the same head always scans the same commits',
    'address the review feedback on PR #515 and fix the failing tests',
    'build the review-evidence poster for bound runs',
    'add tests for the orchestrator publish path',
  ])('detectReviewIntent does not match %s', (task) => {
    expect(detectReviewIntent(task)).toBeNull()
  })

  test('a review dispatch WITH bound_pr populates the column', async () => {
    const result = await dispatchBoardBoundBuild(
      { task: 'review PR #515', board_item_id: 'ready', bound_pr: 515 },
      localDeps(),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(store.get(result.run.id)!.bound_pr).toBe(515)
    const row = db
      .raw()
      .query('select count(*) as n from code_trident_runs where bound_pr is not null and bound_pr != 0')
      .get() as { n: number }
    expect(row.n).toBe(1)
  })

  test('malformed bound_pr is refused with zero state', async () => {
    let createCalls = 0
    let attachCalls = 0
    const originalCreate = store.create.bind(store)
    store.create = async (input) => {
      createCalls += 1
      return originalCreate(input)
    }
    const recordingBoard: TridentBoardBinder = {
      ...board,
      attachRun: async () => {
        attachCalls += 1
      },
    }

    for (const bound_pr of [0, -3, 1.5, Number.NaN]) {
      const result = await dispatchBoardBoundBuild(
        { task: 'review PR #515', board_item_id: 'ready', bound_pr },
        localDeps(recordingBoard),
      )
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.code).toBe('invalid_bound_pr')
    }

    expect(createCalls).toBe(0)
    expect(attachCalls).toBe(0)
    const row = db.raw().query('select count(*) as n from code_trident_runs').get() as { n: number }
    expect(row.n).toBe(0)
  })

  test('bound_pr skips the ask-gate; the gate is otherwise intact', async () => {
    const terseBoard: TridentBoardBinder = {
      get: () => ({ id: 'terse', title: 'auth', design_doc_ref: null }),
      attachRun: async () => {},
    }

    const bound = await dispatchBoardBoundBuild(
      { task: 'review PR #515', board_item_id: 'terse', bound_pr: 515 },
      localDeps(terseBoard),
    )
    expect(bound.ok).toBe(true)

    const build = await dispatchBoardBoundBuild(
      { task: 'build auth', board_item_id: 'terse' },
      localDeps(terseBoard),
    )
    expect(build.ok).toBe(false)
    if (build.ok) return
    expect(build.code).toBe('underspecified')
  })
})

describe('dispatchBoardBoundBuild credentialed merge-mode probe', () => {
  test("unauthenticated repository without an origin resolves to 'local'", async () => {
    let getCalls = 0
    const result = await dispatch(makeRepo(false), { get: async () => (getCalls++, null) })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.merge_mode).toBe('local')
    expect(getCalls).toBeGreaterThanOrEqual(1)
  })

  test("authenticated GitHub repository resolves to 'pr' and passes GH_TOKEN to gh", async () => {
    const repo = makeRepo(true)
    const shimDir = installGhShim()
    const oldPath = process.env['PATH']
    process.env['PATH'] = `${shimDir}:${oldPath ?? ''}`
    try {
      const result = await dispatch(repo, { get: async () => 'test-sentinel-token-abc' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.merge_mode).toBe('pr')
      expect(readFileSync(join(tmp, 'gh-observed'), 'utf8')).toBe('test-sentinel-token-abc')
    } finally {
      process.env['PATH'] = oldPath
    }
  })

  test('resolves credentials for merge-mode auth and the landed probe', async () => {
    const repo = makeRepo(true)
    const shimDir = installGhShim()
    let getCalls = 0
    const oldPath = process.env['PATH']
    process.env['PATH'] = `${shimDir}:${oldPath ?? ''}`
    try {
      const result = await dispatch(repo, { get: async () => (getCalls++, 'test-sentinel-token-abc') })
      expect(result.ok).toBe(true)
      expect(getCalls).toBe(3)
    } finally {
      process.env['PATH'] = oldPath
    }
  })

  test('an injected resolveMergeMode takes precedence without reading the store', async () => {
    let getCalls = 0
    const result = await dispatch(
      makeRepo(false),
      { get: async () => (getCalls++, 'test-sentinel-token-abc') },
      async () => 'local' as const,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.merge_mode).toBe('local')
    expect(getCalls).toBe(0)
  })

  test('a secrets-store failure degrades and does not brick local dispatch', async () => {
    const result = await dispatch(makeRepo(false), {
      get: async () => {
        throw new Error('secrets store unavailable')
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.merge_mode).toBe('local')
  })
})

describe('dispatch refuses a card whose work already landed', () => {
  const mergedJson = JSON.stringify({
    number: 336,
    headRefOid: 'a'.repeat(40),
    mergedAt: '2026-08-16T23:27:00Z',
  })

  function fakeRunner(
    ghResult: HostCommandResult,
    ancestorResult: HostCommandResult = ok(),
  ): { calls: string[][]; run: EnvCapableHostRunner } {
    const calls: string[][] = []
    const run: EnvCapableHostRunner = async (command) => {
      calls.push(command)
      if (command[0] === 'gh') return ghResult
      if (command.includes('symbolic-ref')) return ok('origin/main\n')
      if (command.includes('fetch')) return ok()
      if (command.includes('--is-ancestor')) return ancestorResult
      return { ok: false, stdout: '', stderr: 'unexpected command', exit_code: 2 }
    }
    return { calls, run }
  }

  function dispatchWith(
    run: EnvCapableHostRunner,
    mergeMode: 'pr' | 'local' = 'pr',
  ): { attached: string[]; result: ReturnType<typeof dispatchBoardBoundBuild> } {
    const attached: string[] = []
    const recordingBoard: TridentBoardBinder = {
      get: board.get,
      attachRun: async (_slug, _id, run_id) => {
        attached.push(run_id)
      },
    }
    return {
      attached,
      result: dispatchBoardBoundBuild(
        { task: 'build the thing', board_item_id: 'ready' },
        {
          store,
          board: recordingBoard,
          project_slug: 'proj-1',
          repo_path: tmp,
          resolveBuildRepo: async () => tmp,
          resolveMergeMode: async () => mergeMode,
          resolveRalph: async () => false,
          landedProbe: makeDispatchLandedProbe(run),
        },
      ),
    }
  }

  test('a merged PR refuses before creating or attaching any state', async () => {
    const fake = fakeRunner(ok(mergedJson))
    const dispatched = dispatchWith(fake.run)
    const result = await dispatched.result

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('already_landed')
    expect(result.message).toContain('already merged as #336')
    expect(result.message).toContain('verify the card instead of rebuilding')
    const row = db.raw().query('SELECT COUNT(*) AS count FROM code_trident_runs').get() as {
      count: number
    }
    expect(row.count).toBe(0)
    expect(dispatched.attached).toEqual([])
  })

  test('no merged PR proceeds and creates the expected card branch', async () => {
    const fake = fakeRunner(ok(''))
    const result = await dispatchWith(fake.run).result

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.branch).toBe('trident/build-the-thing')
  })

  test('a landed probe that throws SYNCHRONOUSLY degrades open instead of escaping the dispatch', async () => {
    // The `.catch(() => null)` form attached its handler to a promise the probe never
    // returned: a NON-async function that throws does so at the CALL, and the
    // exception escaped `dispatchBoardBoundBuild` entirely — the whole board dispatch
    // lost to a probe whose ONLY contract is that absence of evidence is not a merge.
    // The seed probe below was given the try/catch shape in Argus r7 and its docblock
    // then claimed parity this call did not have (Argus r1, nit). An `async` thrower
    // cannot see the difference, so this one is handed in un-wrapped.
    let probeReached = false
    const result = await dispatchBoardBoundBuild(
      { task: 'build the thing', board_item_id: 'ready' },
      {
        ...localDeps(),
        resolveMergeMode: async () => 'pr',
        landedProbe: () => {
          probeReached = true
          throw new Error('gh exploded synchronously')
        },
        readBranchTip: async () => '',
      },
    )

    expect(probeReached).toBe(true) // not passing by never probing at all
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.branch).toBe('trident/build-the-thing')
  })

  test('a probe that cannot answer degrades open', async () => {
    const fake = fakeRunner({
      ok: false,
      stdout: '',
      stderr: 'connect timeout',
      exit_code: 1,
    })
    const result = await dispatchWith(fake.run).result

    expect(result.ok).toBe(true)
  })

  test('local mode never invokes the GitHub probe', async () => {
    const fake = fakeRunner(ok(mergedJson))
    const result = await dispatchWith(fake.run, 'local').result

    expect(result.ok).toBe(true)
    expect(fake.calls.filter((command) => command[0] === 'gh')).toEqual([])
  })

  test('a squash-merged PR still refuses when its head is not on the base', async () => {
    const fake = fakeRunner(
      ok(mergedJson),
      { ok: false, stdout: '', stderr: '', exit_code: 1 },
    )
    const result = await dispatchWith(fake.run).result

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('already_landed')
    expect(result.message).toContain('already merged as #336')
    expect(result.message).not.toContain('contained in origin/')
  })

  test('the credentialed fallback probe runs when no probe is injected', async () => {
    const repo = makeRepo(false)
    const shimDir = installGhShim()
    const oldPath = process.env['PATH']
    process.env['PATH'] = `${shimDir}:${oldPath ?? ''}`
    try {
      const result = await dispatchBoardBoundBuild(
        { task: 'build the thing', board_item_id: 'ready' },
        {
          store,
          board,
          project_slug: 'proj-1',
          repo_path: tmp,
          resolveBuildRepo: async () => repo,
          resolveMergeMode: async () => 'pr',
          resolveRalph: async () => false,
          owner_handle: 'owner',
          secretsStore: { get: async () => 'test-sentinel-token-abc' },
        },
      )

      expect(result.ok).toBe(true)
      const argv = readFileSync(join(tmp, 'gh-argv'), 'utf8')
      expect(argv).toContain(
        'pr list --head trident/build-the-thing --state merged --json number,headRefOid,mergedAt',
      )
    } finally {
      process.env['PATH'] = oldPath
    }
  })
})

/**
 * SALVAGE-RESUME SEED — the measured waste this closes: 33 runs in 30 days
 * reached `forge-done` (the build succeeded and committed) and then died without
 * a review. Each re-dispatch created a null-checkpoint row, so the launcher saw a
 * FRESH launch and either rebuilt the identical work or refused it outright
 * because the previous run's own commits were sitting on the branch.
 *
 * These drive the REAL `dispatchBoardBoundBuild` against the real store, with the
 * branch-tip read injected.
 */
describe('dispatch seeds a resume from a built-but-never-reviewed prior run', () => {
  const HEAD = 'a'.repeat(40)
  const MOVED = 'b'.repeat(40)
  const FINDINGS = '[{"severity":"P2","title":"full suite deferred"}]'
  const TASK = 'build the thing'
  const SLUG = 'build-the-thing'
  const BRANCH = 'trident/build-the-thing'

  const BASE = 'c'.repeat(40)

  /** A finished prior attempt at THIS card, in whatever shape the test needs. */
  async function priorRun(over: {
    phase?: 'done' | 'failed' | 'stopped'
    verdict?: 'APPROVE' | 'REQUEST_CHANGES' | 'REVIEW_NOT_RUN' | null
    checkpoint?: string | null
    head?: string | null
    findings?: string | null
    pr?: number | null
    task?: string
    base_sha?: string | null
  }) {
    const task = over.task ?? TASK
    const run = await store.create({
      slug: slugifyTask(task),
      project_slug: 'proj-1',
      repo_path: tmp,
      task,
      branch: BRANCH,
    })
    await store.update(run.id, {
      phase: over.phase ?? 'failed',
      inner_checkpoint: over.checkpoint === undefined ? 'forge-done' : over.checkpoint,
      inner_checkpoint_head: over.head === undefined ? HEAD : over.head,
      inner_checkpoint_findings: over.findings ?? null,
      inner_verdict: over.verdict === undefined ? 'REVIEW_NOT_RUN' : over.verdict,
      base_sha: over.base_sha === undefined ? BASE : over.base_sha,
      ...(over.pr === undefined ? {} : { pr: over.pr }),
    })
    // A genuine re-dispatch of THIS card names the run it just produced — since #340
    // the terminal reconcile keeps `linked_run_id` on failure, which is exactly the
    // built-never-reviewed shape being seeded. Tests that want the other shapes
    // (absent, whitespace, someone else's run) override it.
    cardLink = run.id
    return run
  }

  /** Dispatch the card, recording every branch-tip read the chokepoint pays for. */
  async function dispatchSeeding(
    readBranchTip: (repo: string, branch: string) => Promise<string>,
    over: { task?: string; ralph?: boolean; merge_mode?: 'local' | 'pr' } = {},
  ) {
    const tipReads: Array<[string, string]> = []
    // The MODE each read was asked for — the seam that decides whether the proof
    // is taken against origin or the local ref.
    const tipModes: string[] = []
    const result = await dispatchBoardBoundBuild(
      { task: over.task ?? TASK, board_item_id: 'ready' },
      {
        ...localDeps(),
        ...(over.merge_mode === undefined ? {} : { resolveMergeMode: async () => over.merge_mode! }),
        ...(over.ralph === undefined ? {} : { resolveRalph: async () => over.ralph! }),
        readBranchTip: async (repo, branch, merge_mode) => {
          tipReads.push([repo, branch])
          tipModes.push(merge_mode)
          return readBranchTip(repo, branch)
        },
      },
    )
    return { result, tipReads, tipModes }
  }

  test('THE PR-MODE TIP PROBE IS CREDENTIALED — it is the same class of remote read as the landed probe', async () => {
    // The salvage this card exists for is a REMOTE read in `pr` mode, and it used to
    // run through bare `spawnCapture` with the ambient process env while the landed
    // probe two lines above it was handed the credentialed runner. Against a PRIVATE
    // origin that read exits non-zero, collapses to `''`, and seeds nothing — the
    // headline salvage silently not happening, and failing CLOSED so nothing ever
    // looked wrong. Proven the way the landed-probe test proves its own wiring: a
    // real `git` on PATH that records whether the credential env arrived.
    await priorRun({ findings: FINDINGS })
    const shimDir = join(tmp, 'git-shim')
    mkdirSync(shimDir)
    const gitPath = join(shimDir, 'git')
    const observed = join(tmp, 'git-config-count')
    const argv = join(tmp, 'git-argv')
    writeFileSync(
      gitPath,
      `#!/bin/sh\n` +
        `printf '%s\\n' "$*" >> "${argv}"\n` +
        `case "$*" in\n` +
        `  *ls-remote*)\n` +
        `    printf '%s' "\${GIT_CONFIG_COUNT:-ABSENT}" > "${observed}"\n` +
        `    printf '%s\\t%s\\n' "${HEAD}" "refs/heads/${BRANCH}"\n` +
        `    ;;\n` +
        `esac\n` +
        `exit 0\n`,
    )
    chmodSync(gitPath, 0o755)
    const oldPath = process.env['PATH']
    process.env['PATH'] = `${shimDir}:${oldPath ?? ''}`
    let result
    try {
      result = await dispatchBoardBoundBuild(
        { task: TASK, board_item_id: 'ready' },
        {
          store,
          board,
          project_slug: 'proj-1',
          repo_path: tmp,
          resolveBuildRepo: async () => tmp,
          resolveMergeMode: async () => 'pr',
          resolveRalph: async () => false,
          // Not under test here, and it must not need a live `gh`.
          landedProbe: async () => null,
          owner_handle: 'owner',
          secretsStore: { get: async () => 'test-sentinel-token-abc' },
        },
      )
    } finally {
      process.env['PATH'] = oldPath
    }

    // The read really was the remote one…
    expect(readFileSync(argv, 'utf8')).toContain(`ls-remote --heads origin refs/heads/${BRANCH}`)
    // …and it carried the credential env (`githubProcessEnv` sets GIT_CONFIG_COUNT=1
    // alongside GH_TOKEN). 'ABSENT' is what the uncredentialed spawn produced.
    expect(readFileSync(observed, 'utf8')).toBe('1')
    // POSITIVE CONTROL: an assertion about the env is worth nothing if the seed did
    // not happen — the tip the shim printed is the prior run's recorded head.
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(store.get(result.run.id)!.inner_checkpoint).toBe('forge-done')
    expect(store.get(result.run.id)!.inner_checkpoint_findings).toBe(FINDINGS)
  })

  test('THE PRODUCTION DEPS SHAPE CARRIES THAT CREDENTIAL — `hostRunner`, since no real caller passes a secrets store', async () => {
    // THE BLOCKER THE TEST ABOVE COULD NOT SEE (Argus r16). It proves the probe is
    // credentialed WHEN `secretsStore` + `owner_handle` are supplied — and no
    // production caller supplies them. All of them inject `resolveMergeMode`
    // instead (the composition root owns the token), which skips the whole branch
    // that builds `credentialedRunner`. So every real dispatch probed on bare
    // `spawnCapture`, and against a PRIVATE origin `ls-remote` exits non-zero,
    // collapses to `''` and seeds NOTHING: the card's headline salvage silently
    // inert on exactly the repos that need it, failing closed so nothing looked
    // wrong. `hostRunner` is the seam the composition root now hands its own
    // runner to; this drives the EXACT production deps shape.
    const UNWIRED_TASK = 'build the thing without a credential'
    await priorRun({ findings: FINDINGS })
    const shimDir = join(tmp, 'git-shim-private')
    mkdirSync(shimDir)
    const gitPath = join(shimDir, 'git')
    const argv = join(tmp, 'git-argv-private')
    // A PRIVATE origin, modelled honestly: an uncredentialed `ls-remote` exits
    // non-zero with no output, which is what `defaultReadBranchTip` turns into ''.
    writeFileSync(
      gitPath,
      `#!/bin/sh\n` +
        `printf '%s\\n' "$*" >> "${argv}"\n` +
        `case "$*" in\n` +
        `  *ls-remote*)\n` +
        `    [ -n "\${GIT_CONFIG_COUNT:-}" ] || { echo "fatal: could not read Username" >&2; exit 128; }\n` +
        `    printf '%s\\t%s\\n' "${HEAD}" "refs/heads/${BRANCH}"\n` +
        `    ;;\n` +
        `esac\n` +
        `exit 0\n`,
    )
    chmodSync(gitPath, 0o755)
    // The composition root's own runner, built the production way — the composer
    // hands `tridentHostRunner` (`makeLazyCredentialedHostRunner`) to this seam;
    // the eager sibling bakes the same `githubProcessEnv` shape in.
    const credentialed: EnvCapableHostRunner = makeCredentialedHostRunner({
      GH_TOKEN: 'test-sentinel',
      GIT_CONFIG_COUNT: '1',
    })
    /** Everything the three production callers actually pass — and nothing else. */
    const productionDeps = (): BoardBoundBuildDeps => ({
      store,
      board,
      project_slug: 'proj-1',
      repo_path: tmp,
      resolveBuildRepo: async () => tmp,
      resolveMergeMode: async () => 'pr',
      resolveRalph: async () => false,
      landedProbe: async () => null,
    })

    const oldPath = process.env['PATH']
    process.env['PATH'] = `${shimDir}:${oldPath ?? ''}`
    let wired
    let unwired
    try {
      wired = await dispatchBoardBoundBuild(
        { task: TASK, board_item_id: 'ready' },
        { ...productionDeps(), hostRunner: credentialed },
      )
      // THE FALSIFICATION, same shape minus the one line: this is what every
      // production dispatch did before the wiring existed. Its own card + prior
      // run, because `(project_slug, slug)` is UNIQUE among live rows — the wired
      // dispatch above is still holding this card's slug.
      await priorRun({ task: UNWIRED_TASK, findings: FINDINGS })
      unwired = await dispatchBoardBoundBuild(
        { task: UNWIRED_TASK, board_item_id: 'ready' },
        productionDeps(),
      )
    } finally {
      process.env['PATH'] = oldPath
    }

    // The remote read really was attempted, both times.
    expect(readFileSync(argv, 'utf8')).toContain(`ls-remote --heads origin refs/heads/${BRANCH}`)
    // WIRED: the credential arrived, the tip matched, the built commit is adopted.
    expect(wired.ok).toBe(true)
    if (!wired.ok) return
    expect(store.get(wired.run.id)!.inner_checkpoint).toBe('forge-done')
    expect(store.get(wired.run.id)!.inner_checkpoint_head).toBe(HEAD)
    expect(store.get(wired.run.id)!.inner_checkpoint_findings).toBe(FINDINGS)
    // UNWIRED: the same private origin refuses the read, so nothing is adopted and
    // the finished commit is rebuilt from scratch. Delete `hostRunner` from
    // `board-dispatch.ts` and the two halves swap places.
    expect(unwired.ok).toBe(true)
    if (!unwired.ok) return
    expect(store.get(unwired.run.id)!.inner_checkpoint).toBeNull()
    expect(store.get(unwired.run.id)!.inner_checkpoint_findings).toBeNull()
  })

  test('THE LOCAL-MODE TIP PROBE USES THE SAME INJECTED RUNNER — the parameter is not honoured on one branch only', async () => {
    // `defaultReadBranchTip` takes a runner and defaulted it to `spawnCapture`, then
    // called `spawnCapture` DIRECTLY on the local-mode branch — so a caller-supplied
    // instrumented or credentialed runner was silently dropped on half the paths the
    // signature promises it for (Argus r4). Harmless today only because local mode
    // reads a local ref; a signature that lies on one branch is a trap for the next
    // caller. Proven the same way as the pr-mode probe above: a real `git` on PATH
    // that records whether the runner's env arrived.
    await priorRun({ findings: FINDINGS })
    const shimDir = join(tmp, 'git-shim-local')
    mkdirSync(shimDir)
    const gitPath = join(shimDir, 'git')
    const observed = join(tmp, 'git-config-count-local')
    const argv = join(tmp, 'git-argv-local')
    writeFileSync(
      gitPath,
      `#!/bin/sh\n` +
        `printf '%s\\n' "$*" >> "${argv}"\n` +
        `case "$*" in\n` +
        `  *rev-parse*refs/heads/*)\n` +
        `    printf '%s' "\${GIT_CONFIG_COUNT:-ABSENT}" > "${observed}"\n` +
        `    printf '%s\\n' "${HEAD}"\n` +
        `    ;;\n` +
        `esac\n` +
        `exit 0\n`,
    )
    chmodSync(gitPath, 0o755)
    const oldPath = process.env['PATH']
    process.env['PATH'] = `${shimDir}:${oldPath ?? ''}`
    let result
    try {
      result = await dispatchBoardBoundBuild(
        { task: TASK, board_item_id: 'ready' },
        {
          store,
          board,
          project_slug: 'proj-1',
          repo_path: tmp,
          resolveBuildRepo: async () => tmp,
          resolveMergeMode: async () => 'local',
          resolveRalph: async () => false,
          landedProbe: async () => null,
          owner_handle: 'owner',
          secretsStore: { get: async () => 'test-sentinel-token-abc' },
        },
      )
    } finally {
      process.env['PATH'] = oldPath
    }

    // The read really was the LOCAL one…
    expect(readFileSync(argv, 'utf8')).toContain(`rev-parse --verify --quiet refs/heads/${BRANCH}`)
    // …and it went through the injected runner, which carries the env
    // (`githubProcessEnv` sets GIT_CONFIG_COUNT=1). 'ABSENT' is what the bare
    // `spawnCapture` call produced.
    expect(readFileSync(observed, 'utf8')).toBe('1')
    // POSITIVE CONTROL: the env assertion is worth nothing if no seed happened.
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(store.get(result.run.id)!.inner_checkpoint).toBe('forge-done')
  })

  test('a forge-done prior on an UNCHANGED tip seeds checkpoint, head, findings and BASE', async () => {
    await priorRun({ findings: FINDINGS, pr: 7 })

    const { result, tipReads } = await dispatchSeeding(async () => HEAD)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.inner_checkpoint).toBe('forge-done')
    expect(result.run.inner_checkpoint_head).toBe(HEAD)
    expect(result.run.inner_checkpoint_findings).toBe(FINDINGS)
    // THE BASE PIN TRAVELS. A seeded checkpoint makes `launch()`'s `freshLaunch`
    // false, so this row will never be re-pinned — without carrying the prior run's
    // base the publish-time "not cut from origin/<base>" refusal, which is gated on
    // `base_sha !== null`, could never fire for a salvaged run.
    expect(result.run.base_sha).toBe(BASE)
    expect(store.get(result.run.id)?.base_sha).toBe(BASE)
    // THE PR DOES NOT TRAVEL. `launch()` reads `run.pr ?? detectExistingPr(run)`, so
    // a carried number short-circuits that probe — onto a PR that may since have been
    // CLOSED. Asking gh for the branch's OPEN PRs is the question actually being asked.
    expect(result.run.pr).toBeNull()
    // No verdict travels with the evidence — the run is going TO review.
    expect(result.run.inner_verdict).toBeNull()
    // `bound_pr` means review-only-never-publish; the seed must not set it.
    expect(result.run.bound_pr).toBeNull()
    // Persisted, not just returned: `launch()` reads the row.
    expect(store.get(result.run.id)?.inner_checkpoint).toBe('forge-done')
    // `forge-done` names no round, so the seed stays at a fresh run's 1.
    expect(result.run.round).toBe(1)
    // The read is against THIS card's branch, in the RESOLVED build repo.
    expect(tipReads).toEqual([[tmp, BRANCH]])
  })

  test("a card BOUND TO A DIFFERENT RUN does not inherit that run's commit, byte-identical task text and all", async () => {
    // The identity hole in the task-text comparison: `slugifyTask` truncates at 35
    // characters, so two cards can share a branch, and two cards CAN carry the same
    // full text — at which point the second one adopts the first one's unreviewed
    // commit and sends it to review under the wrong title. Since #340 the terminal
    // reconcile KEEPS `linked_run_id` on failure, so a card that really did produce
    // that run still names it; a card naming a DIFFERENT run is a different card.
    const prior = await priorRun({ findings: FINDINGS })
    const otherCard: TridentBoardBinder = {
      ...board,
      get: () => ({
        id: 'ready',
        title: 'wire the CSV export button to the new endpoint with tests',
        design_doc_ref: null,
        linked_run_id: 'some-other-run',
      }),
    }

    const result = await dispatchBoardBoundBuild(
      { task: TASK, board_item_id: 'ready' },
      { ...localDeps(otherCard), readBranchTip: async () => HEAD },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // A FRESH dispatch: no checkpoint, no head, no findings, no base pin adopted
    // from a run this card cannot show it owns.
    expect(result.run.inner_checkpoint).toBeNull()
    expect(result.run.inner_checkpoint_head).toBeNull()
    expect(result.run.inner_checkpoint_findings).toBeNull()
    expect(result.run.base_sha).toBeNull()
    expect(result.run.id).not.toBe(prior.id)
  })

  test('POSITIVE CONTROL: the SAME card, naming that very run, still seeds', async () => {
    // Without this the test above would pass on a seed that had simply stopped
    // working. The link is checked, not merely required to be absent.
    const prior = await priorRun({ findings: FINDINGS })
    const sameCard: TridentBoardBinder = {
      ...board,
      get: () => ({
        id: 'ready',
        title: 'wire the CSV export button to the new endpoint with tests',
        design_doc_ref: null,
        linked_run_id: prior.id,
      }),
    }

    const result = await dispatchBoardBoundBuild(
      { task: TASK, board_item_id: 'ready' },
      { ...localDeps(sameCard), readBranchTip: async () => HEAD },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.inner_checkpoint).toBe('forge-done')
    expect(result.run.inner_checkpoint_findings).toBe(FINDINGS)
    expect(result.run.base_sha).toBe(BASE)
  })

  test('a card carrying NO LINK AT ALL does not seed — absent, null and whitespace-only all fail closed', async () => {
    // THE BOUNDARY THE LINK CHECK USED TO LEAVE OPEN (Argus r1 blocker, codex veto).
    // An absent link used to fall back to the task-text comparison alone, so a
    // BRAND-NEW card with byte-identical text inherited another card's checkpoint,
    // head, findings and base pin — the plan claimed it could not, and it could.
    // Every no-link shape the binder can produce is enumerated here, because the
    // field is optional (absent), nullable (null) and free text (whitespace).
    //
    // ONE CARD PER SHAPE, like the ralph suite below: `latestTerminalBySlug` orders
    // by `started_at DESC, id DESC`, and same-second rows tie-break on a random id,
    // so reusing one slug would read whichever prior happened to sort first.
    const linkShapes: Array<[string, string, string | null | undefined]> = [
      ['absent', 'link boundary card with no link at all', undefined],
      ['null', 'link boundary card whose link is null', null],
      ['whitespace only', 'link boundary card whose link is blank', '   '],
      ['a tab', 'link boundary card whose link is a tab', '\t'],
    ]
    for (const [name, task, link] of linkShapes) {
      await priorRun({ task, findings: FINDINGS })
      const card: TridentBoardBinder = {
        ...board,
        get: () => ({
          id: 'ready',
          title: 'wire the CSV export button to the new endpoint with tests',
          design_doc_ref: null,
          ...(link === undefined ? {} : { linked_run_id: link }),
        }),
      }

      const result = await dispatchBoardBoundBuild(
        { task, board_item_id: 'ready' },
        { ...localDeps(card), readBranchTip: async () => HEAD },
      )

      expect(result.ok).toBe(true)
      if (!result.ok) return
      // The FRESH dispatch, field for field: nothing of the prior run adopted.
      expect({ [name]: result.run.inner_checkpoint }).toEqual({ [name]: null })
      expect({ [name]: result.run.inner_checkpoint_head }).toEqual({ [name]: null })
      expect({ [name]: result.run.inner_checkpoint_findings }).toEqual({ [name]: null })
      expect({ [name]: result.run.base_sha }).toEqual({ [name]: null })
    }

    // POSITIVE CONTROL, same prior shape and same tip, with the link present: it
    // seeds. Without this every assertion above would pass on a seed that had simply
    // stopped working for all inputs.
    const CONTROL = 'link boundary card that names its run'
    const prior = await priorRun({ task: CONTROL, findings: FINDINGS })
    const linked: TridentBoardBinder = {
      ...board,
      get: () => ({
        id: 'ready',
        title: 'wire the CSV export button to the new endpoint with tests',
        design_doc_ref: null,
        linked_run_id: `  ${prior.id}  `, // and it is TRIMMED, not compared raw
      }),
    }
    const seeded = await dispatchBoardBoundBuild(
      { task: CONTROL, board_item_id: 'ready' },
      { ...localDeps(linked), readBranchTip: async () => HEAD },
    )
    expect(seeded.ok).toBe(true)
    if (!seeded.ok) return
    expect(seeded.run.inner_checkpoint).toBe('forge-done')
    expect(seeded.run.inner_checkpoint_findings).toBe(FINDINGS)
    expect(seeded.run.base_sha).toBe(BASE)
  })

  test('a fix-round prior seeds too, and an uppercase tip still matches', async () => {
    await priorRun({ checkpoint: 'fix-round-3', verdict: null })

    const { result } = await dispatchSeeding(async () => `${HEAD.toUpperCase()}\n`)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.inner_checkpoint).toBe('fix-round-3')
    expect(result.run.inner_checkpoint_head).toBe(HEAD)
    // A seeded row is BORN on the round its seeded checkpoint records — it is
    // resuming round 3's work, not starting round 1 over.
    expect(result.run.round).toBe(3)
  })

  test('an outer-published prior seeds the head embedded in the checkpoint NAME', async () => {
    await priorRun({
      checkpoint: `outer-published:${HEAD}:0:1`,
      head: null,
      pr: 512,
    })

    const { result } = await dispatchSeeding(async () => HEAD)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.inner_checkpoint).toBe(`outer-published:${HEAD}:0:1`)
    expect(result.run.inner_checkpoint_head).toBe(HEAD)
    // Still no PR, even though the prior run had published one: the resumed run
    // asks gh which PRs are OPEN on the branch instead of inheriting a number that
    // may since have been closed.
    expect(result.run.pr).toBeNull()
  })

  /**
   * THE RALPH DRIFT. `resumeOnUnchangedHead` (inner-workflow.mjs) answers
   * `{ mode: 'rebuild', reason: 'ralph-progress-unknown' }` for a bare `forge-done`
   * when the run is a ralph run — that iteration built ONE task and handed back, so
   * the next must plan and build the next task. Seeding it anyway would strip the
   * launcher's leftover-branch guard and its base pin off a run the workflow then
   * rebuilds regardless: all of the cost of resuming, none of the saving. And ralph
   * is the LIVE default on any repo with a root SPEC.md, which this one has.
   */
  test('RALPH: a bare forge-done prior seeds NOTHING; a fix-round prior still does', async () => {
    // Three separate cards, so each dispatch reads exactly the prior row it was
    // given rather than whichever of a chain of same-slug rows sorted first.
    const seedFor = async (task: string, checkpoint: string, ralph: boolean) => {
      await priorRun({ task, checkpoint, findings: FINDINGS })
      const { result } = await dispatchSeeding(async () => HEAD, { task, ralph })
      expect(result.ok).toBe(true)
      return result.ok ? result.run : null
    }

    const ralphed = await seedFor('ralph card built one task only', 'forge-done', true)
    expect(ralphed?.inner_checkpoint).toBeNull()
    expect(ralphed?.base_sha).toBeNull()

    // POSITIVE CONTROL, same checkpoint and same tip, ralph off: it seeds. Without
    // this the assertion above would pass on a seed that was simply broken.
    const plain = await seedFor('non ralph card built one task only', 'forge-done', false)
    expect(plain?.inner_checkpoint).toBe('forge-done')

    // …and `fix-round-N`, which the workflow reviews in BOTH modes, is untouched by ralph.
    const fixed = await seedFor('ralph card already fixed a round', 'fix-round-2', true)
    expect(fixed?.inner_checkpoint).toBe('fix-round-2')
  })

  /**
   * THE SLUG IS NOT AN IDENTITY. `slugifyTask` truncates at 35 characters, so two
   * DIFFERENT cards can share a slug — and therefore share `trident/<slug>`. Without
   * a seed the collision is caught downstream by the leftover-branch refusal. A
   * seeded row still RUNS that guard, but passes it by construction: the seed
   * carries the prior run's base pin and the colliding tip descends from it, which
   * is exactly what `ownCrashLeftover` reads as "own leftover". So only the
   * task-text comparison stops the second card from silently adopting the FIRST
   * card's unreviewed commit and sending it to review under the wrong title. The
   * head-equality probe cannot see it either: on a collision the branch genuinely
   * does hold the prior run's commit.
   */
  test('a DIFFERENT card that collides on the truncated slug never inherits its seed', async () => {
    const PREFIX = 'throughput blocker trident dispatch'
    const CARD_A = `${PREFIX} seeds the wrong card`
    const CARD_B = `${PREFIX} holds a path forever`
    // Precondition, asserted rather than assumed: these really do collide.
    expect(slugifyTask(CARD_B)).toBe(slugifyTask(CARD_A))
    expect(CARD_B).not.toBe(CARD_A)

    await priorRun({ task: CARD_A, findings: FINDINGS })

    // POSITIVE CONTROL FIRST: card A's own re-dispatch, against that prior row and
    // this branch tip, DOES seed — so the refusal below is the task-text comparison
    // talking, not the seed being broken for everything.
    const { result: same } = await dispatchSeeding(async () => HEAD, { task: CARD_A })
    expect(same.ok).toBe(true)
    if (!same.ok) return
    expect(same.run.inner_checkpoint).toBe('forge-done')
    // Retire it: card A's latest terminal run is now itself built-never-reviewed on
    // exactly this head, which is the strongest possible bait for card B. `failed`,
    // not `stopped` — a stopped row never seeds at all, so retiring it that way
    // would defang the bait and let the refusal below pass without the task-text
    // comparison doing any work.
    await store.update(same.run.id, { phase: 'failed' })
    // And point the card's link AT THE BAIT, so the link check cannot be what refuses
    // below. The task-text comparison has to do the work on its own, which is the
    // whole claim of this test.
    cardLink = same.run.id

    const { result: other } = await dispatchSeeding(async () => HEAD, { task: CARD_B })
    expect(other.ok).toBe(true)
    if (!other.ok) return
    expect(other.run.inner_checkpoint).toBeNull()
    expect(other.run.inner_checkpoint_head).toBeNull()
    expect(other.run.inner_checkpoint_findings).toBeNull()
    expect(other.run.base_sha).toBeNull()
  })

  /**
   * THE MUTANT GUARD. Delete the head-equality comparison in `board-dispatch.ts`
   * and this test goes RED: the chokepoint would hand a resume checkpoint — and
   * with it the launcher's leftover-branch refusal — to a branch that no longer
   * holds the commit the prior run recorded. Every field is asserted equal to a
   * control dispatch that had no prior run at all, so "seeded with something
   * harmless" cannot pass either.
   */
  test('MUTANT GUARD: a MOVED tip seeds nothing — byte-identical to a no-prior dispatch', async () => {
    await priorRun({ findings: FINDINGS, pr: 7 })
    const { result: moved } = await dispatchSeeding(async () => MOVED)
    expect(moved.ok).toBe(true)
    if (!moved.ok) return

    // Control: a different card with no history whatsoever.
    const control = await dispatchBoardBoundBuild(
      { task: 'build a different thing entirely', board_item_id: 'ready' },
      localDeps(),
    )
    expect(control.ok).toBe(true)
    if (!control.ok) return

    for (const run of [moved.run, control.run]) {
      expect(run.inner_checkpoint).toBeNull()
      expect(run.inner_checkpoint_head).toBeNull()
      expect(run.inner_checkpoint_findings).toBeNull()
      expect(run.pr).toBeNull()
    }
  })

  test('an unreadable or absent ref seeds nothing and still dispatches', async () => {
    await priorRun({})
    const { result: empty } = await dispatchSeeding(async () => '')
    expect(empty.ok).toBe(true)
    if (!empty.ok) return
    expect(empty.run.inner_checkpoint).toBeNull()
  })

  test('a THROWING tip probe never blocks the dispatch', async () => {
    await priorRun({})
    const { result } = await dispatchSeeding(async () => {
      throw new Error('git exploded')
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.inner_checkpoint).toBeNull()
  })

  test('a probe that throws SYNCHRONOUSLY (non-async) degrades to no evidence instead of escaping', async () => {
    // The .catch-only form attached its handler to a promise the probe never
    // returned: a NON-async function that throws does so at the CALL, and the
    // exception escaped dispatchBoardBoundBuild entirely (Argus r7, reproduced).
    // The async-thrower test above cannot see this — an async wrapper converts
    // the throw into a rejection. This one hands the dep in DIRECTLY, un-wrapped.
    await priorRun({})
    let probeReached = false
    const result = await dispatchBoardBoundBuild(
      { task: TASK, board_item_id: 'ready' },
      {
        ...localDeps(),
        readBranchTip: () => {
          probeReached = true
          throw new Error('sync exploded')
        },
      },
    )
    expect(probeReached).toBe(true) // not passing by never seeding at all
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.inner_checkpoint).toBeNull() // no evidence → fresh dispatch
  })

  test('a non-qualifying prior seeds nothing AND never pays for the git read', async () => {
    const shapes: Array<[string, Parameters<typeof priorRun>[0]]> = [
      [
        'reviewed and rejected',
        { verdict: 'REQUEST_CHANGES', findings: '[{"title":"a real finding"}]' },
      ],
      ['approved and done', { phase: 'done', verdict: 'APPROVE', checkpoint: 'argus-approved' }],
      ['died before the build', { checkpoint: 'inner-error' }],
      ['no recorded head', { head: null }],
    ]
    for (const [name, shape] of shapes) {
      const prior = await priorRun(shape)
      const { result, tipReads } = await dispatchSeeding(async () => HEAD)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect({ [name]: result.run.inner_checkpoint }).toEqual({ [name]: null })
      expect({ [name]: result.run.pr }).toEqual({ [name]: null })
      // The git read is paid ONLY when a qualifying seed already exists.
      expect({ [name]: tipReads }).toEqual({ [name]: [] })
      // Clear the way for the next shape: only one LIVE row per (project, slug).
      await store.update(result.run.id, { phase: 'stopped' })
      await store.update(prior.id, { phase: 'stopped', inner_verdict: null, inner_checkpoint: 'inner-error' })
    }
  })

  test('PR MODE: the proof is taken against the ref the LAUNCH will read, not the local one', async () => {
    // THE BLOCKER THIS CLOSES. `resolveResumeLiveHead` (orchestrator.ts) reads
    // `git ls-remote --heads origin` in pr mode, so a dispatch-time proof against
    // the LOCAL ref proves nothing about the resume the workflow will actually
    // perform. The mode therefore travels to the reader, which picks the ref.
    await priorRun({ findings: FINDINGS })
    const { result, tipModes } = await dispatchSeeding(async () => HEAD, { merge_mode: 'pr' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(tipModes).toEqual(['pr'])
    // With the REMOTE tip matching, an `outer-published`-class prior still seeds.
    expect(result.run.inner_checkpoint).toBe('forge-done')

    // …and the local-mode dispatch asks for the local ref. Retired to `failed`, not
    // `stopped`: `stopped` is an operator cancel and never seeds, which would make
    // the next dispatch skip the tip read for the wrong reason.
    await store.update(result.run.id, { phase: 'failed' })
    // The card now names THAT row — the seed fails closed without a link, and the
    // point of this assertion is which ref the probe reads, not the link check.
    cardLink = result.run.id
    const local = await dispatchSeeding(async () => HEAD, { merge_mode: 'local' })
    expect(local.tipModes).toEqual(['local'])
  })

  test('PR MODE: a forge-done prior with NO origin branch seeds nothing — the workflow would rebuild it', async () => {
    // Forge is told "do NOT push" in pr mode (`forgePushStep`), so a run that died
    // at `forge-done` has its commit only locally: `ls-remote` is empty,
    // `classifyResume` answers head-branch-absent and REBUILDS. Seeding that row
    // would strip the leftover-branch guard and the base re-pin off a run that
    // gets rebuilt anyway — the seed's whole cost for none of its saving.
    await priorRun({ findings: FINDINGS })
    const { result } = await dispatchSeeding(async () => '', { merge_mode: 'pr' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.inner_checkpoint).toBeNull()
    expect(result.run.inner_checkpoint_head).toBeNull()
    // The base pin is NOT seeded either: this is the byte-identical fresh dispatch,
    // which `launch()` re-pins with the leftover-branch guard armed.
    expect(result.run.base_sha).toBeNull()
    expect(store.get(result.run.id)?.inner_checkpoint).toBeNull()
  })

  test('an UNPINNED prior seeds nothing: a seeded row can never acquire a base pin', async () => {
    // `launch()` re-pins only on a fresh build (`inner_checkpoint === null &&
    // base_sha === null`). A seed carrying a null pin would create a row pinned
    // never, leaving the publish-time cut-from-origin refusal (gated on
    // `base_sha !== null`) permanently inert for it and every re-seed off it.
    await priorRun({ findings: FINDINGS, base_sha: null })
    const { result, tipReads } = await dispatchSeeding(async () => HEAD)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.run.inner_checkpoint).toBeNull()
    expect(result.run.base_sha).toBeNull()
    // Refused before the git read — there was never anything worth proving.
    expect(tipReads).toEqual([])
  })

  test('the already-landed refusal still fires FIRST, before any seed logic', async () => {
    await priorRun({ findings: FINDINGS, pr: 7 })
    const tipReads: string[] = []
    const result = await dispatchBoardBoundBuild(
      { task: TASK, board_item_id: 'ready' },
      {
        ...localDeps(),
        resolveMergeMode: async () => 'pr',
        landedProbe: async () => ({ pr: 336, merged_at: '2026-08-30T00:00:00Z', head_on_base: true, base: 'main' }),
        readBranchTip: async (_repo, branch) => {
          tipReads.push(branch)
          return HEAD
        },
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('already_landed')
    expect(tipReads).toEqual([])
  })
})
