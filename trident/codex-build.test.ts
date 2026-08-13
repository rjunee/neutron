/**
 * `trident/codex-build.sh` — the BUILD-on-codex wrapper, verified BEHAVIORALLY by
 * spawning it against a REAL temporary git repository with a mocked `codex` and `gh`
 * on PATH.
 *
 * TWO CONTRACTS ARE UNDER TEST, and the second is the one that is new.
 *
 * 1. THE EXIT-CODE MAPPING the bridge in `inner-workflow.mjs` reads:
 *      0   built         — codex ran to completion
 *      10  not_connected — no CODEX_HOME / no auth.json
 *      11  not_connected — no codex CLI
 *      3   deferred      — auth precheck failed, or no brief was handed in
 *      5   deferred      — codex ran and exited non-zero
 *
 * 2. THE MEASURED TRAILER. A Claude Forge agent reports its own branch/sha/PR through
 *    a result schema; a `codex exec` subprocess has no schema tool, so the naive port
 *    would ask the model to print them — and the case that matters is exactly the one
 *    where the model believes it committed and did not. So the wrapper measures them
 *    with `git`/`gh` after codex exits. These tests drive a real repo into each state
 *    (committed, unpushed, no diff written, codex failed) and assert the trailer tells
 *    the truth about it, because everything downstream — `roundLanded`, and the
 *    `--match-head-commit` merge pin — is only as honest as these six lines.
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'codex-build.sh')
// Spawn bash by ABSOLUTE path: the CLI-absent case runs with a PATH containing only
// the mock bin, so `bash` could not be resolved from it.
const BASH = existsSync('/bin/bash') ? '/bin/bash' : '/usr/bin/bash'

interface RunOpts {
  /** Write an auth.json into CODEX_HOME (the "configured" case). */
  authed?: boolean
  /** Don't set CODEX_HOME at all. */
  noCodexHome?: boolean
  /** Mock `codex` on PATH whose `login status` exits with this code. null → no CLI. */
  codexLoginExit?: number | null
  /** The brief handed in. `null` → no brief file at all. */
  brief?: string | null
  /** Content for the diff file the brief was told to write. `null` → never written. */
  diff?: string | null
  /** Make the git repo have a commit (the built case). Default true. */
  commit?: boolean
  /** What the mock `gh pr list` prints for the PR number. */
  ghPr?: string
  env?: Record<string, string>
  /** Extra argv for the script (defaults to the branch name). */
  branch?: string
}

const DEFAULT_BRIEF = 'You are FORGE. Build the thing on branch trident/a-run.\n'

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
  /** argv the mock `codex` received ('' if never run). */
  codexArgv: string
  /** the BRIEF the mock `codex` received on stdin ('' if never run). */
  codexStdin: string
  /** the trailer parsed into a map, from the tail of stdout. */
  trailer: Record<string, string>
  /** the real HEAD sha of the temp repo, for comparison. */
  head: string
  dir: string
}

function parseTrailer(stdout: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const m = /^(NEUTRON_CODEX_BUILD_[A-Z_]+)=(.*)$/.exec(line)
    if (m !== null) out[m[1]!] = m[2]!
  }
  return out
}

function run(opts: RunOpts = {}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'trident-codex-build-'))
  const codexHome = join(dir, 'codexhome')
  mkdirSync(codexHome, { recursive: true })
  if (opts.authed === true) writeFileSync(join(codexHome, 'auth.json'), '{"token":"x"}\n')

  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const path = opts.codexLoginExit === null ? bin : `${bin}${delimiter}/usr/bin${delimiter}/bin`

  if (opts.codexLoginExit !== null && opts.codexLoginExit !== undefined) {
    const mock = join(bin, 'codex')
    writeFileSync(
      mock,
      `#!/bin/sh\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then exit ${opts.codexLoginExit}; fi\nprintf '%s\\n' "$@" > ${JSON.stringify(join(dir, 'codex-argv.txt'))}\ncat > ${JSON.stringify(join(dir, 'codex-stdin.txt'))}\nexit 0\n`,
    )
    chmodSync(mock, 0o755)
  }
  // A mock `gh` ALWAYS, so the PR probe is deterministic — the build host may well
  // have a real `gh` that would answer about a real repository.
  const gh = join(bin, 'gh')
  writeFileSync(
    gh,
    opts.ghPr === undefined
      ? '#!/bin/sh\nexit 1\n'
      : `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(opts.ghPr)}\nexit 0\n`,
  )
  chmodSync(gh, 0o755)

  // A REAL git repo, because the trailer's whole job is to measure one.
  const branch = opts.branch ?? 'trident/a-run'
  const git = (...args: string[]): void => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  }
  git('init', '-q', '-b', branch)
  git('config', 'user.email', 'build@localhost')
  git('config', 'user.name', 'build')
  let head = ''
  if (opts.commit !== false) {
    writeFileSync(join(dir, 'file.txt'), 'built\n')
    git('add', 'file.txt')
    git('commit', '-q', '-m', 'the build')
    head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
  }

  const env: Record<string, string> = {
    PATH: path,
    HOME: dir,
    NEUTRON_CODEX_AUTH_RETRY_DELAY: '0',
    ...(opts.env ?? {}),
  }
  if (opts.noCodexHome !== true) env['CODEX_HOME'] = codexHome
  const brief = opts.brief === undefined ? DEFAULT_BRIEF : opts.brief
  if (brief !== null) {
    const bf = join(dir, 'build.brief')
    writeFileSync(bf, brief)
    env['NEUTRON_CODEX_BUILD_BRIEF_FILE'] = bf
  }
  const diff = opts.diff === undefined ? 'diff --git a/x b/x\n+change\n' : opts.diff
  const diffFile = join(dir, 'branch.diff')
  if (diff !== null) writeFileSync(diffFile, diff)
  env['NEUTRON_CODEX_BUILD_DIFF_FILE'] = diffFile

  const res = spawnSync(BASH, [SCRIPT, branch], { cwd: dir, encoding: 'utf8', env })
  const readOr = (name: string): string => {
    try {
      return readFileSync(join(dir, name), 'utf8')
    } catch {
      return ''
    }
  }
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    codexArgv: readOr('codex-argv.txt'),
    codexStdin: readOr('codex-stdin.txt'),
    trailer: parseTrailer(res.stdout ?? ''),
    head,
    dir,
  }
}

/** The seam that stands in for a successful `codex exec` without calling OpenAI. */
const FAKE_OK = 'cat >/dev/null; echo "I built it"'
const FAKE_FAIL = 'cat >/dev/null; echo "boom" >&2; exit 7'

describe('trident/codex-build.sh — exit-code contract', () => {
  test('no CODEX_HOME → exit 10 (not connected)', () => {
    const { status, stderr } = run({ noCodexHome: true })
    expect(status).toBe(10)
    expect(stderr).toContain('CODEX_BUILD_NOT_CONNECTED')
  })

  test('CODEX_HOME set but no auth.json → exit 10', () => {
    const { status, stderr } = run({ authed: false, codexLoginExit: 0 })
    expect(status).toBe(10)
    expect(stderr).toContain('CODEX_BUILD_NOT_CONNECTED')
  })

  test('configured but codex CLI absent → exit 11', () => {
    const { status, stderr } = run({ authed: true, codexLoginExit: null })
    expect(status).toBe(11)
    expect(stderr).toContain('CODEX_BUILD_NOT_CONNECTED')
  })

  test('configured but auth precheck fails → exit 3 (DEFERRED)', () => {
    const { status, stderr } = run({ authed: true, codexLoginExit: 1 })
    expect(status).toBe(3)
    expect(stderr).toContain('CODEX_BUILD_AUTH_EXPIRED')
  })

  test('NO BRIEF → exit 3, and codex is never launched', () => {
    // An empty prompt inside a real worktree with full write access is the one input
    // that must never reach the model: it would invent a task and commit it.
    const { status, stderr, codexStdin } = run({
      authed: true,
      codexLoginExit: 0,
      brief: null,
      env: { NEUTRON_CODEX_EXEC_CMD: FAKE_OK },
    })
    expect(status).toBe(3)
    expect(stderr).toContain('CODEX_BUILD_NO_BRIEF')
    expect(codexStdin).toBe('')
  })

  test('an EMPTY brief file is treated as no brief', () => {
    const { status, stderr } = run({ authed: true, codexLoginExit: 0, brief: '' })
    expect(status).toBe(3)
    expect(stderr).toContain('CODEX_BUILD_NO_BRIEF')
  })

  test('configured + authed + build runs → exit 0', () => {
    const { status, stdout } = run({
      authed: true,
      codexLoginExit: 0,
      env: { NEUTRON_CODEX_EXEC_CMD: FAKE_OK },
    })
    expect(status).toBe(0)
    expect(stdout).toContain('I built it')
  })

  test('codex exits non-zero → exit 5 (DEFERRED)', () => {
    const { status, stderr } = run({
      authed: true,
      codexLoginExit: 0,
      env: { NEUTRON_CODEX_EXEC_CMD: FAKE_FAIL },
    })
    expect(status).toBe(5)
    expect(stderr).toContain('CODEX_BUILD_CALL_FAILED')
  })
})

describe('the BRIEF is what codex is asked to build', () => {
  test('it arrives on STDIN, verbatim, and never as an argv entry', () => {
    // On stdin because a brief is kilobytes of contract text and a single argv entry
    // that large can exceed ARG_MAX and fail before codex starts.
    const brief = 'BUILD_BRIEF_MARKER_7f21\nwith a second line and an apostrophe: don’t\n'
    const { codexStdin, codexArgv } = run({
      authed: true,
      codexLoginExit: 0,
      brief,
    })
    expect(codexStdin).toBe(brief)
    expect(codexArgv).not.toContain('BUILD_BRIEF_MARKER_7f21')
  })

  test('the build model is PINNED, and overridable through CODEX_BUILD_MODEL', () => {
    const dflt = run({ authed: true, codexLoginExit: 0 })
    expect(dflt.codexArgv).toContain('--model\ngpt-5.6-sol')

    const pinned = run({
      authed: true,
      codexLoginExit: 0,
      env: { CODEX_BUILD_MODEL: 'gpt-5.6-terra' },
    })
    expect(pinned.codexArgv).toContain('--model\ngpt-5.6-terra')
    expect(pinned.codexArgv).not.toContain('gpt-5.6-sol')
  })

  test('an explicitly EMPTY CODEX_BUILD_MODEL falls back to the CLI default', () => {
    // `${VAR-x}` substitutes only when UNSET, so an empty value is a deliberate
    // "let codex choose" and not an accident to be overwritten.
    const { codexArgv } = run({
      authed: true,
      codexLoginExit: 0,
      env: { CODEX_BUILD_MODEL: '' },
    })
    expect(codexArgv).not.toContain('--model')
  })

  test('the sandbox grant is explicit — a build cannot commit or push without it', () => {
    const { codexArgv } = run({ authed: true, codexLoginExit: 0 })
    expect(codexArgv).toContain('--sandbox\ndanger-full-access')
    // …and codex is rooted in THIS worktree, not wherever it would infer a root.
    expect(codexArgv).toContain('--cd\n')
  })

  test('a metered API key is scrubbed before the build runs — subscription OAuth only', () => {
    // A build is far more tokens than a review, so an accidental metered key is
    // correspondingly more expensive. The CLI PREFERS OPENAI_API_KEY over the
    // persisted OAuth, so it has to be unset before codex is reached. The seam runs
    // in the script's own environment, which is what makes the scrub observable.
    const { stdout } = run({
      authed: true,
      codexLoginExit: 0,
      env: {
        OPENAI_API_KEY: 'sk-should-not-survive',
        NEUTRON_CODEX_EXEC_CMD: 'cat >/dev/null; printf "KEY=[%s]\\n" "${OPENAI_API_KEY:-}"',
      },
    })
    expect(stdout).toContain('KEY=[]')
    expect(stdout).not.toContain('sk-should-not-survive')
  })
})

describe('the trailer MEASURES the repository — it never repeats a claim', () => {
  test('a real commit is reported as the sha git actually holds', () => {
    const r = run({ authed: true, codexLoginExit: 0, env: { NEUTRON_CODEX_EXEC_CMD: FAKE_OK } })
    expect(r.status).toBe(0)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(r.head)
    expect(r.head.length).toBe(40)
    expect(r.trailer['NEUTRON_CODEX_BUILD_BRANCH']).toBe('trident/a-run')
    expect(r.trailer['NEUTRON_CODEX_BUILD_WORKTREE']).toBe(r.dir)
  })

  test('a repo with NO commit reports an empty sha rather than inventing one', () => {
    // The failure that matters: the model says it committed and did not. An empty
    // sha stops the run at the next gate; a plausible one would ship unreviewed.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      commit: false,
      env: { NEUTRON_CODEX_EXEC_CMD: FAKE_OK },
    })
    expect(r.status).toBe(0)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe('')
  })

  test('an UNPUSHED commit reports an empty REMOTE head', () => {
    // The temp repo has no origin, so nothing is pushed. In pr mode the bridge reads
    // the remote head, so this is what stops an unpushed build from being merged.
    const r = run({ authed: true, codexLoginExit: 0, env: { NEUTRON_CODEX_EXEC_CMD: FAKE_OK } })
    expect(r.trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe('')
    // …while the LOCAL head is populated, so the two are genuinely different
    // questions and the test is not passing because both happen to be empty.
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).not.toBe('')
  })

  test('a pushed commit reports the REMOTE head from the remote, not from HEAD', () => {
    const r = run({ authed: true, codexLoginExit: 0, env: { NEUTRON_CODEX_EXEC_CMD: FAKE_OK } })
    // Give the repo a real (bare, local) origin and push, then re-measure by running
    // the wrapper a second time in the same directory.
    const bare = join(r.dir, 'origin.git')
    spawnSync('git', ['init', '-q', '--bare', bare])
    spawnSync('git', ['remote', 'add', 'origin', bare], { cwd: r.dir })
    const push = spawnSync('git', ['push', '-q', 'origin', 'trident/a-run'], { cwd: r.dir })
    expect(push.status).toBe(0)
    const again = spawnSync(
      BASH,
      [SCRIPT, 'trident/a-run'],
      {
        cwd: r.dir,
        encoding: 'utf8',
        env: {
          PATH: `${join(r.dir, 'bin')}${delimiter}/usr/bin${delimiter}/bin`,
          HOME: r.dir,
          CODEX_HOME: join(r.dir, 'codexhome'),
          NEUTRON_CODEX_AUTH_RETRY_DELAY: '0',
          NEUTRON_CODEX_BUILD_BRIEF_FILE: join(r.dir, 'build.brief'),
          NEUTRON_CODEX_EXEC_CMD: FAKE_OK,
        },
      },
    )
    const trailer = parseTrailer(again.stdout ?? '')
    expect(trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe(r.head)
  })

  test('the PR number comes from gh, and a non-numeric answer is dropped', () => {
    const found = run({
      authed: true,
      codexLoginExit: 0,
      ghPr: '4321',
      env: { NEUTRON_CODEX_EXEC_CMD: FAKE_OK },
    })
    expect(found.trailer['NEUTRON_CODEX_BUILD_PR']).toBe('4321')

    // `gh --jq` prints the literal `null` for an empty list, and "null" reported as a
    // PR number is worse than no number at all.
    const none = run({
      authed: true,
      codexLoginExit: 0,
      ghPr: 'null',
      env: { NEUTRON_CODEX_EXEC_CMD: FAKE_OK },
    })
    expect(none.trailer['NEUTRON_CODEX_BUILD_PR']).toBe('')
  })

  test('the diff path is reported only when a NON-EMPTY diff actually exists', () => {
    const wrote = run({ authed: true, codexLoginExit: 0, env: { NEUTRON_CODEX_EXEC_CMD: FAKE_OK } })
    expect(wrote.trailer['NEUTRON_CODEX_BUILD_DIFF']).toContain('branch.diff')

    // Never written: the reviewers would be handed a path to nothing, and the codex
    // review lane treats an empty diff as DEFERRED — a confusing way to learn the
    // build did not write one.
    const missing = run({
      authed: true,
      codexLoginExit: 0,
      diff: null,
      env: { NEUTRON_CODEX_EXEC_CMD: FAKE_OK },
    })
    expect(missing.trailer['NEUTRON_CODEX_BUILD_DIFF']).toBe('')

    // Written but EMPTY is the same nothing.
    const empty = run({
      authed: true,
      codexLoginExit: 0,
      diff: '',
      env: { NEUTRON_CODEX_EXEC_CMD: FAKE_OK },
    })
    expect(empty.trailer['NEUTRON_CODEX_BUILD_DIFF']).toBe('')
  })

  test('the trailer is emitted on the FAILURE path too', () => {
    // A codex run that died after committing still left work on the branch, and the
    // operator recovering it needs to be told the sha. The exit code is what makes
    // the run stop; the trailer is what makes the stop diagnosable.
    const r = run({ authed: true, codexLoginExit: 0, env: { NEUTRON_CODEX_EXEC_CMD: FAKE_FAIL } })
    expect(r.status).toBe(5)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(r.head)
  })

  test('all six trailer keys are present on every path that ran codex', () => {
    // A missing key and an empty key read the same to a regex; the bridge is told to
    // copy six values, so six must always be there to copy.
    for (const cmd of [FAKE_OK, FAKE_FAIL]) {
      const r = run({ authed: true, codexLoginExit: 0, env: { NEUTRON_CODEX_EXEC_CMD: cmd } })
      expect(Object.keys(r.trailer).sort()).toEqual([
        'NEUTRON_CODEX_BUILD_BRANCH',
        'NEUTRON_CODEX_BUILD_DIFF',
        'NEUTRON_CODEX_BUILD_HEAD',
        'NEUTRON_CODEX_BUILD_PR',
        'NEUTRON_CODEX_BUILD_REMOTE_HEAD',
        'NEUTRON_CODEX_BUILD_WORKTREE',
      ])
    }
  })

  test('no trailer at all when codex never ran — nothing was measured', () => {
    // A trailer printed for a lane that never launched would let the bridge report a
    // sha for a build that did not happen.
    expect(run({ noCodexHome: true }).trailer).toEqual({})
    expect(run({ authed: true, codexLoginExit: 1 }).trailer).toEqual({})
    expect(run({ authed: true, codexLoginExit: 0, brief: null }).trailer).toEqual({})
  })
})
