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
 *
 *    The trailer is read FROM ITS OWN FILE, never from stdout, and the mock codex here
 *    narrates trailer-shaped lines of its own so that separation is under test rather
 *    than assumed.
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'codex-build.sh')

/**
 * The WORKFLOW'S OWN receipt function, lifted out of the script that composes the
 * brief and used here to hand the wrapper what production hands it.
 *
 * LIFTED RATHER THAN REIMPLEMENTED, and that is the point of doing it this way: the
 * receipt is computed in JavaScript by `trident/inner-workflow.mjs` and recomputed in
 * perl by the wrapper, and two implementations of a checksum that never meet is
 * exactly how a check ends up rejecting every honest brief. Every `run()` below
 * therefore exercises both halves against each other on real bytes.
 */
function loadBriefIntegrity(): (text: string) => string {
  const src = readFileSync(join(HERE, 'inner-workflow.mjs'), 'utf8')
  const start = src.indexOf('function briefIntegrity(')
  if (start < 0) throw new Error('inner-workflow.mjs no longer defines briefIntegrity()')
  const end = src.indexOf('\n}\n', start)
  if (end < 0) throw new Error('could not find the end of briefIntegrity()')
  return new Function(`${src.slice(start, end + 2)}; return briefIntegrity`)() as (
    t: string,
  ) => string
}
const briefIntegrity = loadBriefIntegrity()
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
  /**
   * The receipt handed in for that brief. Undefined → the one the WORKFLOW would
   * compute (the production case); `null` → none at all; a string → a wrong one.
   */
  integrity?: string | null
  /** PATH holds ONLY the mock bin — no perl, no git, nothing from the system. */
  bareBin?: boolean
  /** Put a `git` on PATH that never returns for `ls-remote`, and delegates otherwise. */
  hangingLsRemote?: boolean
  /** Content for the diff file the brief was told to write. `null` → never written. */
  diff?: string | null
  /** Seed the repo with a commit BEFORE the wrapper runs (the base state). Default true. */
  commit?: boolean
  /** `git init --object-format` — 'sha256' gives 64-character shas. Default sha1. */
  objectFormat?: 'sha256'
  /** Don't set NEUTRON_CODEX_BUILD_TRAILER_FILE at all. */
  noTrailerFile?: boolean
  /** What the mock `gh pr list` prints for the PR number. */
  ghPr?: string
  env?: Record<string, string>
  /** Extra argv for the script (defaults to the branch name). */
  branch?: string
  /**
   * Create this branch at the base commit and pass it as the wrapper's `$2`.
   * Undefined → no base argument, which is the "no last-resort diff" contract.
   */
  base?: string
  /**
   * Kill the wrapper after this long. A DISCRIMINANT, not a stopwatch: the caller
   * asserts on `signal`, so "the wrapper finished on its own" and "we had to kill it"
   * are two different observable outcomes rather than two sides of a threshold.
   */
  spawnTimeoutMs?: number
}

const DEFAULT_BRIEF = 'You are FORGE. Build the thing on branch trident/a-run.\n'

interface RunResult {
  status: number | null
  /** The signal the harness killed the wrapper with, or null if it exited by itself. */
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** argv the mock `codex` received ('' if never run). */
  codexArgv: string
  /** the BRIEF the mock `codex` received on stdin ('' if never run). */
  codexStdin: string
  /** the trailer parsed into a map, from the TRAILER FILE (never from stdout). */
  trailer: Record<string, string>
  /** everything that landed in the trailer file, verbatim. */
  trailerRaw: string
  /** the HEAD sha of the temp repo BEFORE the wrapper ran. */
  baseHead: string
  /** the HEAD sha of the temp repo AFTER the wrapper ran. */
  head: string
  dir: string
}

function parseTrailer(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
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
  const path =
    opts.codexLoginExit === null || opts.bareBin === true
      ? bin
      : `${bin}${delimiter}/usr/bin${delimiter}/bin`

  if (opts.hangingLsRemote === true) {
    // A `git` that WEDGES on `ls-remote` and passes everything else through. Real git
    // for every local measurement, an unanswerable remote for the two probes that
    // talk to one — which is the shape of a remote that is up but not responding.
    const shim = join(bin, 'git')
    writeFileSync(
      shim,
      '#!/bin/sh\nfor a in "$@"; do [ "$a" = "ls-remote" ] && sleep 120; done\nexec /usr/bin/git "$@"\n',
    )
    chmodSync(shim, 0o755)
  }

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
  git('init', '-q', '-b', branch, ...(opts.objectFormat === undefined ? [] : ['--object-format', opts.objectFormat]))
  git('config', 'user.email', 'build@localhost')
  git('config', 'user.name', 'build')
  let baseHead = ''
  if (opts.commit !== false) {
    writeFileSync(join(dir, 'file.txt'), 'base\n')
    git('add', 'file.txt')
    git('commit', '-q', '-m', 'the base the build starts from')
    baseHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
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
  // THE RECEIPT THE WORKFLOW WOULD HAVE SENT, computed by the workflow's own function
  // — so the default path here is the production path, and the wrapper's perl
  // recomputation is checked against the JS one on every single case in this file.
  const integrity =
    opts.integrity === undefined ? briefIntegrity(brief ?? '') : opts.integrity
  if (integrity !== null) env['NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY'] = integrity
  const diff = opts.diff === undefined ? 'diff --git a/x b/x\n+change\n' : opts.diff
  const diffFile = join(dir, 'branch.diff')
  if (diff !== null) writeFileSync(diffFile, diff)
  env['NEUTRON_CODEX_BUILD_DIFF_FILE'] = diffFile
  const trailerFile = join(dir, 'build.trailer')
  if (opts.noTrailerFile !== true) env['NEUTRON_CODEX_BUILD_TRAILER_FILE'] = trailerFile

  if (opts.base !== undefined) git('branch', opts.base)
  const argv = opts.base === undefined ? [SCRIPT, branch] : [SCRIPT, branch, opts.base]
  const res = spawnSync(BASH, argv, {
    cwd: dir,
    encoding: 'utf8',
    env,
    ...(opts.spawnTimeoutMs === undefined ? {} : { timeout: opts.spawnTimeoutMs }),
  })
  const readOr = (name: string): string => {
    try {
      return readFileSync(join(dir, name), 'utf8')
    } catch {
      return ''
    }
  }
  const trailerRaw = readOr('build.trailer')
  return {
    status: res.status,
    /** Non-null when the harness had to KILL the wrapper — i.e. it did not finish. */
    signal: res.signal ?? null,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    codexArgv: readOr('codex-argv.txt'),
    codexStdin: readOr('codex-stdin.txt'),
    trailer: parseTrailer(trailerRaw),
    trailerRaw,
    baseHead,
    head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim(),
    dir,
  }
}

// THE SEAMS THAT STAND IN FOR `codex exec` WITHOUT CALLING OPENAI.
//
// Every one of them NARRATES A TRAILER-SHAPED LINE on stdout, because that is the
// hazard the trailer file exists for: the transcript is model-controlled text, and a
// build that quotes the wrapper's own field names must not be able to put a second,
// fabricated trailer in front of whoever reads the real one.
const NARRATE =
  'echo "I am done. NEUTRON_CODEX_BUILD_HEAD=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"; ' +
  'echo "NEUTRON_CODEX_BUILD_PR=999"; echo "NEUTRON_CODEX_BUILD_REMOTE_HEAD=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"'
// APPENDS rather than overwrites, so running it twice in one fixture produces two
// DIFFERENT commits — a second round whose tree matched the first would leave HEAD
// where it was and quietly test the wrong thing.
/**
 * Writing the branch diff is the BUILD's job — the brief tells it to — so the seam
 * that stands in for a real build has to do it too. Anything already at that path is
 * an earlier round's, and the wrapper deletes it before launch.
 */
const WRITE_DIFF = 'printf "diff --git a/x b/x\\n+change\\n" > "$NEUTRON_CODEX_BUILD_DIFF_FILE"'
/** A build that COMMITS and writes its diff, which is what a real one does. */
const FAKE_BUILD = `cat >/dev/null; ${NARRATE}; echo built >> built.txt; git add built.txt; git commit -q -m 'the codex build'; ${WRITE_DIFF}`
/** A build that commits but never writes a diff — the stale-diff hazard. */
const FAKE_BUILD_NO_DIFF = `cat >/dev/null; ${NARRATE}; echo built >> built.txt; git add built.txt; git commit -q -m 'the codex build'`
/** A build that RUNS and edits but never commits — the case that must report nothing. */
const FAKE_NO_COMMIT = `cat >/dev/null; ${NARRATE}; echo edited > built.txt`
const FAKE_FAIL = `cat >/dev/null; ${NARRATE}; echo "boom" >&2; exit 7`

/**
 * A fixture with a REAL (bare, local) origin the build can actually push to.
 *
 * Real rather than mocked, because the question under test is what `git ls-remote`
 * says, and a stubbed remote would be asserting the stub.
 */
function pushable(): RunResult {
  const r = run({
    authed: true,
    codexLoginExit: 0,
    env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_NO_COMMIT },
  })
  const bare = join(r.dir, 'origin.git')
  spawnSync('git', ['init', '-q', '--bare', bare])
  spawnSync('git', ['remote', 'add', 'origin', bare], { cwd: r.dir })
  return r
}

/** Run the wrapper AGAIN in an existing fixture — a second round on the same branch. */
function rerun(
  r: RunResult,
  execCmd: string,
): { trailer: Record<string, string>; trailerRaw: string } {
  const trailerFile = join(r.dir, 'build.trailer')
  spawnSync(BASH, [SCRIPT, 'trident/a-run'], {
    cwd: r.dir,
    encoding: 'utf8',
    env: {
      PATH: `${join(r.dir, 'bin')}${delimiter}/usr/bin${delimiter}/bin`,
      HOME: r.dir,
      CODEX_HOME: join(r.dir, 'codexhome'),
      NEUTRON_CODEX_AUTH_RETRY_DELAY: '0',
      NEUTRON_CODEX_BUILD_BRIEF_FILE: join(r.dir, 'build.brief'),
      NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY: briefIntegrity(
        readFileSync(join(r.dir, 'build.brief'), 'utf8'),
      ),
      NEUTRON_CODEX_BUILD_TRAILER_FILE: trailerFile,
      NEUTRON_CODEX_BUILD_EXEC_CMD: execCmd,
    },
  })
  const trailerRaw = readFileSync(trailerFile, 'utf8')
  return { trailer: parseTrailer(trailerRaw), trailerRaw }
}

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

  test('no `perl` → exit 3 NAMING perl, not a false report of expired auth', () => {
    // Every bounded call in the wrapper is `perl -e alarm`, so a box without perl
    // fails the auth precheck three times and reports invalid credentials — a
    // true-sounding lie that sends the operator to re-run `codex login` forever. The
    // dependency is checked beside the CLI and refused by name.
    const { status, stderr } = run({ authed: true, codexLoginExit: 0, bareBin: true })
    expect(status).toBe(3)
    expect(stderr).toContain('CODEX_BUILD_NO_PERL')
    expect(stderr).not.toContain('AUTH_EXPIRED')
  })

  test('NO BRIEF → exit 3, and codex is never launched', () => {
    // An empty prompt inside a real worktree with full write access is the one input
    // that must never reach the model: it would invent a task and commit it.
    const { status, stderr, codexStdin } = run({
      authed: true,
      codexLoginExit: 0,
      brief: null,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
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

  test('a TRUNCATED brief → exit 3, and codex is never launched', () => {
    // NON-EMPTY IS NOT INTACT, and this is the gap that made the check necessary: the
    // brief reaches this file through a bridge agent that had to retype it into a
    // heredoc. A shortened one still buys a full build and comes back with a real sha
    // for a contract nobody wrote — nothing downstream can see it, because every gate
    // after this point asks about the repository.
    const whole = `${DEFAULT_BRIEF}Then run the tests, commit, and open a PR.\n`
    const { status, stderr, codexStdin } = run({
      authed: true,
      codexLoginExit: 0,
      brief: DEFAULT_BRIEF,
      integrity: briefIntegrity(whole),
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(status).toBe(3)
    expect(stderr).toContain('CODEX_BUILD_BRIEF_CORRUPT')
    // The message carries both measurements, so the failure is diagnosable from a log.
    expect(stderr).toContain(briefIntegrity(DEFAULT_BRIEF))
    expect(stderr).toContain(briefIntegrity(whole))
    expect(codexStdin).toBe('')
  })

  test('a brief REWORDED to the same length is still refused', () => {
    // The byte count alone would pass this one. The checksum is what makes "the same
    // size" and "the same text" different questions.
    const original = 'Build the parser and its tests.\n'
    const reworded = 'Build the parser and its specs.\n'
    expect(reworded.length).toBe(original.length)
    const { status, stderr } = run({
      authed: true,
      codexLoginExit: 0,
      brief: reworded,
      integrity: briefIntegrity(original),
    })
    expect(status).toBe(3)
    expect(stderr).toContain('CODEX_BUILD_BRIEF_CORRUPT')
  })

  test('NO RECEIPT AT ALL → exit 3, never a build that skips the check', () => {
    // Optional-with-a-skip would switch the check off on exactly the call path that
    // lost the bytes — a caller that dropped the receipt is the one to distrust.
    const { status, stderr, codexStdin } = run({
      authed: true,
      codexLoginExit: 0,
      integrity: null,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(status).toBe(3)
    expect(stderr).toContain('CODEX_BUILD_NO_BRIEF_INTEGRITY')
    expect(codexStdin).toBe('')
  })

  test('the WORKFLOW\'S receipt is accepted by the WRAPPER — the two agree on real bytes', () => {
    // THE CROSS-IMPLEMENTATION CHECK. The receipt is computed in JavaScript by
    // `inner-workflow.mjs` and recomputed in perl here; two implementations of a
    // checksum that never meet is how a gate ends up rejecting every honest brief and
    // stopping every build. `briefIntegrity` above is lifted from the workflow source,
    // so this is the real pair — exercised on the bytes most likely to split them:
    // multi-byte UTF-8, percent signs, backticks and quotes.
    const brief = "Fix the encoder: 100% of `café — naïve` cases, ✅ don't guess.\n"
    // No exec seam here: the mock `codex` itself records what it was handed, which is
    // how "the check let the build through" is observed rather than assumed.
    const { status, codexStdin } = run({ authed: true, codexLoginExit: 0, brief })
    expect(status).toBe(0)
    expect(codexStdin).toBe(brief)
  })

  test('NO TRAILER FILE → exit 3 BEFORE codex is launched, not after', () => {
    // Without somewhere to write the measurement, a build that completes reports
    // nothing — and by then its tokens are spent. Refused up front for that reason,
    // which is only true if codex never ran.
    const { status, stderr, codexStdin } = run({
      authed: true,
      codexLoginExit: 0,
      noTrailerFile: true,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(status).toBe(3)
    expect(stderr).toContain('CODEX_BUILD_NO_TRAILER_FILE')
    expect(codexStdin).toBe('')
  })

  test('configured + authed + build runs → exit 0', () => {
    const { status, stdout } = run({
      authed: true,
      codexLoginExit: 0,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(status).toBe(0)
    expect(stdout).toContain('I am done')
  })

  test('codex exits non-zero → exit 5 (DEFERRED)', () => {
    const { status, stderr } = run({
      authed: true,
      codexLoginExit: 0,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_FAIL },
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

  test('the sandbox grant is on the command line, and it is the wide one', () => {
    // What this proves is the ARGV — that the grant is explicit and not left to the
    // CLI's read-only default. That a narrower policy could not commit or push is
    // reasoning recorded in the script header, not something this assertion measures.
    const r = run({ authed: true, codexLoginExit: 0 })
    expect(r.codexArgv).toContain('--sandbox\ndanger-full-access')
    // …and codex is rooted in THIS worktree, BY NAME. Asserting only that `--cd` is
    // present would stay green if the value became `/tmp` — codex would run outside
    // the checkout, which is the failure the flag exists to prevent.
    expect(r.codexArgv).toContain(`--cd\n${realpathSync(r.dir)}\n`)
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
        NEUTRON_CODEX_BUILD_EXEC_CMD: 'cat >/dev/null; printf "KEY=[%s]\\n" "${OPENAI_API_KEY:-}"',
      },
    })
    expect(stdout).toContain('KEY=[]')
    expect(stdout).not.toContain('sk-should-not-survive')
  })
})

describe('the trailer MEASURES the repository — it never repeats a claim', () => {
  test('a commit the build actually made is reported as the sha git holds', () => {
    const r = run({ authed: true, codexLoginExit: 0, env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD } })
    expect(r.status).toBe(0)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(r.head)
    expect(r.head.length).toBe(40)
    // …and it is genuinely the build's commit, not the base it started from.
    expect(r.head).not.toBe(r.baseHead)
    expect(r.trailer['NEUTRON_CODEX_BUILD_BRANCH']).toBe('trident/a-run')
    expect(r.trailer['NEUTRON_CODEX_BUILD_WORKTREE']).toBe(r.dir)
  })

  test('a build that EDITS but never commits reports an empty sha', () => {
    // The failure that matters: the model says it committed and did not. HEAD is still
    // sitting on the base commit, whose tree contains none of the work — reporting it
    // would let `roundLanded` see a landed round and pin the merge to it. Empty stops
    // the run at the next gate instead.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_NO_COMMIT },
    })
    expect(r.status).toBe(0)
    expect(r.head).toBe(r.baseHead)
    expect(r.baseHead.length).toBe(40)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe('')
  })

  test('a RE-ENTRY that switches onto the branch and commits nothing reports an empty sha', () => {
    // THE RE-ENTRY HAZARD, and the reason the baseline is three tips and not one.
    // Rounds 2..n start in a worktree parked on the base commit, and the brief's first
    // instruction is `git switch <branch>`. A build that switches and then decides it
    // has nothing to do has MOVED HEAD without producing a commit. Measured against
    // the launch HEAD alone that reads as "this build committed", and the sha handed
    // back is the PREVIOUS round's — `roundLanded` sees a landed round and
    // `gh pr merge --match-head-commit` pins to a commit this build never made, and
    // SUCCEEDS. Every crash-resume and every re-fire goes through here.
    const r = run({ authed: true, codexLoginExit: 0, env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD } })
    const roundOne = r.trailer['NEUTRON_CODEX_BUILD_HEAD'] ?? ''
    expect(roundOne).not.toBe('')

    // Park the worktree back on the base, exactly as a fresh re-entry checkout is.
    spawnSync('git', ['switch', '--detach', r.baseHead], { cwd: r.dir })
    const second = rerun(r, `cat >/dev/null; git switch -q trident/a-run`)
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim()
    // HEAD genuinely moved — the switch happened, so this is not passing by accident.
    expect(head).toBe(roundOne)
    expect(head).not.toBe(r.baseHead)
    expect(second.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe('')
    expect(second.trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe('')
    // Emphatically: round one's sha is nowhere in round two's trailer.
    expect(second.trailerRaw).not.toContain(roundOne)
  })

  test('a commit made on the WRONG BRANCH reports an empty sha, and names the branch', () => {
    // EMPTY RATHER THAN WRONG, applied to the field that decides where the work lives.
    // A build that wandered onto another branch and committed there produces a real
    // sha and a real diff — and the run cannot merge either: `git merge <branch>`
    // lands nothing, and in local mode the branch holding the work is deleted right
    // after. Handing the sha over would put five reviewers on a diff that evaporates.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      env: {
        NEUTRON_CODEX_BUILD_EXEC_CMD: `cat >/dev/null; git switch -q -c not-the-branch; ${FAKE_BUILD_NO_DIFF}`,
      },
    })
    // The commit is REAL — the wrapper is suppressing a sha that exists, not reporting
    // an absence it would have reported anyway.
    const wrongHead = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: r.dir,
      encoding: 'utf8',
    }).stdout.trim()
    expect(wrongHead).not.toBe(r.baseHead)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe('')
    expect(r.trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe('')
    expect(r.trailerRaw).not.toContain(wrongHead)
    // …and the trailer SAYS where it ended up, so the failure names itself instead of
    // arriving downstream as an unexplained missing sha.
    expect(r.trailer['NEUTRON_CODEX_BUILD_BRANCH']).toBe('not-the-branch')
  })

  test('a re-entry that switches AND commits still reports its own sha', () => {
    // The control for the test above: the baseline must not swallow a real commit.
    const r = run({ authed: true, codexLoginExit: 0, env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD } })
    const roundOne = r.trailer['NEUTRON_CODEX_BUILD_HEAD'] ?? ''
    spawnSync('git', ['switch', '--detach', r.baseHead], { cwd: r.dir })
    const second = rerun(r, `git switch -q trident/a-run; ${FAKE_BUILD_NO_DIFF}`)
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim()
    expect(head).not.toBe(roundOne)
    expect(second.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(head)
  })

  test('a re-entry whose previous round exists only on the REMOTE reports an empty sha', () => {
    // The third baseline tip. A brand-new worktree may have no local `refs/heads/<b>`
    // at all — the build fetches and creates it — so the local pair cannot see the
    // previous round, and only the remote can say the commit already existed.
    const r = pushable()
    rerun(r, `${FAKE_BUILD_NO_DIFF}; git push -q origin trident/a-run`)
    const roundOne = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim()
    // Erase every LOCAL trace of it, leaving the remote as the only witness.
    spawnSync('git', ['switch', '--detach', r.baseHead], { cwd: r.dir })
    spawnSync('git', ['branch', '-q', '-D', 'trident/a-run'], { cwd: r.dir })
    expect(
      spawnSync('git', ['rev-parse', '--verify', 'refs/heads/trident/a-run'], { cwd: r.dir }).status,
    ).not.toBe(0)

    const second = rerun(
      r,
      `cat >/dev/null; git fetch -q origin trident/a-run; git switch -q -c trident/a-run FETCH_HEAD`,
    )
    expect(
      spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim(),
    ).toBe(roundOne)
    expect(second.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe('')
    expect(second.trailerRaw).not.toContain(roundOne)
  })

  test('a sha256 repository reports its 64-character sha, not an empty one', () => {
    // The length test is what stops `git rev-parse HEAD` echoing the literal `HEAD`
    // back in an empty repo from being reported as a sha — but hard-coded to 40 it
    // also collapses every sha on a sha256 repository, and the wrapper would then say
    // "no commit was made" about a build that made one. Both object formats count.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      objectFormat: 'sha256',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(r.head.length).toBe(64)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(r.head)
    // …and the pre-existing baseline still bites at this width.
    expect(r.baseHead.length).toBe(64)
    expect(r.trailerRaw).not.toContain(r.baseHead)
  })

  test('a repo with NO commit at all reports an empty sha rather than inventing one', () => {
    // `git rev-parse --verify HEAD` fails here, and plain `rev-parse` would echo the
    // literal string `HEAD` — neither is a sha, and neither may be reported as one.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      commit: false,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_NO_COMMIT },
    })
    expect(r.status).toBe(0)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe('')
  })

  test('an UNPUSHED commit reports an empty REMOTE head', () => {
    // The temp repo has no origin, so nothing is pushed. In pr mode the bridge reads
    // the remote head, so this is what stops an unpushed build from being merged.
    const r = run({ authed: true, codexLoginExit: 0, env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD } })
    expect(r.trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe('')
    // …while the LOCAL head is populated, so the two are genuinely different
    // questions and the test is not passing because both happen to be empty.
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).not.toBe('')
  })

  test('a PUSHED commit reports the remote head — as a WITNESS for our own sha', () => {
    const r = pushable()
    const pushed = rerun(r, `${FAKE_BUILD}; git push -q origin trident/a-run`)
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim()
    expect(pushed.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(head)
    expect(pushed.trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe(head)
    // The remote really does hold it — the assertion above is not two empties matching.
    const tip = spawnSync('git', ['ls-remote', 'origin', 'refs/heads/trident/a-run'], {
      cwd: r.dir,
      encoding: 'utf8',
    }).stdout.split('\t')[0]
    expect(tip).toBe(head)
  })

  test('a remote head that is SOMEONE ELSE\'S is reported as empty, never as ours', () => {
    // #545, the reason this is a witness and not a source. A fresh probe of the branch
    // would read back whatever was pushed last — a prior run's sha, or a concurrent
    // third-party push — and `--match-head-commit` would then pin the merge to it and
    // SUCCEED, certifying as reviewed a commit whose code is in nobody's diff.
    const r = pushable()
    rerun(r, `${FAKE_BUILD}; git push -q origin trident/a-run`)
    const theirs = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim()
    // Now OUR build commits on top and does NOT push.
    const ours = rerun(r, FAKE_BUILD)
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim()
    expect(head).not.toBe(theirs)
    expect(ours.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(head)
    expect(ours.trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe('')
    // Emphatically: the other head is nowhere in the trailer.
    expect(ours.trailerRaw).not.toContain(theirs)
  })

  test('the PR number comes from gh, and a non-numeric answer is dropped', () => {
    const found = run({
      authed: true,
      codexLoginExit: 0,
      ghPr: '4321',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(found.trailer['NEUTRON_CODEX_BUILD_PR']).toBe('4321')

    // `gh --jq` prints the literal `null` for an empty list, and "null" reported as a
    // PR number is worse than no number at all.
    const none = run({
      authed: true,
      codexLoginExit: 0,
      ghPr: 'null',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(none.trailer['NEUTRON_CODEX_BUILD_PR']).toBe('')
  })

  test('the diff path is reported only when a NON-EMPTY diff actually exists', () => {
    const wrote = run({ authed: true, codexLoginExit: 0, env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD } })
    expect(wrote.trailer['NEUTRON_CODEX_BUILD_DIFF']).toContain('branch.diff')

    // Never written: the reviewers would be handed a path to nothing, and the codex
    // review lane treats an empty diff as DEFERRED — a confusing way to learn the
    // build did not write one.
    const missing = run({
      authed: true,
      codexLoginExit: 0,
      diff: null,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD_NO_DIFF },
    })
    expect(missing.trailer['NEUTRON_CODEX_BUILD_DIFF']).toBe('')

    // Written but EMPTY is the same nothing.
    const empty = run({
      authed: true,
      codexLoginExit: 0,
      env: {
        NEUTRON_CODEX_BUILD_EXEC_CMD: `${FAKE_BUILD_NO_DIFF}; : > "$NEUTRON_CODEX_BUILD_DIFF_FILE"`,
      },
    })
    expect(empty.trailer['NEUTRON_CODEX_BUILD_DIFF']).toBe('')
  })

  test('a STALE diff from an earlier round is not reported as this round\'s', () => {
    // #545's class of defect one file over: the path is handed in by the caller and
    // survives between rounds, so a build that commits without rewriting it would
    // point the review panel at a diff it did not produce — and the panel would
    // review it without noticing. The wrapper deletes the path before launch, so the
    // only diff it can report is one this build wrote.
    const stale = run({
      authed: true,
      codexLoginExit: 0,
      diff: 'diff --git a/prior b/prior\n+A DIFF FROM AN EARLIER ROUND\n',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD_NO_DIFF },
    })
    // The build committed — so this is not passing because nothing happened.
    expect(stale.trailer['NEUTRON_CODEX_BUILD_HEAD']).not.toBe('')
    expect(stale.trailer['NEUTRON_CODEX_BUILD_DIFF']).toBe('')
    // …and the file itself is gone, not merely unreported: nothing downstream can
    // pick it up off the path by another route.
    expect(existsSync(join(stale.dir, 'branch.diff'))).toBe(false)

    // The control: the SAME stale file, and a build that does rewrite it, reports the
    // path — with this round's contents.
    const fresh = run({
      authed: true,
      codexLoginExit: 0,
      diff: 'diff --git a/prior b/prior\n+A DIFF FROM AN EARLIER ROUND\n',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(fresh.trailer['NEUTRON_CODEX_BUILD_DIFF']).toContain('branch.diff')
    expect(readFileSync(join(fresh.dir, 'branch.diff'), 'utf8')).not.toContain('EARLIER ROUND')
  })

  test('a committing round that wrote NO diff gets one from the base branch', () => {
    // The gap the deletion above opens. The workflow captures the diff PATH once and
    // hands the SAME one to every review round, so a fix round that committed and
    // forgot to re-write the diff would send the panel at a path the wrapper had just
    // deleted. The diff is not a judgement call — it is `git diff <base>..HEAD` — so
    // the wrapper takes it rather than reporting nothing.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      base: 'main',
      diff: 'diff --git a/prior b/prior\n+A DIFF FROM AN EARLIER ROUND\n',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD_NO_DIFF },
    })
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).not.toBe('')
    expect(r.trailer['NEUTRON_CODEX_BUILD_DIFF']).toContain('branch.diff')
    const written = readFileSync(join(r.dir, 'branch.diff'), 'utf8')
    // THIS round's work, not the round the file was left over from.
    expect(written).toContain('built.txt')
    expect(written).not.toContain('EARLIER ROUND')
  })

  test('the last-resort diff needs a COMMIT — an uncommitted round still reports nothing', () => {
    // With no commit of this build's own there is nothing to diff, and an empty
    // `NEUTRON_CODEX_BUILD_DIFF=` is exactly the signal the workflow's round-1 gate
    // reads to keep an unbuilt branch out of the review panel. Regenerating here
    // would manufacture a diff for a build that produced none.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      base: 'main',
      diff: null,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_NO_COMMIT },
    })
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe('')
    expect(r.trailer['NEUTRON_CODEX_BUILD_DIFF']).toBe('')
  })

  test('NO base argument means no last-resort diff — never a guessed base', () => {
    // The positive control for the two above: the same committing-but-diffless build,
    // with the base omitted, reports nothing rather than diffing against whatever
    // branch happens to be lying around.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      diff: null,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD_NO_DIFF },
    })
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).not.toBe('')
    expect(r.trailer['NEUTRON_CODEX_BUILD_DIFF']).toBe('')
  })

  test('a HANGING `gh` costs the run a PR number, never the trailer', () => {
    // `emit_trailer` runs on the FAILURE path too, so an unbounded `gh` does not
    // merely lose a field — it hangs the build phase forever and the DEFERRED report
    // never reaches the bridge. Bounded by the same alarm as the `git ls-remote`
    // probes beside it.
    const r = run({
      authed: true,
      // Kill it well short of the mock's 120s hang. Which of the two happened is the
      // assertion below — a signal means the bound did NOT hold.
      spawnTimeoutMs: 45_000,
      codexLoginExit: 0,
      // The build seam REPLACES `gh` on PATH with one that never returns, after it
      // commits — so the probe runs against a hang the wrapper must give up on.
      env: {
        NEUTRON_CODEX_BUILD_EXEC_CMD: `${FAKE_BUILD}; cat > "$HOME/bin/gh" <<'GHEOF'
#!/bin/sh
sleep 120
GHEOF
chmod 755 "$HOME/bin/gh"`,
      },
    })
    // IT FINISHED BY ITSELF. An unbounded probe would still be inside `gh` at 45s and
    // come back killed; this is the discriminant, not an elapsed-time threshold.
    expect(r.signal).toBeNull()
    // The trailer EXISTS and is complete — the whole point.
    expect(Object.keys(r.trailer)).toHaveLength(6)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).not.toBe('')
    // …with the PR number empty, because the probe was cut off rather than answered.
    expect(r.trailer['NEUTRON_CODEX_BUILD_PR']).toBe('')
  }, 90_000)

  test('a HANGING `git ls-remote` costs the run a fact, never the build phase', () => {
    // THE SAME BOUND AS `gh`, on the two probes that were still inside a command
    // substitution. `$(…)` returns when the PIPE closes, not when the process exits,
    // so an alarm that killed the process did nothing while a child still held stdout
    // — the wrapper waited on the remote forever and the build phase with it. Both
    // probes run here: one before the launch (the re-entry baseline) and one after
    // (the pushed-sha witness), against a git that answers everything except
    // `ls-remote`.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      hangingLsRemote: true,
      // Well short of the mock's 120s. WHICH of the two happened is the assertion — a
      // signal means the bound did not hold — not how long it took.
      spawnTimeoutMs: 60_000,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(r.signal).toBeNull()
    expect(r.status).toBe(0)
    // The local measurement is unaffected: the build's own commit is still reported.
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).not.toBe('')
    // …and the one fact the remote owed us is empty rather than guessed.
    expect(r.trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe('')
    expect(Object.keys(r.trailer)).toHaveLength(6)
  }, 120_000)

  test('the trailer is emitted on the FAILURE path too', () => {
    // A codex run that died after committing still left work on the branch, and the
    // operator recovering it needs to be told the sha. The exit code is what makes
    // the run stop; the trailer is what makes the stop diagnosable.
    const r = run({ authed: true, codexLoginExit: 0, env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_FAIL } })
    expect(r.status).toBe(5)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe('')
    expect(Object.keys(r.trailer)).toHaveLength(6)
  })

  test('all six trailer keys are present on every path that ran codex', () => {
    // A missing key and an empty key read the same to a regex; the bridge is told to
    // copy six values, so six must always be there to copy.
    for (const cmd of [FAKE_BUILD, FAKE_NO_COMMIT, FAKE_FAIL]) {
      const r = run({ authed: true, codexLoginExit: 0, env: { NEUTRON_CODEX_BUILD_EXEC_CMD: cmd } })
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

  test('no trailer file written at all when codex never ran — nothing was measured', () => {
    // A trailer for a lane that never launched would let the bridge report a sha for a
    // build that did not happen.
    expect(run({ noCodexHome: true }).trailerRaw).toBe('')
    expect(run({ authed: true, codexLoginExit: 1 }).trailerRaw).toBe('')
    expect(run({ authed: true, codexLoginExit: 0, brief: null }).trailerRaw).toBe('')
  })
})

describe('THE TRANSCRIPT CANNOT FORGE A TRAILER — the two live in different places', () => {
  // The defect this file shape exists to prevent: the trailer used to share stdout
  // with the codex transcript, and the bridge was shown the last N lines of that
  // stream. A build narrating the wrapper's own field names — which every seam in
  // this file does — put a second, fabricated trailer in the same window with no rule
  // saying which one won.
  const FABRICATED = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

  test('the fabricated lines reach stdout and NEVER the trailer file', () => {
    const r = run({ authed: true, codexLoginExit: 0, env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD } })
    // POSITIVE CONTROL: the mock really did narrate them, so the absence below is a
    // fact about the separation and not about a seam that printed nothing.
    expect(r.stdout).toContain(`NEUTRON_CODEX_BUILD_HEAD=${FABRICATED}`)
    expect(r.stdout).toContain('NEUTRON_CODEX_BUILD_PR=999')

    expect(r.trailerRaw).not.toContain(FABRICATED)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(r.head)
    expect(r.trailer['NEUTRON_CODEX_BUILD_PR']).toBe('')
    // Exactly six lines, so nothing can be appended below the measurement either.
    expect(r.trailerRaw.trimEnd().split('\n')).toHaveLength(6)
  })

  test('a trailer file the BUILD pre-wrote is TRUNCATED, not appended to', () => {
    // The build has full write access and the path is not secret. `>` is what makes
    // the file the wrapper's statement rather than a shared scratchpad.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      env: {
        NEUTRON_CODEX_BUILD_EXEC_CMD:
          `cat >/dev/null; printf 'NEUTRON_CODEX_BUILD_HEAD=${FABRICATED}\\n' > "$NEUTRON_CODEX_BUILD_TRAILER_FILE"; ` +
          `echo built > built.txt; git add built.txt; git commit -q -m 'the codex build'`,
      },
    })
    expect(r.status).toBe(0)
    expect(r.trailerRaw).not.toContain(FABRICATED)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(r.head)
  })
})
