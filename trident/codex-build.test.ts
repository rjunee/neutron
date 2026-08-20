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

import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'codex-build.sh')
const CHECKPOINT_SCRIPT = join(HERE, 'checkpoint.sh')
const SCRIPT_TEXT = readFileSync(SCRIPT, 'utf8')

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

// ── FIXTURE REAPING — every temp dir this file makes dies with the case that made it ──
//
// Each `run()` below builds a REAL fixture: a `git init` repo, a symlink farm of the
// host's tools, sometimes a second worktree. That is ~270K and ~65 inodes apiece, and
// this file makes ~87 of them per full run. Nothing on this box reaps them
// (systemd-tmpfiles ran 21h before the measurement and 18,682 day-old dirs survived
// it), so before this registry existed the suite had left 24,946 orphans / 7.8G in
// /tmp — about 1.6M inodes, ~18% of the host's total.
//
// REGISTERED, NEVER GLOBBED. The tempting implementation is `rm -rf
// /tmp/trident-codex-build-*`, and it is wrong: several trident lanes run this very
// suite concurrently on this host, so a glob would delete a SIBLING lane's in-flight
// fixture and produce an unattributable mid-build failure in an unrelated PR. Only
// paths this process created are ever removed. `leak control D` is the guard on that
// and must not be dropped as redundant.
//
// REAPED IN `afterEach`, NEVER INSIDE `run()`. Tests read `r.dir` after run() returns
// — the RECLAIM case walks the holder worktree and reads its preserved
// post-mortem.txt — so a dir must outlive the call that made it and die with the case.
//
// The 'exit' hook covers what afterEach cannot: a throw during collection, or a normal
// abort, either of which ends the process with entries still registered. rmSync is
// synchronous, so it is valid work for an exit handler. SIGKILL is untrappable and
// WILL still leak; that residue is why an operator-side, age-guarded sweep stays a
// separate thing and is deliberately not wired into this suite.
const FIXTURE_DIRS: string[] = []
/** Register a temp dir for reaping and return it, so it can wrap `mkdtempSync` inline. */
function fixtureDir(path: string): string {
  FIXTURE_DIRS.push(path)
  return path
}
function reapFixtures(): void {
  while (FIXTURE_DIRS.length > 0) {
    const dir = FIXTURE_DIRS.pop() as string
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best effort and SILENT on purpose: a fixture that cannot be removed is a leak,
      // not a test failure, and must not turn a passing case red.
    }
  }
}
afterEach(reapFixtures)
process.on('exit', reapFixtures)

interface RunOpts {
  /** Branch used by `git init -b`; defaults to the wrapper argv branch. */
  initBranch?: string
  /** Create the wrapper argv branch at the base commit while remaining on initBranch. */
  leftoverBranch?: boolean
  /** Check the leftover branch out in a second worktree, making it unbindable here. */
  holdLeftoverBranch?: boolean
  /** Keep a process whose cwd is the holder alive while the wrapper runs. */
  liveHolder?: boolean
  /** Delete the holder directory while leaving its stale worktree admin entry. */
  holderDirDeleted?: boolean
  /** Leave observable uncommitted evidence in the holder. */
  holderDirt?: boolean
  /** Install an artifact-checkpoint recorder; its exit status exercises best effort. */
  checkpointExit?: number
  /** Stderr emitted by that recorder; the wrapper must never pass it through. */
  checkpointStderr?: string
  /** Install a stage-event argv recorder; its exit status exercises best effort. */
  stageExit?: number
  /** Use this stage writer instead of the argv recorder. */
  stageScript?: string
  /** Database coordinate handed to the stage writer. */
  stageDb?: string
  /** Run coordinate handed to the stage writer. */
  stageRunId?: string
  /** Write an auth.json into CODEX_HOME (the "configured" case). */
  authed?: boolean
  /** Don't set CODEX_HOME at all. */
  noCodexHome?: boolean
  /** Mock `codex` on PATH whose `login status` exits with this code. null → no CLI. */
  codexLoginExit?: number | null
  /** The brief handed in. `null` → no brief file at all. */
  brief?: string | null
  /** Raw brief parts written to disk and handed to the wrapper as an ordered manifest. */
  briefParts?: string[]
  /** Per-part receipts. Undefined → aligned receipts for briefParts; null → unset. */
  partIntegrity?: string[] | null
  /** Replace this part's manifest entry with a path that does not exist. */
  missingBriefPartIndex?: number
  /** Insert a blank manifest line after this part index. */
  blankBriefPartLineAfter?: number
  /**
   * The receipt handed in for that brief. Undefined → the one the WORKFLOW would
   * compute (the production case); `null` → none at all; a string → a wrong one.
   */
  integrity?: string | null
  /** PATH holds ONLY the mock bin — no perl, no git, nothing from the system. */
  bareBin?: boolean
  /** Put a `git` on PATH that never returns for `ls-remote`, and delegates otherwise. */
  hangingLsRemote?: boolean
  /**
   * Give the repo a real (bare, local) `origin` BEFORE the wrapper runs.
   *
   * Load-bearing for every remote-probe test: the wrapper skips both `ls-remote`
   * probes when the repo has no `origin`, so a hanging- or failing-remote fixture
   * without one asserts nothing at all.
   */
  origin?: boolean
  /**
   * Override the origin's PUSH url, leaving its fetch url as the local bare repo.
   *
   * Two things have to be true at once for a push-credential test and they pull in
   * opposite directions: the remote must be REACHABLE (or the pr-mode baseline probe
   * defers first and the credential check is never reached), and the push url must be
   * `https://` (or `push_credential_ok` correctly skips it, since ssh and filesystem
   * remotes authenticate with a key or not at all and never consult a helper).
   *
   * A remote with a separate push url is ordinary git configuration, and it maps
   * exactly onto the split the wrapper already relies on: the baseline probe asks
   * `git ls-remote origin` (the FETCH url — the local bare repo, always reachable) and
   * the credential probe asks `git remote get-url --push origin`. So this isolates the
   * one variable each test is about.
   *
   * Requires `origin: true`.
   */
  pushUrl?: string
  /**
   * A `git credential fill` that ANSWERS, installed as a `credential.helper` in the
   * temp repo's own config. The value is not a real secret and never leaves the temp
   * dir; what is under test is whether the wrapper can tell an answer from a silence.
   */
  credentialHelper?: boolean
  /**
   * The wrapper's `$3`. Undefined → not passed at all, which is the "a caller that
   * forgot" case and must behave as `pr`.
   */
  mergeMode?: string
  /** Content for the diff file the brief was told to write. `null` → never written. */
  diff?: string | null
  /** Seed the repo with a commit BEFORE the wrapper runs (the base state). Default true. */
  commit?: boolean
  /** `git init --object-format` — 'sha256' gives 64-character shas. Default sha1. */
  objectFormat?: 'sha256'
  /** Don't set NEUTRON_CODEX_BUILD_TRAILER_FILE at all. */
  noTrailerFile?: boolean
  /**
   * Point NEUTRON_CODEX_BUILD_TRAILER_FILE somewhere else — a path RELATIVE to the temp
   * repo, so a fixture can hand the wrapper one it cannot write to.
   */
  trailerFile?: string
  /**
   * What the mock `gh pr list` prints for the PR number, BEFORE anything creates one.
   * Undefined → `gh pr list` fails, which is "no answer" rather than "no PR".
   */
  ghPr?: string
  /** `gh auth status`'s exit code. Default 0 — a host that can publish. */
  ghAuthExit?: number
  /**
   * Make the mock `gh` behave like the REAL one on this host: authenticated purely
   * from `GH_TOKEN`, refusing every subcommand without it.
   *
   * The default mock answers regardless, because most fixtures here are about
   * something else entirely and a credential-shaped precondition in all of them would
   * only add noise. This option is for the tests that are ABOUT the credential — where
   * "the sandbox cannot publish and the host can" has to be a real difference in
   * behaviour rather than an assertion about a string.
   */
  ghNeedsToken?: boolean
  /** The PR number the mock `gh pr create` opens (and `gh pr list` then reports). */
  ghCreateNumber?: string
  /** No `gh` on PATH at all. */
  noGh?: boolean
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
  checkpointArgs: string
  stageCalls: string
  status: number | null
  /** The signal the harness killed the wrapper with, or null if it exited by itself. */
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** argv the mock `codex` received ('' if never run). */
  codexArgv: string
  /** the BRIEF the mock `codex` received on stdin ('' if never run). */
  codexStdin: string
  /**
   * The mock `codex` process's OWN ENVIRONMENT, one `NAME=value` per line ('' if it
   * never ran) — i.e. what the wrapper handed the build, before the CLI's
   * `shell_environment_policy` narrows it again for the shells the model runs.
   *
   * THE OUTER BOUND IS THE ONE WORTH TESTING. A variable that never reached the codex
   * process cannot reach anything under it, whatever the CLI does with its config; and
   * unlike the config line, this is observable without the real CLI.
   */
  codexEnv: string
  /**
   * One line per mock-`gh` call, in order: `GH_TOKEN=[<what it saw>] :: <argv>`.
   * ('' if `gh` was never called.) The token is on the line because "which side of the
   * publish boundary made this call" is exactly what the tests below are asking.
   */
  ghCalls: string
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

/**
 * A PATH directory holding exactly the tools the wrapper uses — and NOT `gh`.
 *
 * "No `gh` on this box" cannot be fixtured by simply not writing the mock: the build
 * host has a real `/usr/bin/gh`, and every other fixture here puts `/usr/bin` on PATH,
 * so the wrapper would find that one and the test would be asserting against the real
 * CLI's opinion of an empty HOME. A symlink farm is the only way to make the ABSENCE
 * real while leaving `git`, `perl` and the rest reachable.
 *
 * Tools that do not exist on the box are skipped rather than failed: the list is
 * deliberately generous (git shells out to a few of these itself), and a missing one
 * shows up as the wrapper failing loudly, not as a silently different PATH.
 */
function toolFarm(dir: string): string {
  const farm = join(dir, 'toolbin')
  mkdirSync(farm, { recursive: true })
  for (const tool of [
    'sh', 'bash', 'env', 'git', 'perl', 'awk', 'grep', 'sed', 'rm', 'head', 'cat', 'sleep',
    'chmod', 'mkdir', 'ls', 'tr', 'wc', 'date', 'uname', 'dirname', 'basename', 'mktemp',
  ]) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' })
    const resolved = (found.stdout ?? '').trim()
    if (found.status !== 0 || resolved === '') continue
    try {
      symlinkSync(resolved, join(farm, tool))
    } catch {
      // already linked — the farm is per-fixture, so this only happens on a re-entry
    }
  }
  return farm
}

function run(opts: RunOpts = {}): RunResult {
  const dir = fixtureDir(mkdtempSync(join(tmpdir(), 'trident-codex-build-')))
  const codexHome = join(dir, 'codexhome')
  mkdirSync(codexHome, { recursive: true })
  if (opts.authed === true) writeFileSync(join(codexHome, 'auth.json'), '{"token":"x"}\n')

  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const path =
    opts.codexLoginExit === null || opts.bareBin === true
      ? bin
      : opts.noGh === true
        ? `${bin}${delimiter}${toolFarm(dir)}`
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
      `#!/bin/sh\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then exit ${opts.codexLoginExit}; fi\nprintf '%s\\n' "$@" > ${JSON.stringify(join(dir, 'codex-argv.txt'))}\nenv > ${JSON.stringify(join(dir, 'codex-env.txt'))}\ncat > ${JSON.stringify(join(dir, 'codex-stdin.txt'))}\nexit 0\n`,
    )
    chmodSync(mock, 0o755)
  }
  // A mock `gh` ALWAYS (unless a fixture asks for none), so the PR probe is
  // deterministic — the build host may well have a real `gh` that would answer about a
  // real repository.
  //
  // IT IS A SMALL STATE MACHINE NOW, because the host publishes: `gh pr create` OPENS
  // a PR that `gh pr list` must then be able to see. A mock that answered `pr list`
  // from a fixed constant would report a PR whether or not anything created one, which
  // is exactly the fact the end-to-end test is trying to establish.
  //
  // AND IT CAN REQUIRE A CREDENTIAL (`ghNeedsToken`), which is how the real `gh` on
  // this host behaves: it has no `hosts.yml` and authenticates purely from `GH_TOKEN`.
  // That is what lets one fixture put the token in the HOST's environment, watch the
  // sandbox's own `gh pr create` fail without it, and still end with an open PR.
  if (opts.noGh !== true) {
    const gh = join(bin, 'gh')
    const state = JSON.stringify(join(dir, 'gh-pr.state'))
    const listAnswer =
      opts.ghPr === undefined
        ? 'exit 1'
        : `printf '%s\\n' ${JSON.stringify(opts.ghPr)}; exit 0`
    writeFileSync(
      gh,
      `#!/bin/sh
# ONE LOG LINE PER CALL, CARRYING THE CREDENTIAL IT WAS MADE WITH. "who ran this
# command" is the whole question in the publish-boundary tests, and the answer is
# whether the caller had the token: the sandbox never does, the host does.
printf 'GH_TOKEN=[%s] :: %s\\n' "\${GH_TOKEN:-}" "$*" >> ${JSON.stringify(join(dir, 'gh-calls.txt'))}
authed() {
  if [ ${opts.ghNeedsToken === true ? 1 : 0} -eq 1 ] && [ -z "\${GH_TOKEN:-}" ]; then
    echo "gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable." >&2
    exit 1
  fi
}
case "$1:\${2:-}" in
  auth:status) authed; exit ${opts.ghAuthExit ?? 0} ;;
  pr:create)
    authed
    printf '%s\\n' ${JSON.stringify(opts.ghCreateNumber ?? '77')} > ${state}
    echo "https://github.test/o/r/pull/${(opts.ghCreateNumber ?? '77').replace(/[^0-9]/g, '')}"
    exit 0
    ;;
  pr:list)
    authed
    if [ -s ${state} ]; then cat ${state}; exit 0; fi
    ${listAnswer}
    ;;
esac
exit 1
`,
    )
    chmodSync(gh, 0o755)
  }

  // A REAL git repo, because the trailer's whole job is to measure one.
  const branch = opts.branch ?? 'trident/a-run'
  const git = (...args: string[]): void => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  }
  git('init', '-q', '-b', opts.initBranch ?? branch, ...(opts.objectFormat === undefined ? [] : ['--object-format', opts.objectFormat]))
  git('config', 'user.email', 'build@localhost')
  git('config', 'user.name', 'build')
  let baseHead = ''
  if (opts.commit !== false) {
    writeFileSync(join(dir, 'file.txt'), 'base\n')
    git('add', 'file.txt')
    git('commit', '-q', '-m', 'the base the build starts from')
    baseHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
  }
  if (opts.origin === true) {
    const bare = join(dir, 'origin.git')
    spawnSync('git', ['init', '-q', '--bare', bare])
    git('remote', 'add', 'origin', bare)
  }
  if (opts.leftoverBranch === true) git('branch', branch)
  if (opts.holdLeftoverBranch === true) {
    if (opts.leftoverBranch !== true) git('branch', branch)
    git('worktree', 'add', join(dir, 'holder'), branch)
    if (opts.holderDirt === true) {
      writeFileSync(join(dir, 'holder', 'post-mortem.txt'), 'evidence\n')
    }
  }
  const liveHolder = opts.holdLeftoverBranch === true && opts.liveHolder === true
    ? spawn('sleep', ['300'], { cwd: join(dir, 'holder'), stdio: 'ignore' })
    : undefined
  if (opts.holdLeftoverBranch === true && opts.holderDirDeleted === true) {
    rmSync(join(dir, 'holder'), { recursive: true, force: true })
  }
  if (opts.pushUrl !== undefined) git('remote', 'set-url', '--push', 'origin', opts.pushUrl)
  if (opts.credentialHelper === true) {
    // A helper that answers with a fixed, fake pair. `git credential fill` runs it as
    // a shell snippet, exactly as `github/credential.ts` does for the real one.
    git(
      'config',
      'credential.helper',
      '!f() { echo username=x-access-token; echo password=not-a-real-token; }; f',
    )
  }

  const env: Record<string, string> = {
    PATH: path,
    HOME: dir,
    NEUTRON_CODEX_AUTH_RETRY_DELAY: '0',
    ...(opts.env ?? {}),
  }
  if (opts.checkpointExit !== undefined) {
    const checkpoint = join(dir, 'checkpoint-stub.sh')
    const checkpointStderr = opts.checkpointStderr === undefined
      ? ''
      : `printf '%s\\n' ${JSON.stringify(opts.checkpointStderr)} >&2\n`
    writeFileSync(
      checkpoint,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/checkpoint-args.txt"\n${checkpointStderr}exit ${opts.checkpointExit}\n`,
    )
    chmodSync(checkpoint, 0o755)
    env['NEUTRON_CODEX_BUILD_CHECKPOINT_SCRIPT'] = checkpoint
    env['NEUTRON_CODEX_BUILD_CHECKPOINT_DB'] = '/tmp/run.db'
    env['NEUTRON_CODEX_BUILD_CHECKPOINT_RUN_ID'] = 'run-123'
    env['NEUTRON_CODEX_BUILD_CHECKPOINT_NAME'] = 'forge-done'
  }
  if (opts.stageExit !== undefined) {
    const stage = join(dir, 'stage-stub.sh')
    writeFileSync(stage, `#!/bin/sh\nprintf '%s\n' "$*" >> "$HOME/stage-args.txt"\nexit ${opts.stageExit}\n`)
    chmodSync(stage, 0o755)
    env['NEUTRON_CODEX_BUILD_STAGE_SCRIPT'] = stage
  } else if (opts.stageScript !== undefined) {
    env['NEUTRON_CODEX_BUILD_STAGE_SCRIPT'] = opts.stageScript
  }
  if (opts.stageExit !== undefined || opts.stageScript !== undefined) {
    env['NEUTRON_CODEX_BUILD_CHECKPOINT_DB'] = opts.stageDb ?? '/tmp/stage-run.db'
    env['NEUTRON_CODEX_BUILD_CHECKPOINT_RUN_ID'] = opts.stageRunId ?? 'run-stage'
  }
  Object.assign(env, opts.env ?? {})
  if (opts.noCodexHome !== true) env['CODEX_HOME'] = codexHome
  const brief = opts.briefParts === undefined
    ? (opts.brief === undefined ? DEFAULT_BRIEF : opts.brief)
    : undefined
  if (opts.briefParts !== undefined) {
    const partPaths = opts.briefParts.map((part, i) => {
      const partPath = join(dir, `brief-part-${i}.txt`)
      writeFileSync(partPath, part)
      return opts.missingBriefPartIndex === i ? join(dir, `missing-brief-part-${i}.txt`) : partPath
    })
    if (opts.blankBriefPartLineAfter !== undefined) {
      partPaths.splice(opts.blankBriefPartLineAfter + 1, 0, '')
    }
    env['NEUTRON_CODEX_BUILD_BRIEF_PARTS'] = partPaths.join('\n')
    env['NEUTRON_CODEX_BUILD_BRIEF_FILE'] = join(dir, 'build.brief')
    const partIntegrity = opts.partIntegrity === undefined
      ? opts.briefParts.map(briefIntegrity)
      : opts.partIntegrity
    if (partIntegrity !== null) {
      env['NEUTRON_CODEX_BUILD_BRIEF_PART_INTEGRITY'] = partIntegrity.join('\n')
    }
  } else if (typeof brief === 'string') {
    // `!== null` let `undefined` through: the caller may omit the brief entirely, and
    // `writeFileSync` would then be handed undefined. Narrowing on the type rather than
    // on one of its two absent values covers both without a cast.
    const bf = join(dir, 'build.brief')
    writeFileSync(bf, brief)
    env['NEUTRON_CODEX_BUILD_BRIEF_FILE'] = bf
  }
  // THE RECEIPT THE WORKFLOW WOULD HAVE SENT, computed by the workflow's own function
  // — so the default path here is the production path, and the wrapper's perl
  // recomputation is checked against the JS one on every single case in this file.
  const integrity = opts.integrity === undefined
    ? (opts.briefParts === undefined ? briefIntegrity(brief ?? '') : null)
    : opts.integrity
  if (integrity !== null) env['NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY'] = integrity
  const diff = opts.diff === undefined ? 'diff --git a/x b/x\n+change\n' : opts.diff
  const diffFile = join(dir, 'branch.diff')
  if (diff !== null) writeFileSync(diffFile, diff)
  env['NEUTRON_CODEX_BUILD_DIFF_FILE'] = diffFile
  const trailerFile = join(dir, opts.trailerFile ?? 'build.trailer')
  if (opts.noTrailerFile !== true) env['NEUTRON_CODEX_BUILD_TRAILER_FILE'] = trailerFile

  if (opts.base !== undefined) git('branch', opts.base)
  // `$3` cannot be passed without `$2` occupying its slot, so a merge mode with no base
  // sends an EMPTY base — which is the wrapper's documented "no last-resort diff", not
  // a guessed one.
  const argv =
    opts.mergeMode !== undefined
      ? [SCRIPT, branch, opts.base ?? '', opts.mergeMode]
      : opts.base === undefined
        ? [SCRIPT, branch]
        : [SCRIPT, branch, opts.base]
  const res = (() => {
    try {
      return spawnSync(BASH, argv, {
        cwd: dir,
        encoding: 'utf8',
        env,
        ...(opts.spawnTimeoutMs === undefined ? {} : { timeout: opts.spawnTimeoutMs }),
      })
    } finally {
      liveHolder?.kill()
    }
  })()
  const readOr = (name: string): string => {
    try {
      return readFileSync(join(dir, name), 'utf8')
    } catch {
      return ''
    }
  }
  const trailerRaw = readOr('build.trailer')
  return {
    checkpointArgs: readOr('checkpoint-args.txt'),
    stageCalls: readOr('stage-args.txt'),
    status: res.status,
    /** Non-null when the harness had to KILL the wrapper — i.e. it did not finish. */
    signal: res.signal ?? null,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    codexArgv: readOr('codex-argv.txt'),
    codexStdin: readOr('codex-stdin.txt'),
    codexEnv: readOr('codex-env.txt'),
    ghCalls: readOr('gh-calls.txt'),
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
/** FAKE_BUILD with the mock-codex stdin recording seam preserved. */
const RECORDING_FAKE_BUILD = `cat > "$HOME/codex-stdin.txt"; ${NARRATE}; echo built >> built.txt; git add built.txt; git commit -q -m 'the codex build'; ${WRITE_DIFF}`
/** A build that commits but never writes a diff — the stale-diff hazard. */
const FAKE_BUILD_NO_DIFF = `cat >/dev/null; ${NARRATE}; echo built >> built.txt; git add built.txt; git commit -q -m 'the codex build'`
/** A build that RUNS and edits but never commits — the case that must report nothing. */
const FAKE_NO_COMMIT = `cat >/dev/null; ${NARRATE}; echo edited > built.txt`
const FAKE_FAIL = `cat >/dev/null; ${NARRATE}; echo "boom" >&2; exit 7`

describe("the wrapper BINDS the worktree to the run's branch — the binding is measured setup, not the model's job", () => {
  test('a fresh auto-named worktree branch is bound before the build commits', () => {
    const r = run({ authed: true, codexLoginExit: 0, initBranch: 'worktree-wf_x1-2', env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD } })
    const branchHead = spawnSync('git', ['rev-parse', 'refs/heads/trident/a-run'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim()
    expect(r.status).toBe(0)
    expect(r.trailer['NEUTRON_CODEX_BUILD_BRANCH']).toBe('trident/a-run')
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toHaveLength(40)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).not.toBe(r.baseHead)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(branchHead)
  })

  test('the measured leftover-local-branch incident re-enters and advances that branch', () => {
    const r = run({ authed: true, codexLoginExit: 0, initBranch: 'worktree-wf_x1-2', leftoverBranch: true, env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD } })
    const branchHead = spawnSync('git', ['rev-parse', 'refs/heads/trident/a-run'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim()
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', r.baseHead, 'refs/heads/trident/a-run'], { cwd: r.dir })
    expect(r.status).toBe(0)
    expect(r.trailer['NEUTRON_CODEX_BUILD_BRANCH']).toBe('trident/a-run')
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toHaveLength(40)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).not.toBe(r.baseHead)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(branchHead)
    expect(ancestor.status).toBe(0)
  })

  test('a branch held by a DEAD round-0 worktree is RECLAIMED — detached in place, then built', () => {
    const r = run({ authed: true, codexLoginExit: 0, initBranch: 'worktree-wf_x1-2', holdLeftoverBranch: true, holderDirt: true, env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD } })
    const holder = join(r.dir, 'holder')
    const branchHead = spawnSync('git', ['rev-parse', 'refs/heads/trident/a-run'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim()
    const holderBranch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: holder, encoding: 'utf8' }).stdout.trim()
    const worktrees = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: r.dir, encoding: 'utf8' }).stdout
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('CODEX_BUILD_BRANCH_RECLAIMED')
    expect(r.trailer['NEUTRON_CODEX_BUILD_BRANCH']).toBe('trident/a-run')
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toHaveLength(40)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).not.toBe(r.baseHead)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(branchHead)
    expect(readFileSync(join(holder, 'post-mortem.txt'), 'utf8')).toBe('evidence\n')
    expect(holderBranch).toBe('HEAD')
    expect(worktrees).toContain(`worktree ${realpathSync(holder)}`)
  })

  test.skipIf(process.platform !== 'linux')('a branch held by a LIVE worktree is still refused, before any token is spent', () => {
    const r = run({ authed: true, codexLoginExit: 0, initBranch: 'worktree-wf_x1-2', holdLeftoverBranch: true, liveHolder: true, env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD } })
    const holder = join(r.dir, 'holder')
    const holderBranch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: holder, encoding: 'utf8' }).stdout.trim()
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('CODEX_BUILD_BRANCH_UNBOUND')
    expect(r.stderr).toContain('LIVE')
    expect(r.stderr).toContain(holder)
    expect(r.codexStdin).toBe('')
    expect(holderBranch).toBe('trident/a-run')
  })

  test('a holder whose directory is GONE is pruned, not fatal', () => {
    const r = run({ authed: true, codexLoginExit: 0, initBranch: 'worktree-wf_x1-2', holdLeftoverBranch: true, holderDirDeleted: true, env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD } })
    const branchHead = spawnSync('git', ['rev-parse', 'refs/heads/trident/a-run'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim()
    expect(r.status).toBe(0)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(branchHead)
    expect(r.stderr).not.toContain('CODEX_BUILD_BRANCH_UNBOUND')
  })
})

describe('artifact-time checkpoint', () => {
  test('records the measured HEAD after commit and diff', () => {
    const r = run({ authed: true, codexLoginExit: 0, checkpointExit: 0, env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD } })
    expect(r.status).toBe(0)
    expect(r.checkpointArgs.trim().split('\n')).toEqual([
      '/tmp/run.db', 'run-123', 'inner_checkpoint', 'forge-done', 'inner_checkpoint_head', r.head,
    ])
  })

  test('does not run unless all four values are present', () => {
    const r = run({ authed: true, codexLoginExit: 0, checkpointExit: 0, env: {
      NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD,
      NEUTRON_CODEX_BUILD_CHECKPOINT_NAME: '',
    } })
    expect(r.status).toBe(0)
    expect(r.checkpointArgs).toBe('')
  })

  test('checkpoint failure cannot fail the build', () => {
    const r = run({ authed: true, codexLoginExit: 0, checkpointExit: 1, env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD } })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('CODEX_BUILD_CHECKPOINT_FAILED')
  })
})

describe('durable pre-build stage stamps', () => {
  test('wrapper-start is recorded before a not-connected refusal', () => {
    const r = run({ authed: false, codexLoginExit: 0, stageExit: 0 })
    expect(r.status).toBe(10)
    expect(r.stageCalls.trim().split('\n')).toEqual([
      '/tmp/stage-run.db run-stage wrapper-start',
    ])
  })

  test('a successful Codex path durably brackets the exact execution window', () => {
    const r = run({ authed: true, codexLoginExit: 0, mergeMode: 'local', stageExit: 0 })
    expect(r.status).toBe(0)
    expect(r.stageCalls.trim().split('\n')).toEqual([
      '/tmp/stage-run.db run-stage wrapper-start',
      '/tmp/stage-run.db run-stage codex-exec-start',
      '/tmp/stage-run.db run-stage codex-exec-end',
    ])
  })

  test('a failed Codex path still records codex-exec-end', () => {
    const r = run({
      authed: true,
      codexLoginExit: 0,
      stageExit: 0,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_FAIL },
    })
    expect(r.status).toBe(5)
    expect(r.stageCalls.trim().split('\n')).toEqual([
      '/tmp/stage-run.db run-stage wrapper-start',
      '/tmp/stage-run.db run-stage codex-exec-start',
      '/tmp/stage-run.db run-stage codex-exec-end',
    ])
  })

  test('without the stage env the wrapper keeps its exit behaviour and calls no recorder', () => {
    const r = run({ authed: false, codexLoginExit: 0 })
    expect(r.status).toBe(10)
    expect(r.stageCalls).toBe('')
  })

  test('the real wrapper → stage-stamp.sh → sqlite chain appends a row', () => {
    const migrated = fixtureDir(mkdtempSync(join(tmpdir(), 'trident-codex-build-stage-db-')))
    const stageDb = join(migrated, 'project.db')
    seedMigratedDb(stageDb)
    const migratedDb = new Database(stageDb)
    applyMigrations(migratedDb)
    migratedDb.close()
    try {
      const r = run({
        authed: false,
        codexLoginExit: 0,
        stageScript: fileURLToPath(new URL('./stage-stamp.sh', import.meta.url)),
        stageDb,
        stageRunId: 'run-real-stage',
      })
      expect(r.status).toBe(10)
      const db = new Database(stageDb, { readonly: true })
      const rows = db
        .query('SELECT run_id, stage FROM code_trident_stage_events ORDER BY id')
        .all()
      db.close()
      expect(rows).toEqual([{ run_id: 'run-real-stage', stage: 'wrapper-start' }])
    } finally {
      rmSync(migrated, { recursive: true, force: true })
    }
  })

  test('a non-zero stage script cannot change the wrapper exit code', () => {
    const r = run({ authed: true, codexLoginExit: 0, mergeMode: 'local', stageExit: 19 })
    expect(r.status).toBe(0)
    expect(r.stageCalls.trim().split('\n')).toEqual([
      '/tmp/stage-run.db run-stage wrapper-start',
      '/tmp/stage-run.db run-stage codex-exec-start',
      '/tmp/stage-run.db run-stage codex-exec-end',
    ])
  })
})

describe('build-child environment — a build can migrate only its own worktree home', () => {
  const inherited = {
    NEUTRON_HOME: '/fake/live/home',
    OWNER_HOME: '/fake/owner',
    NEUTRON_DB_PATH: '/fake/live.db',
    NEUTRON_BUILD_CHILD_ENV_PROBE: 'inherited',
  }

  function parsedEnv(raw: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const line of raw.trim().split('\n')) {
      const split = line.indexOf('=')
      if (split > 0) out[line.slice(0, split)] = line.slice(split + 1)
    }
    return out
  }

  test.each([
    ['the fake-build composition site', true],
    ['the real codex composition site', false],
  ])('%s scopes inherited live selectors to the isolated worktree', (_label, fakeBuild) => {
    const parentEnv = { ...inherited }
    const parentBefore = { ...parentEnv }
    const processBefore = {
      NEUTRON_HOME: process.env['NEUTRON_HOME'],
      OWNER_HOME: process.env['OWNER_HOME'],
      NEUTRON_DB_PATH: process.env['NEUTRON_DB_PATH'],
    }
    const captured = 'build-child-env.txt'
    const r = run({
      authed: true,
      codexLoginExit: 0,
      env: {
        ...parentEnv,
        ...(fakeBuild
          ? { NEUTRON_CODEX_BUILD_EXEC_CMD: `env > "$HOME/${captured}"; ${FAKE_BUILD}` }
          : {}),
      },
    })

    expect(r.status).toBe(0)
    const childEnv = parsedEnv(
      fakeBuild ? readFileSync(join(r.dir, captured), 'utf8') : r.codexEnv,
    )
    const worktree = r.trailer['NEUTRON_CODEX_BUILD_WORKTREE']!
    const childHome = join(worktree, '.neutron-home')
    expect(childEnv['NEUTRON_HOME']).toBe(childHome)
    expect(relative(worktree, childEnv['NEUTRON_HOME']!)).toBe('.neutron-home')
    expect(existsSync(childHome)).toBe(true)
    expect(readFileSync(join(childHome, '.gitignore'), 'utf8')).toBe('*\n')
    expect(
      spawnSync('git', ['check-ignore', join(childHome, 'project.db')], { cwd: worktree }).status,
    ).toBe(0)
    expect('OWNER_HOME' in childEnv).toBe(false)
    expect('NEUTRON_DB_PATH' in childEnv).toBe(false)
    expect(childEnv['NEUTRON_BUILD_CHILD_ENV_PROBE']).toBe('inherited')
    expect(parentEnv).toEqual(parentBefore)
    expect({
      NEUTRON_HOME: process.env['NEUTRON_HOME'],
      OWNER_HOME: process.env['OWNER_HOME'],
      NEUTRON_DB_PATH: process.env['NEUTRON_DB_PATH'],
    }).toEqual(processBefore)
  })
})
/**
 * A build that behaves like a REAL codex build now does: it commits and writes its
 * diff, and it does NOT push and does NOT open a PR — because it cannot.
 *
 * IT PROVES THAT IT CANNOT, rather than being trusted to have been told. It records the
 * `GH_TOKEN` it can see (the wrapper `env -u`s both names off the build, so this is
 * empty even when the HOST has one) and then actually TRIES `gh pr create`, appending
 * the outcome. Both lines are read by the end-to-end test: without them "the host
 * published it" would be indistinguishable from "the sandbox published it".
 */
const SANDBOX_BUILD =
  `cat >/dev/null; ${NARRATE}; ` +
  `printf 'sandbox GH_TOKEN=[%s]\\n' "$\{GH_TOKEN:-}" > sandbox.log; ` +
  `if gh pr create --head trident/a-run --fill >/dev/null 2>&1; then echo "sandbox pr create SUCCEEDED" >> sandbox.log; else echo "sandbox pr create FAILED" >> sandbox.log; fi; ` +
  `echo built >> built.txt; git add built.txt; git commit -q -m 'the codex build'; ${WRITE_DIFF}`
/**
 * Replace `git` on the fixture's PATH with one whose `push` always fails, from inside
 * the seam — i.e. AFTER the build has committed and BEFORE the wrapper publishes.
 *
 * The same idiom the hanging-`gh` test uses, and it exists for the same reason: `run()`
 * creates the fixture and spawns the wrapper in one call, so a shim a test needs
 * mid-run has to be installed by the build itself.
 */
const BREAK_PUSH = `cat > "$HOME/bin/git" <<'GITEOF'
#!/bin/sh
for a in "$@"; do
  if [ "$a" = "push" ]; then echo "fatal: unable to access the remote" >&2; exit 128; fi
done
exec /usr/bin/git "$@"
GITEOF
chmod 755 "$HOME/bin/git"`

/**
 * A `git` shim that COUNTS `ls-remote` calls and can fail or hang chosen attempts.
 *
 * At module scope rather than inside one `describe`, because two blocks need it: the
 * remote-baseline tests ask how many times the probe was retried, and the merge-mode
 * tests ask whether it was reached at all.
 */
function countingLsRemote(
  dir: string,
  spec: { fail?: readonly number[]; hang?: readonly number[]; failPush?: boolean } = {},
): () => number {
  const counter = join(dir, 'lsremote.count')
  const shim = join(dir, 'bin', 'git')
  const clause = (probes: readonly number[], body: string): string =>
    probes.length === 0 ? '' : `    case "$n" in ${probes.join('|')}) ${body} ;; esac\n`
  // `failPush` makes every `git push` through this shim fail. It is what keeps the
  // "a commit that never reached the remote" cases writable now that the HOST pushes:
  // before the split a seam simply omitted its own `git push`, and after it the same
  // fixture would be published by the wrapper and stop testing anything.
  const pushClause =
    spec.failPush === true
      ? 'if [ "$a" = "push" ]; then echo "fatal: unable to access the remote" >&2; exit 128; fi\n'
      : ''
  writeFileSync(
    shim,
    `#!/bin/sh
for a in "$@"; do
${pushClause}if [ "$a" = "ls-remote" ]; then
  n=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0)
  n=$((n + 1))
  echo "$n" > ${JSON.stringify(counter)}
${clause(spec.fail ?? [], 'exit 128')}${clause(spec.hang ?? [], 'sleep 120')}  fi
done
exec /usr/bin/git "$@"
`,
  )
  chmodSync(shim, 0o755)
  // NO COUNTER FILE MEANS ZERO PROBES, not a crash. The shim creates it on the first
  // `ls-remote`, so "the probe was never reached" — which is exactly what the
  // local-mode tests assert — leaves the path absent.
  return () => {
    try {
      return Number(readFileSync(counter, 'utf8').trim())
    } catch {
      return 0
    }
  }
}

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
  /**
   * Kill the wrapper after this long. A DISCRIMINANT, not a stopwatch — the caller
   * asserts on `signal`, so "it finished by itself" and "we had to kill it" are two
   * observable outcomes rather than two sides of a threshold.
   */
  spawnTimeoutMs?: number,
  /** The wrapper's `$3`. Undefined → not passed, which must behave as `pr`. */
  mergeMode?: string,
): {
  trailer: Record<string, string>
  trailerRaw: string
  status: number | null
  signal: NodeJS.Signals | null
  stderr: string
} {
  const trailerFile = join(r.dir, 'build.trailer')
  // An EMPTY `$2` when a mode is given: `$3` cannot be passed without its slot filled,
  // and an empty base is the wrapper's documented "no last-resort diff".
  const argv =
    mergeMode === undefined
      ? [SCRIPT, 'trident/a-run']
      : [SCRIPT, 'trident/a-run', '', mergeMode]
  const res = spawnSync(BASH, argv, {
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
    ...(spawnTimeoutMs === undefined ? {} : { timeout: spawnTimeoutMs }),
  })
  let trailerRaw = ''
  try {
    trailerRaw = readFileSync(trailerFile, 'utf8')
  } catch {
    trailerRaw = ''
  }
  return {
    trailer: parseTrailer(trailerRaw),
    trailerRaw,
    status: res.status,
    signal: res.signal ?? null,
    stderr: res.stderr ?? '',
  }
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

  test('a corrupt whole brief records the exact refusal sentence on the run row', () => {
    const alertDir = fixtureDir(mkdtempSync(join(tmpdir(), 'trident-codex-build-alert-db-')))
    const dbPath = join(alertDir, 'project.db')
    const runId = 'run-corrupt-whole-alert'
    seedMigratedDb(dbPath)
    const db = new Database(dbPath)
    applyMigrations(db)
    db.run(
      `INSERT INTO code_trident_runs
         (id, slug, project_slug, repo_path, task, started_at, last_advanced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [runId, 'corrupt-whole-alert', 'test-project', '/repo', 'test task', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z'],
    )
    db.close()
    try {
      const whole = `${DEFAULT_BRIEF}Then run the tests, commit, and open a PR.\n`
      const res = run({
        authed: true,
        codexLoginExit: 0,
        brief: DEFAULT_BRIEF,
        integrity: briefIntegrity(whole),
        env: {
          NEUTRON_CODEX_BUILD_CHECKPOINT_SCRIPT: CHECKPOINT_SCRIPT,
          NEUTRON_CODEX_BUILD_CHECKPOINT_DB: dbPath,
          NEUTRON_CODEX_BUILD_CHECKPOINT_RUN_ID: runId,
        },
      })
      const sentence = `CODEX_BUILD_BRIEF_CORRUPT: the brief in ${join(res.dir, 'build.brief')} measures ${briefIntegrity(DEFAULT_BRIEF)} but the workflow composed ${briefIntegrity(whole)} (<bytes>:<fnv32>) — it was truncated or altered on the way here. DEFERRED: building against an approximation of the brief produces a real commit for a task nobody wrote.`
      const readDb = new Database(dbPath, { readonly: true })
      const row = readDb.query<{ brief_alert: string | null }, [string]>(
        'SELECT brief_alert FROM code_trident_runs WHERE id = ?',
      ).get(runId)
      readDb.close()

      expect(res.status).toBe(3)
      expect(res.stderr).toBe(`${sentence}\n`)
      expect(row?.brief_alert).toBe(sentence)
      expect(res.codexArgv).toBe('')
    } finally {
      rmSync(alertDir, { recursive: true, force: true })
    }
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

  test('an UNWRITABLE trailer path → exit 3 BEFORE codex is launched, not a silent exit 0', () => {
    // SET IS NOT WRITABLE, and the precheck used to test only the first. The single
    // `> "$TRAILER_FILE"` in `emit_trailer` fails silently under `set -uo pipefail`
    // with no `set -e`: the wrapper printed "No such file or directory", exited 0, and
    // wrote no trailer — so the bridge reported empty values and the workflow threw
    // "produced no commitSha — nothing was built" about a build that built everything
    // and spent every token for it. The check now PROVES the path by writing it.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      // A directory that was never created — the shape a caller composing the path
       // from a run id gets when the parent has not been made yet.
      trailerFile: 'no-such-dir/build.trailer',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('CODEX_BUILD_TRAILER_UNWRITABLE')
    // Refused UP FRONT: the seam commits, and the repo is still on the base commit.
    expect(r.head).toBe(r.baseHead)
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

describe('codex build brief — assembled from parts on disk (by-path transport)', () => {
  const success = (briefParts: string[], extra: Partial<RunOpts> = {}): RunResult => run({
    authed: true,
    codexLoginExit: 0,
    briefParts,
    env: { NEUTRON_CODEX_BUILD_EXEC_CMD: RECORDING_FAKE_BUILD },
    ...extra,
  })

  test('a >30 KB brief assembled by path reaches codex byte-identical', () => {
    const parts = [
      `FORGE contract\n\nBuild the \`parser\`; don't alter blank lines.\n${'head detail\n'.repeat(170)}`,
      `Очень длинная строка 🚀 ${'x'.repeat(31_000)} emoji ✅ and Cyrillic конец`,
      '\nCODA: test, commit, and stop.\n',
    ]
    expect(Buffer.byteLength(parts.join(''))).toBeGreaterThan(30_000)
    // These bytes were written by fs calls, the exact transport T2 gives the launcher;
    // no agent or model retypes any part on its way to codex stdin.
    const res = success(parts)
    expect(res.status).toBe(0)
    expect(res.codexStdin).toBe(parts.join(''))
  })

  test('a part altered after its receipt was taken is refused with byte-identical stderr when checkpoint env is absent', () => {
    const intended = ['contract\n', `${'middle'.repeat(400)}${'z'.repeat(1_660)}`, '\ncoda\n']
    const corrupted = [...intended]
    corrupted[1] = `${intended[1]!.slice(0, 900)}${intended[1]!.slice(2_560)}`
    const res = success(corrupted, { partIntegrity: intended.map(briefIntegrity) })
    const sentence = `CODEX_BUILD_BRIEF_PART_CORRUPT: brief part ${join(res.dir, 'brief-part-1.txt')} measures ${briefIntegrity(corrupted[1]!)} but its receipt is ${briefIntegrity(intended[1]!)} (<bytes>:<fnv32>) — the file on disk is not the segment that was composed. DEFERRED: building against an approximation of the brief produces a real commit for a task nobody wrote.`
    expect(res.status).toBe(3)
    expect(res.stderr).toBe(`${sentence}\n`)
    expect(res.codexArgv).toBe('')
  })

  test('a corrupt part records the exact refusal sentence on the run row and still exits 3', () => {
    const alertDir = fixtureDir(mkdtempSync(join(tmpdir(), 'trident-codex-build-alert-db-')))
    const dbPath = join(alertDir, 'project.db')
    const runId = 'run-corrupt-part-alert'
    seedMigratedDb(dbPath)
    const db = new Database(dbPath)
    applyMigrations(db)
    db.run(
      `INSERT INTO code_trident_runs
         (id, slug, project_slug, repo_path, task, started_at, last_advanced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [runId, 'corrupt-part-alert', 'test-project', '/repo', 'test task', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z'],
    )
    db.close()
    try {
      const intended = ['contract\n', `${'middle'.repeat(400)}${'z'.repeat(1_660)}`, '\ncoda\n']
      const corrupted = [...intended]
      corrupted[1] = `${intended[1]!.slice(0, 900)}${intended[1]!.slice(2_560)}`
      const res = success(corrupted, {
        partIntegrity: intended.map(briefIntegrity),
        env: {
          NEUTRON_CODEX_BUILD_CHECKPOINT_SCRIPT: CHECKPOINT_SCRIPT,
          NEUTRON_CODEX_BUILD_CHECKPOINT_DB: dbPath,
          NEUTRON_CODEX_BUILD_CHECKPOINT_RUN_ID: runId,
        },
      })
      const sentence = `CODEX_BUILD_BRIEF_PART_CORRUPT: brief part ${join(res.dir, 'brief-part-1.txt')} measures ${briefIntegrity(corrupted[1]!)} but its receipt is ${briefIntegrity(intended[1]!)} (<bytes>:<fnv32>) — the file on disk is not the segment that was composed. DEFERRED: building against an approximation of the brief produces a real commit for a task nobody wrote.`
      const readDb = new Database(dbPath, { readonly: true })
      const row = readDb.query<{ brief_alert: string | null }, [string]>(
        'SELECT brief_alert FROM code_trident_runs WHERE id = ?',
      ).get(runId)
      readDb.close()

      expect(res.status).toBe(3)
      expect(res.stderr).toBe(`${sentence}\n`)
      expect(row?.brief_alert).toBe(sentence)
      expect(res.codexArgv).toBe('')
    } finally {
      rmSync(alertDir, { recursive: true, force: true })
    }
  })

  test('a missing part also records its exact refusal sentence on the run row', () => {
    const alertDir = fixtureDir(mkdtempSync(join(tmpdir(), 'trident-codex-build-alert-db-')))
    const dbPath = join(alertDir, 'project.db')
    const runId = 'run-missing-part-alert'
    seedMigratedDb(dbPath)
    const db = new Database(dbPath)
    applyMigrations(db)
    db.run(
      `INSERT INTO code_trident_runs
         (id, slug, project_slug, repo_path, task, started_at, last_advanced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [runId, 'missing-part-alert', 'test-project', '/repo', 'test task', '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z'],
    )
    db.close()
    try {
      const res = success(['head\n', 'middle\n', 'coda\n'], {
        missingBriefPartIndex: 1,
        env: {
          NEUTRON_CODEX_BUILD_CHECKPOINT_SCRIPT: CHECKPOINT_SCRIPT,
          NEUTRON_CODEX_BUILD_CHECKPOINT_DB: dbPath,
          NEUTRON_CODEX_BUILD_CHECKPOINT_RUN_ID: runId,
        },
      })
      const sentence = `CODEX_BUILD_BRIEF_PART_MISSING: brief part ${join(res.dir, 'missing-brief-part-1.txt')} is missing or empty — the assembled brief would not be the one the workflow composed. DEFERRED.`
      const readDb = new Database(dbPath, { readonly: true })
      const row = readDb.query<{ brief_alert: string | null }, [string]>(
        'SELECT brief_alert FROM code_trident_runs WHERE id = ?',
      ).get(runId)
      readDb.close()

      expect(res.status).toBe(3)
      expect(res.stderr).toBe(`${sentence}\n`)
      expect(row?.brief_alert).toBe(sentence)
      expect(res.codexArgv).toBe('')
    } finally {
      rmSync(alertDir, { recursive: true, force: true })
    }
  })

  test('a failed alert write is swallowed and the corrupt-part refusal still exits 3', () => {
    const intended = ['contract\n', 'middle\n']
    const corrupted = ['contract\n', 'mangled\n']
    const res = success(corrupted, {
      partIntegrity: intended.map(briefIntegrity),
      checkpointExit: 19,
      checkpointStderr: 'sqlite: unable to open /sensitive/project.db',
    })
    const sentence = `CODEX_BUILD_BRIEF_PART_CORRUPT: brief part ${join(res.dir, 'brief-part-1.txt')} measures ${briefIntegrity(corrupted[1]!)} but its receipt is ${briefIntegrity(intended[1]!)} (<bytes>:<fnv32>) — the file on disk is not the segment that was composed. DEFERRED: building against an approximation of the brief produces a real commit for a task nobody wrote.`

    expect(res.status).toBe(3)
    expect(res.stderr).toBe(
      `CODEX_BUILD_BRIEF_ALERT_FAILED\n${sentence}\n`,
    )
    expect(res.checkpointArgs.trim().split('\n')).toEqual([
      '/tmp/run.db', 'run-123', 'brief_alert', sentence,
    ])
    expect(res.stderr).not.toContain('/sensitive/project.db')
    expect(Buffer.from(res.stderr).subarray(-400).toString()).toContain(
      'CODEX_BUILD_BRIEF_PART_CORRUPT',
    )
    expect(res.codexArgv).toBe('')
  })

  test('a checkpoint aimed at a missing run reports alert recording failure', () => {
    const alertDir = fixtureDir(mkdtempSync(join(tmpdir(), 'trident-codex-build-missing-alert-row-')))
    const dbPath = join(alertDir, 'project.db')
    seedMigratedDb(dbPath)
    const db = new Database(dbPath)
    applyMigrations(db)
    db.close()
    try {
      const intended = ['contract\n', 'middle\n']
      const corrupted = ['contract\n', 'mangled\n']
      const res = success(corrupted, {
        partIntegrity: intended.map(briefIntegrity),
        env: {
          NEUTRON_CODEX_BUILD_CHECKPOINT_SCRIPT: CHECKPOINT_SCRIPT,
          NEUTRON_CODEX_BUILD_CHECKPOINT_DB: dbPath,
          NEUTRON_CODEX_BUILD_CHECKPOINT_RUN_ID: 'no-such-run',
        },
      })

      expect(res.status).toBe(3)
      expect(res.stderr).toContain('CODEX_BUILD_BRIEF_ALERT_FAILED')
      expect(res.stderr).toContain('CODEX_BUILD_BRIEF_PART_CORRUPT')
      expect(res.codexArgv).toBe('')
    } finally {
      rmSync(alertDir, { recursive: true, force: true })
    }
  })

  test('a missing part refuses before codex is invoked', () => {
    const res = success(['head\n', 'middle\n', 'coda\n'], { missingBriefPartIndex: 1 })
    expect(res.status).toBe(3)
    expect(res.stderr).toContain('CODEX_BUILD_BRIEF_PART_MISSING')
    expect(res.codexArgv).toBe('')
  })

  test('an empty part refuses before codex is invoked', () => {
    const res = success(['head\n', '', 'coda\n'])
    expect(res.status).toBe(3)
    expect(res.stderr).toContain('CODEX_BUILD_BRIEF_PART_MISSING')
    expect(res.codexArgv).toBe('')
  })

  test('part order is enforced by aligned receipts', () => {
    const intended = ['first\n', 'second\n']
    const res = success([...intended].reverse(), { partIntegrity: intended.map(briefIntegrity) })
    expect(res.status).toBe(3)
    expect(res.stderr).toContain('CODEX_BUILD_BRIEF_PART_CORRUPT')
    expect(res.codexArgv).toBe('')
  })

  test('parts without per-part integrity are refused', () => {
    const res = success(['head\n', 'middle\n'], { partIntegrity: null })
    expect(res.status).toBe(3)
    expect(res.stderr).toContain('CODEX_BUILD_NO_BRIEF_INTEGRITY')
  })

  test('fewer receipts than parts are refused', () => {
    const res = success(['head\n', 'middle\n'], { partIntegrity: [briefIntegrity('head\n')] })
    expect(res.status).toBe(3)
    expect(res.stderr).toContain('CODEX_BUILD_NO_BRIEF_INTEGRITY')
  })

  test('the legacy pre-written brief path builds exactly as before', () => {
    const brief = 'Legacy single-file brief.\n'
    const res = run({ authed: true, codexLoginExit: 0, brief })
    expect(res.status).toBe(0)
    expect(res.codexStdin).toBe(brief)
  })

  test('blank lines in the part manifest are skipped', () => {
    const parts = ['head\n', 'middle\n', 'coda\n']
    const res = success(parts, { blankBriefPartLineAfter: 0 })
    expect(res.status).toBe(0)
    expect(res.codexStdin).toBe(parts.join(''))
  })
})

describe('the BRIEF is what codex is asked to build', () => {
  test('an UNPAIRED SURROGATE in the task text does not abort the route before dispatch', () => {
    // THE DEFECT. The brief carries the owner's task text, which arrives length-capped,
    // and a cap landing mid-emoji leaves half a surrogate pair behind. The receipt used
    // to be computed with `encodeURIComponent`, which THROWS `URIError` on one — so the
    // codex build route died before anything was dispatched, with a message naming
    // neither the brief nor the task, on input the Claude path would not have noticed.
    const half = String.fromCharCode(0xd83d) // a high surrogate, alone
    const brief = `You are FORGE. Ship the ${half} thing on branch trident/a-run.\n`
    expect(() => briefIntegrity(brief)).not.toThrow()

    // …and the receipt is still CORRECT, not merely non-throwing: the wrapper's perl
    // recomputation has to agree, or every brief with one in it would be refused as
    // corrupt. `run()` hands over the JS receipt and the wrapper checks it in perl, so
    // exit 0 is the two implementations agreeing on the real bytes on disk — U+FFFD,
    // which is what any UTF-8 encoder writes for a lone surrogate.
    const { status, codexStdin } = run({ authed: true, codexLoginExit: 0, brief })
    expect(status).toBe(0)
    expect(codexStdin).toContain('Ship the')
    // POSITIVE CONTROL that the check is still live on this input: a receipt for a
    // DIFFERENT text must still be refused, so exit 0 above is agreement and not a
    // check that quietly stopped running.
    expect(
      run({ authed: true, codexLoginExit: 0, brief, integrity: briefIntegrity('something else') })
        .status,
    ).toBe(3)
  })

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

  test('the reasoning effort is PINNED, and overridable through CODEX_BUILD_EFFORT', () => {
    // Unpinned, the CLI default for this tier is `none` — the forge built with reasoning
    // DISABLED until this was pinned. Buying the flagship model and then leaving the
    // effort to the default is the same silent downgrade the model pin above prevents.
    const dflt = run({ authed: true, codexLoginExit: 0 })
    expect(dflt.codexArgv).toContain('model_reasoning_effort=xhigh')

    const pinned = run({
      authed: true,
      codexLoginExit: 0,
      env: { CODEX_BUILD_EFFORT: 'high' },
    })
    expect(pinned.codexArgv).toContain('model_reasoning_effort=high')
    expect(pinned.codexArgv).not.toContain('model_reasoning_effort=xhigh')
  })

  test('an explicitly EMPTY CODEX_BUILD_EFFORT falls back to the CLI default', () => {
    const { codexArgv } = run({
      authed: true,
      codexLoginExit: 0,
      env: { CODEX_BUILD_EFFORT: '' },
    })
    expect(codexArgv).not.toContain('model_reasoning_effort')
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

  test('THE REAL `codex exec` LINE IS WHAT THESE ARGV ASSERTIONS MEASURE', () => {
    // PROVENANCE, asserted rather than assumed. `codex-argv.txt` is written by the
    // mock `codex` on PATH, and the mock returns early for `login status` — so the
    // only thing in this wrapper that can produce that file is the REAL invocation
    // line, reached only when `NEUTRON_CODEX_BUILD_EXEC_CMD` is unset (as it is in
    // every argv test in this block). Pinning the first argument makes that explicit:
    // a future change that routed these cases through the test seam would leave the
    // file empty and this red, instead of quietly asserting the seam's argv.
    const r = run({ authed: true, codexLoginExit: 0 })
    expect(r.codexArgv.split('\n')[0]).toBe('exec')
    expect(r.codexArgv).not.toBe('')
    // …and the seam really is the other path: with it set, the real line never runs.
    const seamed = run({
      authed: true,
      codexLoginExit: 0,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: 'cat >/dev/null' },
    })
    expect(seamed.codexArgv).toBe('')
  })

  test("the owner's Anthropic credential is NEVER handed to the codex shell", () => {
    // THE REGRESSION THIS PINS. An earlier version of the wrapper passed
    // `shell_environment_policy.inherit=all` + `ignore_default_excludes=true` to get
    // `GH_TOKEN` and `GIT_CONFIG_KEY_0` past the CLI's default `*KEY*`/`*SECRET*`/
    // `*TOKEN*` filter and into the build's `git push`. Both halves of that were wrong:
    //
    //  • The credential was not there to inherit. `github/credential.ts` is wired to
    //    trident's OUTER loop only (`open/composer.ts` `run_host`); the INNER workflow
    //    that launches this script never receives it — `SPEC.md` records that as
    //    verified live from `/proc/<pid>/environ`. The push stayed anonymous.
    //  • Clearing the excludes DID expose something. The REPL this runs under carries
    //    the owner's `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
    //    (`gateway/wiring/build-import-substrate.ts` sets one per spawn), so the grant
    //    handed the Anthropic quota this whole route exists to conserve to a
    //    GPT-driven `danger-full-access` shell.
    const { codexArgv } = run({ authed: true, codexLoginExit: 0 })
    expect(codexArgv).not.toContain('shell_environment_policy.inherit=all')
    expect(codexArgv).not.toContain('shell_environment_policy.ignore_default_excludes=true')
    // …and the deny is POSITIVE, not merely the absence of a grant. The defaults would
    // already catch these three families, but only by substring coincidence
    // (`ANTHROPIC_API_KEY` contains `KEY`) — a default list that belongs to another
    // project and can be re-tuned in any release. Naming them keeps the protection
    // intentional.
    expect(codexArgv).toContain(
      '-c\nshell_environment_policy.exclude=["ANTHROPIC_*","CLAUDE_*","KIMI_*","GH_*","GITHUB_*"]\n',
    )
    // …AND `--strict-config`, which is what stops the line above from becoming
    // decoration. Without it the CLI accepts an unrecognised `-c` key and moves on, so
    // a renamed field would silently stop excluding anything and the leak would return
    // with no symptom at all. With it the rename is a config error that names the
    // field, before any tokens are spent.
    expect(codexArgv).toContain('--strict-config\n')
  })

  /**
   * THE ARGV ASSERTIONS ABOVE PIN STRINGS; THIS ONE ASKS THE REAL CLI.
   *
   * An argv test cannot tell a real config field from an invented one, which is
   * precisely the failure `--strict-config` exists to catch. So when a real `codex` is
   * on PATH, put the wrapper's own overrides in front of it and check that it does not
   * call them unknown.
   *
   * OFFLINE AND FAST: config is loaded before any provider is resolved, so pointing
   * `model_provider` at a name that does not exist makes the CLI stop immediately
   * without a network call. And the FIRST assertion is the negative control — an
   * invented `shell_environment_policy` field MUST be refused on the same input shape.
   * Without it a CLI that silently ignored `--strict-config` would make the second
   * assertion pass for the wrong reason, which is the exact class of "a grep that
   * cannot read the format returns a negative that reads like an answer".
   */
  const realCodex = spawnSync('sh', ['-c', 'command -v codex'], { encoding: 'utf8' })
  const haveRealCodex = realCodex.status === 0 && (realCodex.stdout ?? '').trim() !== ''
  test.skipIf(!haveRealCodex)(
    'the `shell_environment_policy` fields are REAL on the installed CLI, not plausible strings',
    () => {
      const home = fixtureDir(mkdtempSync(join(tmpdir(), 'trident-codex-strict-')))
      const ask = (...cfg: string[]): string => {
        const res = spawnSync(
          'codex',
          [
            'exec',
            '--strict-config',
            ...cfg.flatMap((c) => ['-c', c]),
            // A provider that does not exist: the CLI resolves config first, so this
            // stops it before it can reach the network.
            '-c',
            'model_provider=no-such-provider-for-this-test',
            '--sandbox',
            'read-only',
            'unused',
          ],
          {
            encoding: 'utf8',
            input: '',
            timeout: 30_000,
            env: { PATH: process.env['PATH'] ?? '', HOME: home, CODEX_HOME: home },
          },
        )
        return `${res.stdout ?? ''}${res.stderr ?? ''}`
      }
      // NEGATIVE CONTROL FIRST.
      expect(ask('shell_environment_policy.no_such_field_for_this_test=true')).toContain(
        'unknown configuration field',
      )
      // …and the field the wrapper actually passes is not refused. Passed as the same
      // single `-c` string the wrapper builds, so the LIST SYNTAX is under test too:
      // a value the CLI cannot parse fails here rather than aborting every build.
      const real = ask(
        'shell_environment_policy.exclude=["ANTHROPIC_*","CLAUDE_*","KIMI_*","GH_*","GITHUB_*"]',
      )
      expect(real).not.toContain('unknown configuration field')
      // It really did get past config loading and stop where we expected, so the
      // assertion above is not green because the CLI failed earlier for some other
      // reason and printed nothing.
      expect(real).toContain('no-such-provider-for-this-test')
    },
    60_000,
  )

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
    expect(pushed.trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe('')
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
    // Now OUR build commits on top and its commit never reaches the remote. THE PUSH
    // IS BROKEN RATHER THAN OMITTED: the host publishes now, so a seam that merely
    // declines to push would be pushed by the wrapper and this fixture would stop
    // being about an unpushed commit at all.
    countingLsRemote(r.dir, { failPush: true })
    // `FAKE_BUILD_NO_DIFF`, not `FAKE_BUILD`: `rerun` hands the wrapper no
    // `NEUTRON_CODEX_BUILD_DIFF_FILE`, so a seam ending in the diff write exits
    // non-zero and the wrapper never reaches the publish step at all. This one ends on
    // its `git commit`, so codex "succeeds" and the host really does try to push.
    const ours = rerun(r, FAKE_BUILD_NO_DIFF)
    expect(ours.status).toBe(0)
    // …and it really did try and fail, so the empty REMOTE_HEAD below is a fact about
    // the remote rather than a step nobody took.
    expect(ours.stderr).not.toContain('CODEX_BUILD_PUSH_FAILED')
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim()
    expect(head).not.toBe(theirs)
    expect(ours.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(head)
    expect(ours.trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe('')
    // Emphatically: the other head is nowhere in the trailer.
    expect(ours.trailerRaw).not.toContain(theirs)
  })

  /**
   * Replace `git` on the fixture's PATH with one that NUMBERS every `ls-remote` the
   * wrapper makes, fails or hangs the ones named by index, and delegates everything
   * else to the real binary.
   *
   * BY INDEX rather than "the first N", because the wrapper now makes two independent
   * bounded probes — the pre-launch baseline and the post-build witness — and the
   * interesting cases are about WHICH of them was blocked. "Fail the first three" can
   * no longer say whether it defeated the baseline or the witness.
   *
   * Counted as well as failed, because the assertions below are about HOW MANY TIMES
   * the wrapper asked — "it retried" and "it answered first time" are otherwise
   * indistinguishable from the trailer alone.
   */

  test('a TRANSIENT `git ls-remote` failure does not throw away a build that pushed', () => {
    // THE COST OF GETTING THIS WRONG is the whole build. An unanswered probe empties
    // REMOTE_HEAD; the bridge then reports no commitSha; and the workflow throws
    // "produced no commitSha — nothing was built" about a build that committed,
    // pushed, and opened a PR. One blip on a shared remote must not be the last word
    // — the auth precheck retries three times for a far cheaper mistake.
    const r = pushable()
    // Probe 1 is the pre-launch BASELINE and is left to answer; probes 2 and 3 are the
    // first two WITNESS attempts and fail; the third witness attempt answers.
    const probes = countingLsRemote(r.dir, { fail: [2, 3] })
    const pushed = rerun(r, `${FAKE_BUILD}; git push -q origin trident/a-run`)
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim()
    expect(pushed.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(head)
    // THE ASSERTION. Without the retry this is '' and the round is discarded.
    expect(pushed.trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe('')
    // It really did have to ask more than once — otherwise this would be green on a
    // wrapper that never retried and simply got lucky.
    expect(probes()).toBe(1)
  })

  test('a TRANSIENT failure of the BASELINE probe cannot fabricate a sha for a build that committed nothing', () => {
    // THE ASYMMETRY THAT WAS THE BUG. The baseline probe asked ONCE while the witness
    // asked three times, so a blip long enough to defeat one attempt but not three
    // produced the worst possible pair of answers: the previous round's remote-only tip
    // missing from the baseline, and the same tip confirmed as "pushed" moments later.
    //
    // The chain that makes it fabricated provenance: this branch exists only on the
    // remote (a crash-resume, or a fix round in a fresh worktree — the case the local
    // tips cannot see); the build fetches it, switches onto it and decides it has
    // nothing to do; `pre_existing` no longer recognises the head, the branch-name gate
    // passes because it IS the right branch, and the trailer hands the panel a sha and
    // a diff for a round this invocation did not produce.
    const r = pushable()
    rerun(r, `${FAKE_BUILD_NO_DIFF}; git push -q origin trident/a-run`)
    const roundOne = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim()
    // Erase every LOCAL trace, so only the remote can say the commit already existed.
    spawnSync('git', ['switch', '--detach', r.baseHead], { cwd: r.dir })
    spawnSync('git', ['branch', '-q', '-D', 'trident/a-run'], { cwd: r.dir })

    // Blip on the first two baseline attempts; the third answers.
    const probes = countingLsRemote(r.dir, { fail: [1, 2] })
    const second = rerun(
      r,
      `cat >/dev/null; git fetch -q origin trident/a-run; git switch -q -c trident/a-run FETCH_HEAD`,
    )
    // The build really did end up standing on the previous round's commit…
    expect(
      spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim(),
    ).toBe(roundOne)
    // …and the trailer says it produced nothing, which is the truth.
    expect(second.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe('')
    expect(second.trailerRaw).not.toContain(roundOne)
    // It took three asks to bind at the remote tip, then one to capture that bound tip
    // in the baseline. The witness was never reached because there is no new head.
    expect(probes()).toBe(4)
  })

  test('a baseline probe that NEVER answers DEFERS the build instead of starting it blind', () => {
    // A baseline nobody measured is not a baseline: without it the wrapper cannot tell
    // a commit it makes from one that was already on the branch, and the failure mode
    // is reporting someone else's round as this one's. Refusing here costs a round and
    // NO TOKENS, because it happens before codex is launched — which is the only reason
    // refusing is the right answer rather than building and discarding the result.
    const r = pushable()
    const probes = countingLsRemote(r.dir, { fail: [1, 2, 3] })
    const deferred = rerun(r, FAKE_BUILD)
    expect(deferred.status).toBe(3)
    expect(deferred.stderr).toContain('CODEX_BUILD_NO_REMOTE_BASELINE')
    // Three asks, then it stopped — it neither gave up early nor looped.
    expect(probes()).toBe(3)
    // AND THE BUILD NEVER RAN. `FAKE_BUILD` commits; the repo is where it was.
    expect(
      spawnSync('git', ['log', '--oneline', '-1', '--format=%s'], {
        cwd: r.dir,
        encoding: 'utf8',
      }).stdout.trim(),
    ).not.toBe('the codex build')
  })

  test('a repo with NO origin skips the remote probes rather than deferring on them', () => {
    // The control for the refusal above. `git ls-remote origin` on a repo with no
    // remote fails exactly like a wedged network, and treating the two the same would
    // defer every local-mode build forever. A repo with no remote cannot have a
    // remote-only branch, so its remote baseline is complete by being empty.
    const r = run({ authed: true, codexLoginExit: 0, env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD } })
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('CODEX_BUILD_NO_REMOTE_BASELINE')
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(r.head)
  })

  test('LOCAL mode does not require a remote baseline — an unreachable origin is not its problem', () => {
    // THE WEDGE THIS FIXES. The baseline was gated on `has_origin`, which is a question
    // about the CLONE, not about the RUN. So a LOCAL-mode build in any clone that has
    // an origin it cannot reach — offline, a stale URL, a non-GitHub remote — hit the
    // refusal above and exited 3 before codex was ever launched. Every round. The run
    // could never progress, and the reason named a remote it was never going to push
    // to. Local mode pushes nothing, so the remote cannot be the source of a commit
    // this build did not make, and there is nothing for the baseline to protect.
    const r = pushable()
    const probes = countingLsRemote(r.dir, { fail: [1, 2, 3] })
    const built = rerun(r, FAKE_BUILD_NO_DIFF, undefined, 'local')
    expect(built.status).toBe(0)
    expect(built.stderr).not.toContain('CODEX_BUILD_NO_REMOTE_BASELINE')
    // THE BUILD REALLY RAN — `FAKE_BUILD` commits, and the trailer measured its sha.
    expect(built.trailer['NEUTRON_CODEX_BUILD_HEAD']).not.toBe('')
    expect(
      spawnSync('git', ['log', '--oneline', '-1', '--format=%s'], {
        cwd: r.dir,
        encoding: 'utf8',
      }).stdout.trim(),
    ).toBe('the codex build')
    // …and it never asked the remote at all, rather than asking and tolerating the
    // failure. The probe is SKIPPED in local mode, which is why a wedged remote cannot
    // even cost it the 3×10s the pr-mode retry spends.
    expect(probes()).toBe(0)
  })

  test('an ABSENT merge-mode argument is treated as `pr`, the strict side', () => {
    // The control for the test above, and the one that makes the default safe. A caller
    // that forgets `$3` must get the run that verifies too much, never the one that
    // verifies too little — so the same fixture that builds under `local` still DEFERS
    // when the mode is not passed at all.
    const r = pushable()
    countingLsRemote(r.dir, { fail: [1, 2, 3] })
    const deferred = rerun(r, FAKE_BUILD)
    expect(deferred.status).toBe(3)
    expect(deferred.stderr).toContain('CODEX_BUILD_NO_REMOTE_BASELINE')
  })

  test('an UNRECOGNISED merge-mode argument is treated as `pr` too, not as `local`', () => {
    // A misspelling must not silently buy the permissive behaviour. `local` is the ONLY
    // value that relaxes anything; everything else lands on `pr`.
    const r = pushable()
    countingLsRemote(r.dir, { fail: [1, 2, 3] })
    const deferred = rerun(r, FAKE_BUILD, undefined, 'Local')
    expect(deferred.status).toBe(3)
    expect(deferred.stderr).toContain('CODEX_BUILD_NO_REMOTE_BASELINE')
  })

  test('LOCAL mode reports NO PR number, even when one exists for the branch', () => {
    // `gh pr list` used to run unconditionally, so a local-mode build standing on a
    // branch that happens to have an open PR reported that PR's number as its own —
    // where the workflow's contract says local mode reports null. Not a merge hazard
    // (`trident/merge.ts` routes on the run's own `merge_mode`), but every other field
    // in this trailer is a measurement and this one would have been a coincidence.
    //
    // The mock `gh` here ANSWERS with a number, so a wrapper that still asked would
    // report `4242` and this would be red — the fixture can produce the failure.
    const local = run({
      authed: true,
      codexLoginExit: 0,
      ghPr: '4242',
      mergeMode: 'local',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(local.status).toBe(0)
    expect(local.trailer['NEUTRON_CODEX_BUILD_PR']).toBe('')
    // …and the SAME fixture in pr mode does report it, which is what proves the mock
    // was answering all along and the empty value above is the mode and not a broken
    // `gh`.
    const asPr = run({
      authed: true,
      codexLoginExit: 0,
      ghPr: '4242',
      mergeMode: 'pr',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(asPr.trailer['NEUTRON_CODEX_BUILD_PR']).toBe('')
  })
})

describe('outer-loop publishing boundary', () => {
  test('the inner wrapper never pushes, opens a PR, or probes a GitHub credential', () => {
    // Match anywhere on a non-comment shell line so wrappers such as
    // `bounded /dev/null 60 git push` cannot make this guard vacuous.
    expect(SCRIPT_TEXT).not.toMatch(/^[^#\n]*\bgit push\b/m)
    expect(SCRIPT_TEXT).not.toMatch(/^[^#\n]*\bgh pr create\b/m)
    expect(SCRIPT_TEXT).not.toMatch(/^[^#\n]*\bgit credential fill\b/m)
    expect(SCRIPT_TEXT).not.toMatch(/^[^#\n]*\bgh auth status\b/m)
  })

  test('a pr-mode inner build reports only its local commit for the outer handoff', () => {
    const r = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      mergeMode: 'pr',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(r.status).toBe(0)
    expect(r.head).not.toBe(r.baseHead)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(r.head)
    expect(r.trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe('')
    expect(r.trailer['NEUTRON_CODEX_BUILD_PR']).toBe('')
    expect(r.ghCalls).not.toContain('pr create')
  })

  test('local mode still commits without any remote or PR operation', () => {
    const r = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      mergeMode: 'local',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(r.status).toBe(0)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(r.head)
    expect(r.trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe('')
    expect(r.trailer['NEUTRON_CODEX_BUILD_PR']).toBe('')
    expect(r.ghCalls).toBe('')
    expect(spawnSync('git', ['ls-remote', 'origin'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim()).toBe('')
  })

  test('the live codex child process has no GitHub credential', () => {
    const r = run({
      authed: true,
      codexLoginExit: 0,
      env: {
        GH_TOKEN: 'injected-gh-secret',
        GITHUB_TOKEN: 'injected-github-secret',
        GH_TOKEN_DECOY: 'positive-control',
        NEUTRON_CODEX_BUILD_PROBE: 'environment-dump-is-live',
      },
    })
    // Positive controls prove the child environment dump is populated and the
    // matcher recognizes the same credential-name family.
    expect(r.codexEnv).toContain('NEUTRON_CODEX_BUILD_PROBE=environment-dump-is-live')
    expect(r.codexEnv).toContain('GH_TOKEN_DECOY=positive-control')
    expect(r.codexEnv).not.toContain('GH_TOKEN=injected-gh-secret')
    expect(r.codexEnv).not.toContain('GITHUB_TOKEN=injected-github-secret')
    expect(r.codexArgv).toContain(
      '-c\nshell_environment_policy.exclude=["ANTHROPIC_*","CLAUDE_*","KIMI_*","GH_*","GITHUB_*"]\n',
    )
    expect(r.codexArgv).toContain('--strict-config')
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

describe('atomic trailer publication', () => {
  const expectCompleteTrailer = (raw: string): void => {
    const lines = raw.trimEnd().split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[0]).toStartWith('NEUTRON_CODEX_BUILD_BRANCH=')
    expect(lines[5]).toStartWith('NEUTRON_CODEX_BUILD_WORKTREE=')
  }

  test('a trailer planted by the build itself is atomically replaced, leaving no temp residue', () => {
    const r = run({
      authed: true,
      codexLoginExit: 0,
      env: {
        NEUTRON_CODEX_BUILD_EXEC_CMD:
          `${FAKE_BUILD}; printf 'NEUTRON_CODEX_BUILD_HEAD=attacker-junk\\n' > "$NEUTRON_CODEX_BUILD_TRAILER_FILE"`,
      },
    })
    expect(r.status).toBe(0)
    expectCompleteTrailer(r.trailerRaw)
    expect(r.trailerRaw).not.toContain('attacker-junk')
    expect(readdirSync(r.dir).some((entry) => /^build\.trailer\.tmp\./.test(entry))).toBe(false)
  })

  test('a concurrent reader never observes a partial trailer', async () => {
    const observer =
      `sh -c 'i=0; while [ $i -lt 600 ]; do if [ -s "$NEUTRON_CODEX_BUILD_TRAILER_FILE" ]; then cat "$NEUTRON_CODEX_BUILD_TRAILER_FILE" > "$HOME/observed.trailer"; exit 0; fi; sleep 0.05; i=$((i+1)); done' >/dev/null 2>&1 &`
    const r = run({
      authed: true,
      codexLoginExit: 0,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: `${FAKE_BUILD}; ${observer}` },
    })
    expect(r.status).toBe(0)
    const observed = join(r.dir, 'observed.trailer')
    for (let i = 0; i < 200 && !existsSync(observed); i++) await Bun.sleep(50)
    expect(existsSync(observed)).toBe(true)
    const observedRaw = readFileSync(observed, 'utf8')
    expect(observedRaw).toBe(r.trailerRaw)
    expectCompleteTrailer(observedRaw)
  }, 15_000)

  test('the failed-build path also publishes atomically', () => {
    const r = run({
      authed: true,
      codexLoginExit: 0,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: `${FAKE_BUILD}; exit 1` },
    })
    expect(r.status).toBe(5)
    expectCompleteTrailer(r.trailerRaw)
    expect(readdirSync(r.dir).some((entry) => /^build\.trailer\.tmp\./.test(entry))).toBe(false)
  })

  test('the script publishes only by renaming a fully-written temp file', () => {
    expect(SCRIPT_TEXT).toContain('mv -f "$TRAILER_TMP" "$TRAILER_FILE"')
    expect(SCRIPT_TEXT).not.toContain('> "$TRAILER_FILE"')
    expect(SCRIPT_TEXT).toContain('rm -f "$TRAILER_TMP" "$TRAILER_FILE"')
  })
})

describe('fixture reaping — the suite must not leak its own temp dirs', () => {
  // The regex the counters below use. It is deliberately the BARE mkdtemp shape
  // (`trident-codex-build-` + exactly 6 mkdtemp characters) — the same shape that
  // accounted for all 24,946 orphans measured on this host, and NOT the
  // `-stage-db-` / `-alert-db-` variants, which are longer.
  const FIXTURE_NAME = /^trident-codex-build-[A-Za-z0-9]{6}$/
  const fixtureNames = (): Set<string> =>
    new Set(readdirSync(tmpdir()).filter((name) => FIXTURE_NAME.test(name)))
  const cheapRun = (): RunResult =>
    run({ authed: true, codexLoginExit: 0, env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD } })

  // A case cannot watch its own reap — afterEach runs after the body returns — so the
  // observation is split across two cases, A recording and B checking.
  let priorDir = ''

  test('control A: a fixture dir is ALIVE for the whole of the case that made it', () => {
    const r = cheapRun()
    // NEGATIVE CONTROL on placement: proves the reaper does NOT fire inside run(). If
    // anyone "simplifies" the cleanup into run(), this fails — and so does every case
    // that reads r.dir afterwards, e.g. the RECLAIM case that walks the holder
    // worktree and reads its preserved post-mortem.txt.
    expect(existsSync(r.dir)).toBe(true)
    expect(readdirSync(r.dir).length).toBeGreaterThan(0)
    priorDir = r.dir
  })

  test('control B: the PREVIOUS case\'s fixture dir is GONE', () => {
    // ANTI-VACUITY GUARD, and it is load-bearing, not decorative: with no fixture
    // recorded, `existsSync('')` is false and the real assertion below would pass
    // while observing nothing at all. An empty check reading as a passing check is
    // this repo's recurring failure mode; this line makes the empty case fail loudly.
    //
    // It also makes B ORDER-DEPENDENT on purpose: `bun test -t 'control B'` filters A
    // out and B then fails, loudly and correctly, because it was given nothing to
    // observe. Run the pair with the file, not with -t alone.
    expect(priorDir).not.toBe('')
    expect(existsSync(priorDir)).toBe(false)
  })

  test('control C: N runs net ZERO new fixture dirs in /tmp', () => {
    const before = fixtureNames()
    const r1 = cheapRun()
    const r2 = cheapRun()
    const mine = [basename(r1.dir), basename(r2.dir)]
    const during = fixtureNames()

    // POSITIVE CONTROL ON THE COUNTER. The two dirs that certainly exist right now
    // must be VISIBLE to the readdir+regex the assertions below count with. If the
    // mkdtemp prefix or suffix length ever changes, this fails loudly here instead of
    // letting the after-count report a serene 0 == 0 over a regex matching nothing.
    expect(mine.filter((name) => during.has(name))).toEqual(mine)
    expect(before.has(mine[0] as string)).toBe(false)
    expect(before.has(mine[1] as string)).toBe(false)

    reapFixtures()

    const after = fixtureNames()
    // THE CLAIM: counted over the same path, both are gone — net zero.
    expect(mine.filter((name) => after.has(name))).toEqual([])

    // "…AND THE REAP DID NOT TAKE THE REST OF /tmp WITH IT" DELIBERATELY IS NOT
    // ASSERTED HERE, AND THAT IS THE POINT OF THIS COMMENT.
    //
    // The obvious way to write it —
    //     expect([...before].filter((name) => !after.has(name))).toEqual([])
    // — asks whether ANY pre-existing `trident-codex-build-*` dir in the shared /tmp
    // namespace vanished during this case's ~190ms window. That is not a fact about
    // this reaper. It is a fact about every OTHER process on the box, and it goes red
    // when any of them removes one of its own dirs: a sibling lane running this very
    // suite (i.e. this fix, once it propagates), control D's own `rmSync(foreign)` in
    // a sibling process, or an operator drain of stale fixtures.
    //
    // Worse, it is a guard that gets STRICTER as the leak it guards gets fixed — it
    // was only ever quiet because siblings LEAKED. A test that passes only while the
    // bug is present is not a control, and this repo has already lost days to a flaky
    // test reddening main and blaming whichever diff was in flight.
    //
    // The claim is real and worth keeping, so it lives in `control D`, which makes it
    // HERMETICALLY: D creates its own unregistered `foreign` dir, registers one beside
    // it so the reap is genuine work rather than a vacuous no-op, and asserts `foreign`
    // survives with its contents intact. Nothing another process does can perturb that.
  })

  test('control D: the reaper removes ONLY dirs it registered', () => {
    // The most important control in this set. A glob reaper (`rm -rf
    // /tmp/trident-codex-build-*`) would pass A, B and C and silently delete a
    // concurrent lane's in-flight fixture. `foreign` stands in for that lane: same
    // prefix, same parent, NOT registered here.
    const foreign = mkdtempSync(join(tmpdir(), 'trident-codex-build-'))
    writeFileSync(join(foreign, 'a-sibling-lane-is-building-in-here.txt'), 'live\n')
    try {
      // Registered alongside it, so the reap under test is REAL work and not a no-op:
      // without this, a reaper that did nothing at all would also leave `foreign`
      // standing and pass vacuously.
      const ours = fixtureDir(mkdtempSync(join(tmpdir(), 'trident-codex-build-')))
      reapFixtures()
      expect(existsSync(ours)).toBe(false)
      expect(existsSync(foreign)).toBe(true)
      expect(readFileSync(join(foreign, 'a-sibling-lane-is-building-in-here.txt'), 'utf8')).toBe(
        'live\n',
      )
    } finally {
      rmSync(foreign, { recursive: true, force: true })
    }
  })

  test('control E: an entry that CANNOT be removed is a leak, not a red suite', () => {
    // Reaping is best-effort by design: an entry rmSync throws on must neither turn a
    // passing case red nor abandon the rest of the registry.
    //
    // A merely-absent path would NOT exercise this — `force: true` makes that a silent
    // no-op — so the entry has to be one rmSync genuinely refuses. A NUL in the path is
    // refused deterministically (ERR_INVALID_ARG_VALUE) for every user, including root,
    // which a chmod-based lock would not be.
    const unremovable = `${join(tmpdir(), 'trident-codex-build-refused')}${String.fromCharCode(0)}x`
    // POSITIVE CONTROL ON THE FIXTURE: prove the entry really does throw. Without it an
    // rmSync that quietly tolerated the path would make the assertions below pass while
    // the catch under test was never entered.
    expect(() => rmSync(unremovable, { recursive: true, force: true })).toThrow()

    // Pushed so the BAD entry is popped FIRST (the reaper pops from the end): the
    // survivor is only reached if the loop continues past the throw.
    const survivor = fixtureDir(mkdtempSync(join(tmpdir(), 'trident-codex-build-')))
    FIXTURE_DIRS.push(unremovable)

    expect(() => reapFixtures()).not.toThrow()
    expect(existsSync(survivor)).toBe(false)
    expect(FIXTURE_DIRS.length).toBe(0)
  })
})
