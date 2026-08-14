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
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'codex-build.sh')
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
    'sh', 'env', 'git', 'perl', 'awk', 'grep', 'sed', 'rm', 'head', 'cat', 'sleep',
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
  const dir = mkdtempSync(join(tmpdir(), 'trident-codex-build-'))
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
  if (opts.origin === true) {
    const bare = join(dir, 'origin.git')
    spawnSync('git', ['init', '-q', '--bare', bare])
    git('remote', 'add', 'origin', bare)
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
/** A build that commits but never writes a diff — the stale-diff hazard. */
const FAKE_BUILD_NO_DIFF = `cat >/dev/null; ${NARRATE}; echo built >> built.txt; git add built.txt; git commit -q -m 'the codex build'`
/** A build that RUNS and edits but never commits — the case that must report nothing. */
const FAKE_NO_COMMIT = `cat >/dev/null; ${NARRATE}; echo edited > built.txt`
const FAKE_FAIL = `cat >/dev/null; ${NARRATE}; echo "boom" >&2; exit 7`
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
      const home = mkdtempSync(join(tmpdir(), 'trident-codex-strict-'))
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
    // It took three asks to establish the baseline, and the witness was never reached
    // (there is no head of our own to witness) — so this is the baseline's retry being
    // measured, not the witness's.
    expect(probes()).toBe(3)
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

describe.skip('obsolete inner-wrapper publishing contract', () => {
  // WHY THIS PRECHECK EXISTS. In pr mode the brief orders the build to `git push` and
  // reuse its PR, and the run is graded on the PUSHED sha. Nothing in the inner
  // workflow's process tree is guaranteed to hold a credential that can: the GitHub
  // token is wired to trident's OUTER loop only (`open/composer.ts` `run_host` over
  // `github/credential.ts`), and `SPEC.md` records the inner workflow's environment as
  // verified to contain no `GH_TOKEN` and no `GIT_CONFIG_*`.
  //
  // Without the precheck that run still fails — it just fails LATE: a full build runs,
  // commits, cannot push, and `emit_trailer` measures an empty REMOTE_HEAD, which the
  // workflow reports as "produced no commitSha — nothing was built" about a build that
  // built the whole thing. Same failed round, one round earlier, a message that names
  // the actual missing piece, and no tokens.

  test('pr mode with an https origin and NO credential DEFERS before launching codex', () => {
    const r = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      pushUrl: 'https://github.invalid/o/r.git',
      mergeMode: 'pr',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('CODEX_BUILD_NO_PUSH_CREDENTIAL')
    // AND THE BUILD NEVER RAN — which is the entire value of checking here rather than
    // discovering it afterwards. `FAKE_BUILD` commits; the repo is where it was.
    expect(r.head).toBe(r.baseHead)
  })

  test('…and the SAME fixture with a credential helper builds — the probe reads the answer', () => {
    // THE POSITIVE CONTROL, and it is what makes the refusal above mean something. The
    // two fixtures differ in exactly one thing: whether a `credential.helper` answers.
    // Without this, a probe that could never succeed would produce the same red as a
    // probe that correctly found nothing.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      pushUrl: 'https://github.invalid/o/r.git',
      credentialHelper: true,
      mergeMode: 'pr',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(r.stderr).not.toContain('CODEX_BUILD_NO_PUSH_CREDENTIAL')
    expect(r.status).toBe(0)
    expect(r.head).not.toBe(r.baseHead)
  })

  test('LOCAL mode never pushes, so a missing credential is not a defect in it', () => {
    const r = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      pushUrl: 'https://github.invalid/o/r.git',
      mergeMode: 'local',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(r.stderr).not.toContain('CODEX_BUILD_NO_PUSH_CREDENTIAL')
    expect(r.status).toBe(0)
    expect(r.head).not.toBe(r.baseHead)
  })

  test('an ssh remote is SKIPPED, not failed — a key authenticates it, not a helper', () => {
    // Refusing these would break every install that pushes over ssh in order to protect
    // the ones that push over https. `git credential fill` is never consulted for an
    // ssh remote, so there is nothing here the probe could measure.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      pushUrl: 'git@github.invalid:o/r.git',
      mergeMode: 'pr',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(r.stderr).not.toContain('CODEX_BUILD_NO_PUSH_CREDENTIAL')
    expect(r.status).toBe(0)
  })

  test('a filesystem origin is skipped too — the local-bare fixture must keep building', () => {
    // The `origin: true` fixture every other remote-probe test in this file uses is a
    // local bare path. A precheck that failed those would turn this whole suite red for
    // a reason that has nothing to do with credentials.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      mergeMode: 'pr',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(r.stderr).not.toContain('CODEX_BUILD_NO_PUSH_CREDENTIAL')
    expect(r.status).toBe(0)
  })

  test('the probe never writes the secret anywhere the run can leak it', () => {
    // The helper answers with a recognisable value; it must appear in neither the
    // wrapper's output nor the trailer. `git credential fill` prints the password on
    // stdout by construction, so the redirect-and-grep discipline is the only thing
    // keeping it out of a transcript the operator reads.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      pushUrl: 'https://github.invalid/o/r.git',
      credentialHelper: true,
      mergeMode: 'pr',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('not-a-real-token')
    expect(r.stderr).not.toContain('not-a-real-token')
    expect(r.trailerRaw).not.toContain('not-a-real-token')
  })
})

/**
 * THE PUBLISH BOUNDARY — the build commits, the HOST pushes and opens the PR.
 *
 * THE RUN THIS BLOCK IS ABOUT. On 2026-08-13 a codex build wrote an entire feature
 * across eleven files and got the suite green, and then delivered nothing: a 0-byte
 * trailer, a 0-byte transcript, empty BRANCH/HEAD/PR at the workflow, `deferred`, no PR
 * and no review panel. The work survived only because the dirty worktree was preserved.
 *
 * The cause was that half the publish path had a credential and half did not, and the
 * half that did not is the half that REPORTS: `git push` reads a `store --file=…`
 * helper named in `~/.gitconfig`, and a FILE survives the child's environment filter,
 * while `gh` on that host has no `hosts.yml` and authenticates purely from `GH_TOKEN` —
 * which is precisely what the filter strips, deliberately and permanently (widening it
 * is what leaked the owner's Anthropic credential into a `danger-full-access` GPT shell
 * the last time it was tried).
 *
 * So the contract is split: the build commits locally, and the wrapper — which runs
 * OUTSIDE the sandbox, where the credential lives — pushes and opens the PR. These
 * tests drive that end to end against a real bare origin and a `gh` that, like the real
 * one, refuses to work without a token.
 */
describe.skip('obsolete wrapper publish boundary', () => {
  /** `gh` calls made by a caller that HAD the token — i.e. by the host, not the build. */
  const hostCalls = (calls: string): string[] =>
    calls
      .split('\n')
      .filter((l) => l.startsWith('GH_TOKEN=[not-a-real-gh-token]'))
      .map((l) => l.split(' :: ')[1] ?? '')

  test('a build whose sandbox holds NO GitHub credential still lands a pushed branch and an open PR', () => {
    const r = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      base: 'main',
      mergeMode: 'pr',
      // A `gh` that behaves like the real one on this host: no token, no answer.
      ghNeedsToken: true,
      ghCreateNumber: '77',
      env: {
        // THE CREDENTIAL IS THE HOST'S. The wrapper `env -u`s it off the build.
        GH_TOKEN: 'not-a-real-gh-token',
        NEUTRON_CODEX_BUILD_EXEC_CMD: SANDBOX_BUILD,
      },
    })
    expect(r.status).toBe(0)

    // ── THE SANDBOX REALLY WAS CREDENTIAL-LESS, and it really could not publish.
    // Without these two lines the rest of this test would pass just as well against a
    // build that opened the PR itself, which is the arrangement this replaces.
    const sandbox = readFileSync(join(r.dir, 'sandbox.log'), 'utf8')
    expect(sandbox).toContain('sandbox GH_TOKEN=[]')
    expect(sandbox).toContain('sandbox pr create FAILED')

    // ── AND THE WORK LANDED ANYWAY. The branch is on the remote…
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim()
    const tip = spawnSync('git', ['ls-remote', 'origin', 'refs/heads/trident/a-run'], {
      cwd: r.dir,
      encoding: 'utf8',
    }).stdout.split('\t')[0]
    expect(tip).toBe(head)
    // …put there by the HOST (the build never ran a `git push` at all)…
    expect(r.stderr).not.toContain('CODEX_BUILD_PUSH_FAILED')
    // …and the PR was opened by the side that HAD the token, against the base branch
    // the run was given.
    expect(hostCalls(r.ghCalls)).toContain('pr create --head trident/a-run --base main --fill')

    // ── AND THE TRAILER SAYS SO, measured rather than assumed: the remote witnessed
    // our own sha, and the PR number came back from `gh pr list` after the create.
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(head)
    expect(r.trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe(head)
    expect(r.trailer['NEUTRON_CODEX_BUILD_PR']).toBe('77')
    expect(r.trailer['NEUTRON_CODEX_BUILD_BRANCH']).toBe('trident/a-run')
    expect(r.trailer['NEUTRON_CODEX_BUILD_DIFF']).toContain('branch.diff')
  })

  test('the codex child is handed NO GitHub credential — asserted against a dump that can prove it would see one', () => {
    // THE PROPERTY THIS WHOLE DESIGN BUYS. Moving the build off Anthropic must not be
    // paid for by giving a GPT-driven `danger-full-access` shell more reach, so the
    // publish capability moves to the host and the credential moves FURTHER from the
    // sandbox: `GH_TOKEN`/`GITHUB_TOKEN` are `env -u`'d off the codex process itself,
    // on top of the CLI's own `shell_environment_policy`.
    //
    // NO SEAM HERE — this is the real `codex exec` line, whose environment is dumped by
    // the mock `codex` on PATH.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      env: {
        GH_TOKEN: 'not-a-real-gh-token',
        GITHUB_TOKEN: 'not-a-real-github-token',
        // A variable of the SAME FAMILY that nothing removes. If the dump were empty,
        // truncated, or read with a matcher that cannot see this shape, this assertion
        // fails and the two absences below stop meaning anything.
        GH_TOKEN_DECOY: 'this-one-survives',
        // A plain sentinel: the wrapper passes its environment through, and here is a
        // variable that proves it.
        NEUTRON_CODEX_BUILD_PROBE: 'the-dump-and-the-grep-both-work',
      },
    })
    // POSITIVE CONTROLS FIRST.
    expect(r.codexEnv).not.toBe('')
    expect(r.codexEnv).toContain('NEUTRON_CODEX_BUILD_PROBE=the-dump-and-the-grep-both-work')
    expect(r.codexEnv).toContain('GH_TOKEN_DECOY=this-one-survives')
    // …and the HOST did have the credential, in the same run — so the absence below is
    // a boundary and not an empty environment.
    expect(r.ghCalls).toContain('GH_TOKEN=[not-a-real-gh-token]')

    // THE ASSERTION.
    expect(r.codexEnv).not.toContain('GH_TOKEN=')
    expect(r.codexEnv).not.toContain('GITHUB_TOKEN=')
    expect(r.codexEnv).not.toContain('not-a-real-gh-token')
    expect(r.codexEnv).not.toContain('not-a-real-github-token')
    // …and the families are named for the shells the model runs, one level down, where
    // this test cannot see without the real CLI.
    expect(r.codexArgv).toContain(
      '-c\nshell_environment_policy.exclude=["ANTHROPIC_*","CLAUDE_*","KIMI_*","GH_*","GITHUB_*"]\n',
    )
  })

  test('a commit that was never pushed does NOT yield a REMOTE_HEAD, and opens no PR', () => {
    // #545 IS THE REASON THE HOST STILL MEASURES. Doing the push itself does not make
    // the wrapper a witness to it: `REMOTE_HEAD` is still `git ls-remote` compared for
    // equality with our own sha, so a push that failed comes out empty and the run
    // stops rather than pinning a merge to a commit no reviewer can fetch.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      mergeMode: 'pr',
      // Commits, writes its diff, and then breaks `git push` — the failure happens on
      // the HOST's attempt, which is the only attempt there now is.
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: `${FAKE_BUILD}; ${BREAK_PUSH}` },
    })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('CODEX_BUILD_PUSH_FAILED')
    // The local commit is still reported — an operator recovers the work from it.
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(r.head)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).not.toBe('')
    // …and the two facts that would let it be reviewed or merged are empty.
    expect(r.trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe('')
    expect(r.trailer['NEUTRON_CODEX_BUILD_PR']).toBe('')
    // NO PR WAS OPENED FOR A BRANCH THAT IS NOT THERE. `gh pr create` is reached only
    // after a push that succeeded; a PR pointing at a branch the remote has never seen
    // is worse than no PR.
    expect(r.ghCalls).not.toContain('pr create')
    // The remote really is empty, so the assertions above are about a fact.
    expect(
      spawnSync('git', ['ls-remote', 'origin', 'refs/heads/trident/a-run'], {
        cwd: r.dir,
        encoding: 'utf8',
      }).stdout.trim(),
    ).toBe('')
  })

  test('a round that produced NO COMMIT publishes nothing, even standing on the right branch', () => {
    // THE GATE THE PUBLISH SITS BEHIND. `HEAD` may only name a commit this run
    // produced, and the push is keyed off that same value — so a build that edited
    // without committing, or a re-entry whose first act is `git switch`, cannot push a
    // branch state it did not make or open a PR for someone else's round.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      mergeMode: 'pr',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_NO_COMMIT },
    })
    expect(r.status).toBe(0)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe('')
    expect(r.trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe('')
    expect(r.ghCalls).not.toContain('pr create')
    expect(
      spawnSync('git', ['ls-remote', 'origin', 'refs/heads/trident/a-run'], {
        cwd: r.dir,
        encoding: 'utf8',
      }).stdout.trim(),
    ).toBe('')
    // THE POSITIVE CONTROL, one line different: the same fixture with a build that
    // COMMITS does push and does open the PR. Without it, a wrapper that had simply
    // stopped publishing altogether would pass the assertions above.
    const built = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      mergeMode: 'pr',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(built.trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe(built.head)
    expect(built.ghCalls).toContain('pr create')
  })

  test('a commit made on the WRONG BRANCH is not published either', () => {
    // The other gate the publish inherits: a head measured while standing anywhere but
    // the branch this run was asked for is work the run cannot merge, and pushing it
    // would put a branch on the remote that no later step ever looks at.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      mergeMode: 'pr',
      env: {
        NEUTRON_CODEX_BUILD_EXEC_CMD: `cat >/dev/null; git switch -q -c somewhere-else; echo built >> built.txt; git add built.txt; git commit -q -m 'the codex build'`,
      },
    })
    expect(r.status).toBe(0)
    expect(r.trailer['NEUTRON_CODEX_BUILD_BRANCH']).toBe('somewhere-else')
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe('')
    expect(r.ghCalls).not.toContain('pr create')
    expect(
      spawnSync('git', ['ls-remote', 'origin'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim(),
    ).toBe('')
  })

  test('a codex run that FAILED after committing is not published', () => {
    // The trailer still reports the sha, because an operator recovering the work needs
    // it — but the workflow discards this round, and a PR for a discarded round is
    // litter nobody asked for.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      mergeMode: 'pr',
      env: {
        NEUTRON_CODEX_BUILD_EXEC_CMD: `cat >/dev/null; echo built >> built.txt; git add built.txt; git commit -q -m 'the codex build'; exit 7`,
      },
    })
    expect(r.status).toBe(5)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(r.head)
    expect(r.ghCalls).not.toContain('pr create')
    expect(
      spawnSync('git', ['ls-remote', 'origin', 'refs/heads/trident/a-run'], {
        cwd: r.dir,
        encoding: 'utf8',
      }).stdout.trim(),
    ).toBe('')
  })

  test('LOCAL mode publishes nothing at all — no push, no PR', () => {
    const r = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      mergeMode: 'local',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(r.status).toBe(0)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(r.head)
    expect(r.ghCalls).toBe('')
    expect(
      spawnSync('git', ['ls-remote', 'origin'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim(),
    ).toBe('')
  })

  test('a FIX ROUND reuses the existing PR — the host never opens a duplicate', () => {
    // The same rule the Forge contract states for the Claude builder, now enforced by
    // the side that does the opening. `gh pr create` on a branch that already has a PR
    // either fails or opens a second one for the same work.
    const first = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      mergeMode: 'pr',
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(first.trailer['NEUTRON_CODEX_BUILD_PR']).toBe('77')
    const creates = (calls: string): number =>
      calls.split('\n').filter((l) => l.includes('pr create')).length
    expect(creates(first.ghCalls)).toBe(1)

    // Round 2 in the same fixture: a second commit on the same branch.
    const second = rerun(first, FAKE_BUILD_NO_DIFF, undefined, 'pr')
    expect(second.status).toBe(0)
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: first.dir, encoding: 'utf8' }).stdout.trim()
    // It pushed the new commit…
    expect(second.trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe(head)
    // …reported the SAME PR…
    expect(second.trailer['NEUTRON_CODEX_BUILD_PR']).toBe('77')
    // …and never asked for another one.
    expect(creates(readFileSync(join(first.dir, 'gh-calls.txt'), 'utf8'))).toBe(1)
  })
})

describe.skip('obsolete wrapper capability preflight', () => {
  // THE PRECHECK CHANGED SUBJECT, NOT PLACE. It used to ask whether the SANDBOX could
  // push; the answer no longer matters, because the sandbox does not push. It now asks
  // whether THIS PROCESS can push and can open a PR — the two commands it will run —
  // and it still asks before codex is launched, so a run that cannot deliver costs a
  // round and no tokens instead of a full build reported as "nothing was built".

  test('a working push credential and an UNAUTHENTICATED gh still DEFERS, before any build', () => {
    // EXACTLY THE 2026-08-13 RUN: the push half worked and the PR half did not, and
    // nothing asked. The build ran, committed, and had nowhere to deliver.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      mergeMode: 'pr',
      ghAuthExit: 1,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('CODEX_BUILD_NO_GH_CREDENTIAL')
    // AND THE BUILD NEVER RAN — the whole value of asking here. `FAKE_BUILD` commits.
    expect(r.head).toBe(r.baseHead)
  })

  test('…and the SAME fixture with an authenticated gh builds — the probe reads the answer', () => {
    // The positive control. Without it a probe that could never succeed would produce
    // the same red as one that correctly found nothing.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      mergeMode: 'pr',
      ghAuthExit: 0,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(r.stderr).not.toContain('CODEX_BUILD_NO_GH_CREDENTIAL')
    expect(r.status).toBe(0)
    expect(r.head).not.toBe(r.baseHead)
  })

  test('NO `gh` at all in pr mode DEFERS naming the CLI, not the credential', () => {
    // Two different missing pieces, two different things to install. Reporting "no
    // credential" for a box with no `gh` would send the operator to `gh auth login`,
    // which cannot be run either.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      mergeMode: 'pr',
      noGh: true,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('CODEX_BUILD_NO_GH_CLI')
    expect(r.stderr).not.toContain('CODEX_BUILD_NO_GH_CREDENTIAL')
    expect(r.head).toBe(r.baseHead)
  })

  test('LOCAL mode opens no PR, so neither `gh` nor its credential is its problem', () => {
    const r = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      mergeMode: 'local',
      noGh: true,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('CODEX_BUILD_NO_GH_CLI')
    expect(r.head).not.toBe(r.baseHead)
  })

  test('a repo with NO origin is not asked about `gh` either', () => {
    // The mirror of the remote-baseline rule: a clone with no origin cannot push and
    // is not trying to, so a missing `gh` is not a defect in it.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      mergeMode: 'pr',
      noGh: true,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('CODEX_BUILD_NO_GH_CLI')
  })
})

describe.skip('obsolete inner remote witness', () => {
  test('a probe that ANSWERS is not asked again, however unwelcome the answer', () => {
    // The retry is for an UNANSWERED probe only. A tip that came back and is not our
    // sha is a real finding — a stale branch, a failed push, someone else's commit —
    // and re-asking would be waiting for the remote to change its mind, which is the
    // one way a true "not pushed" could turn into a false "pushed".
    const r = pushable()
    // Commits, and the push (the HOST's, now) fails — so the witness has a real "not
    // pushed" to answer, which is the answer that must not be re-asked.
    const probes = countingLsRemote(r.dir, { failPush: true })
    // See the sibling test: `rerun` passes no diff-file variable, so only the seam that
    // ends on its commit exits 0 and lets the host reach the publish step.
    const ours = rerun(r, FAKE_BUILD_NO_DIFF)
    expect(ours.stderr).toContain('CODEX_BUILD_PUSH_FAILED')
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim()
    expect(ours.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(head)
    expect(ours.trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe('')
    // ONE baseline probe and ONE witness probe. A retry loop that re-asked an answered
    // probe would show four, and would add 20s of remote round-trips to every build
    // that legitimately did not push.
    expect(probes()).toBe(2)
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

  test('a HANGING `git ls-remote` STOPS the phase cleanly instead of wedging it', () => {
    // THE SAME BOUND AS `gh`, on the probes that were still inside a command
    // substitution. `$(…)` returns when the PIPE closes, not when the process exits,
    // so an alarm that killed the process did nothing while a child still held stdout
    // — the wrapper waited on the remote forever and the build phase with it.
    //
    // A REAL `origin` IS LOAD-BEARING HERE: the wrapper skips both `ls-remote` probes
    // when the repo has no remote to ask, so the same fixture without one would never
    // reach the hanging shim and this test would be green against a wrapper with no
    // bound at all.
    //
    // The unanswerable remote is hit by the PRE-LAUNCH baseline first, so the outcome
    // is DEFERRED before a token is spent rather than a build whose provenance nobody
    // could check. What is under test is that it ENDED — three 10s alarms and an exit
    // code, not a wedged phase.
    const r = run({
      authed: true,
      codexLoginExit: 0,
      origin: true,
      hangingLsRemote: true,
      // Well short of the mock's 120s-per-call hang, and comfortably ABOVE the
      // wrapper's own worst case here — three baseline attempts capped at 10s each.
      // WHICH of the two happened is the assertion — a signal means a bound did not
      // hold — not how long it took.
      spawnTimeoutMs: 90_000,
      env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_BUILD },
    })
    expect(r.signal).toBeNull()
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('CODEX_BUILD_NO_REMOTE_BASELINE')
  }, 180_000)

  test('a WITNESS probe that hangs costs the run a fact, never the build phase', () => {
    // The other half of the bound, now that the baseline refuses rather than shrugs.
    // Here the baseline ANSWERS and the post-build witness is the one that wedges: the
    // build has already happened and its tokens are spent, so an unanswerable remote
    // must cost a field and nothing more. `emit_trailer` also runs on the failure path,
    // where a hang would eat the DEFERRED report the bridge is waiting for.
    const r = pushable()
    // Probe 1 (baseline) answers; probes 2-4 (the three witness attempts) hang.
    countingLsRemote(r.dir, { hang: [2, 3, 4] })
    // Well short of the shim's 120s-per-call hang, and above the wrapper's own worst
    // case here — three witness attempts capped at 10s each.
    const built = rerun(r, `${FAKE_BUILD}; git push -q origin trident/a-run`, 90_000)
    expect(built.signal).toBeNull()
    expect(built.status).toBe(0)
    // The local measurement is unaffected: the build's own commit is still reported.
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim()
    expect(built.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe(head)
    // …and the one fact the remote owed us is empty rather than guessed — even though
    // the commit really IS on the remote, because an unanswered probe is not a witness.
    expect(built.trailer['NEUTRON_CODEX_BUILD_REMOTE_HEAD']).toBe('')
    expect(Object.keys(built.trailer)).toHaveLength(6)
  }, 180_000)

  test('the trailer is emitted on the FAILURE path too', () => {
    // A codex run that died after committing still left work on the branch, and the
    // operator recovering it needs to be told the sha. The exit code is what makes
    // the run stop; the trailer is what makes the stop diagnosable.
    const r = run({ authed: true, codexLoginExit: 0, env: { NEUTRON_CODEX_BUILD_EXEC_CMD: FAKE_FAIL } })
    expect(r.status).toBe(5)
    expect(r.trailer['NEUTRON_CODEX_BUILD_HEAD']).toBe('')
    expect(Object.keys(r.trailer)).toHaveLength(6)
  })

  test('all six trailer keys are present for a build that COMMITTED, one that did NOT, and one that FAILED', () => {
    // A missing key and an empty key read the same to a regex; the bridge is told to
    // copy six values, so six must always be there to copy. Three shapes of build, not
    // "every path" — the paths that never reach codex write no trailer at all, which
    // is the test below this one.
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

describe('outer-loop publishing boundary', () => {
  test('the inner wrapper never pushes, opens a PR, or probes a GitHub credential', () => {
    expect(SCRIPT_TEXT).not.toMatch(/^\s*(?:env\s+\S+\s+)*git push\b/m)
    expect(SCRIPT_TEXT).not.toMatch(/^\s*gh pr create\b/m)
    expect(SCRIPT_TEXT).not.toMatch(/^\s*(?:env\s+\S+\s+)*git credential fill\b/m)
    expect(SCRIPT_TEXT).not.toMatch(/^\s*gh auth status\b/m)
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
