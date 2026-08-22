/**
 * #321 — guard the CI workflow's PR trigger + concurrency keying.
 *
 * PR #10 (a slashed `feat/google-workspace-...` head) merged with only
 * CodeQL+Analyze signal: the ci.yml `test` job never fired. Root cause was the
 * `concurrency: ci-${{ github.ref }}` group — keying on a ref whose shape
 * varies by branch name let the `test` run be superseded/skipped for some
 * branch shapes. The fix keys PR runs on the PR NUMBER (always slash-free),
 * namespaced by workflow, so every PR to main gets its own independent `test`
 * run regardless of head-branch name.
 *
 * This is a text-level guard (the repo has no YAML parser dependency): it
 * asserts the trigger + concurrency invariants that keep the `test` gate
 * firing, so a regression to the old `ci-${{ github.ref }}` form fails CI.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const CI_YML = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url))
const yml = readFileSync(CI_YML, 'utf8')

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

describe('#321 ci.yml test-gate always fires on PRs to main', () => {
  test('triggers on pull_request with no branch/type filter that could exclude PRs', () => {
    // `pull_request:` present with no nested `branches:`/`types:` narrowing.
    expect(yml).toMatch(/^on:\n(?:.*\n)*?\s{2}pull_request:\s*\n/m)
    // The pull_request key must be bare (next non-blank line is another top-level
    // `on:` key, not an indented filter under pull_request).
    expect(yml).not.toMatch(/pull_request:\s*\n\s+branches:/)
    expect(yml).not.toMatch(/pull_request:\s*\n\s+paths:/)
  })

  test('concurrency keys PR runs on the slash-free PR number, not the raw ref', () => {
    // The fixed pattern: PR number (slash-free) || ref, namespaced by workflow.
    expect(yml).toContain('github.event.pull_request.number || github.ref')
    // The regressed pattern must be gone.
    expect(yml).not.toMatch(/group:\s*ci-\$\{\{\s*github\.ref\s*\}\}/)
  })

  test('defines the `test` job', () => {
    expect(yml).toMatch(/^\s{2}test:\s*$/m)
  })
})

/**
 * G5 — typecheck completeness.
 *
 * The old gate ran only the root `tsc --noEmit`, whose include list never
 * reached trident/, app/, work-board/, project-credentials/, jwt-validator/,
 * landing/chat-react/, or their test files — so real type errors shipped
 * invisibly. The fix runs `tsc -p` for EVERY tsconfig on disk via
 * `scripts/ci/typecheck-all.sh`. These tests pin two invariants so the class of
 * "a package silently escapes typechecking" cannot regress:
 *
 *  1. CI invokes the matrix script (not a single bare `tsc --noEmit`), and the
 *     script's dynamic discovery covers EVERY tsconfig.json on disk — proven by
 *     an INDEPENDENT filesystem walk here, so a narrowed `find` in the script is
 *     caught even though the script uses `find` internally.
 *  2. Server configs (root + shared base) do NOT ship the DOM lib, so browser
 *     globals like `document` cannot typecheck inside server code; browser
 *     leaves (landing) still own DOM.
 */
describe('G5 CI typechecks every tsconfig on disk', () => {
  const MATRIX_SH = join(REPO_ROOT, 'scripts/ci/typecheck-all.sh')

  // Independent enumeration: walk the repo ourselves, skipping node_modules,
  // and collect every file literally named `tsconfig.json`.
  function findTsconfigsOnDisk(): string[] {
    const out: string[] = []
    const walk = (abs: string) => {
      for (const ent of readdirSync(abs, { withFileTypes: true })) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue
        const child = join(abs, ent.name)
        if (ent.isDirectory()) walk(child)
        else if (ent.name === 'tsconfig.json')
          out.push(relative(REPO_ROOT, child))
      }
    }
    walk(REPO_ROOT)
    return out.sort()
  }

  test('ci.yml runs the tsc-matrix script, not a single bare `tsc --noEmit`', () => {
    expect(yml).toContain('scripts/ci/typecheck-all.sh')
    // The regressed single-config gate must be gone (the matrix script is the
    // only typecheck entrypoint).
    expect(yml).not.toMatch(/run:\s*bunx tsc --noEmit\s*$/m)
  })

  // ISSUES #406 — I/O-bound GATE test: it walks the repo tree / spawns a
  // subprocess, so it is not a unit test and bun's 5s default is the wrong
  // budget for it. Measured 4 failures across 5 runs under 10x CPU load, all
  // as ~5000ms timeouts rather than assertion failures. The assertion is
  // deterministic; only the wall-clock allowance was too tight.
  test('the matrix (--list) covers every tsconfig.json on disk', () => {
    const listed = execFileSync('bash', [MATRIX_SH, '--list'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .sort()

    const onDisk = findTsconfigsOnDisk()

    // Every tsconfig the matrix script would check must exist on disk, and every
    // tsconfig on disk must be in the matrix — set equality proves completeness.
    expect(listed).toEqual(onDisk)
    // Sanity: the previously-escaping packages are now in the matrix.
    for (const must of [
      'tsconfig.json',
      'trident/tsconfig.json',
      'app/tsconfig.json',
      'work-board/tsconfig.json',
      'project-credentials/tsconfig.json',
      'jwt-validator/tsconfig.json',
      'landing/chat-react/tsconfig.json',
    ]) {
      expect(listed).toContain(must)
    }
  }, 30_000)

  test('server configs (root + base) do NOT ship the DOM lib', () => {
    const readLib = (rel: string): string[] => {
      const raw = readFileSync(join(REPO_ROOT, rel), 'utf8')
      // Strip // line comments so JSONC parses.
      const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''))
      return json.compilerOptions?.lib ?? []
    }
    expect(readLib('tsconfig.json')).not.toContain('DOM')
    expect(readLib('tsconfig.base.json')).not.toContain('DOM')
  })

  test('browser leaves still own the DOM lib', () => {
    const landing = JSON.parse(
      readFileSync(join(REPO_ROOT, 'landing/tsconfig.json'), 'utf8').replace(
        /^\s*\/\/.*$/gm,
        '',
      ),
    )
    expect(landing.compilerOptions.lib).toContain('DOM')
  })
})

/**
 * Parallelised CI (2026-07-28) — guards on the aggregator that keeps the
 * REQUIRED `test` context honest.
 *
 * `test` and `CodeQL` are required status checks on `main` with a strict
 * up-to-date policy. Two ways to break merging on this repo, both silent:
 *
 *   1. Rename or matrix-ify `test`. The required context then NEVER reports and
 *      every PR blocks forever, with no failing check to point at.
 *   2. Let `test` pass while a gate did not. Sharding means no single run proves
 *      full coverage any more — the whole-suite guarantee needs every shard to
 *      report, and this job is what enforces that.
 */
describe('parallel CI aggregator', () => {
  const GATES = ['typecheck', 'lint', 'purity', 'layering', 'shard']

  test('a job named exactly `test` still exists — it is a REQUIRED context', () => {
    // Renaming it does not fail anything visibly; it just stops the required
    // check from ever reporting, and merging dies quietly.
    expect(yml).toMatch(/^ {2}test:$/m)
  })

  test('`test` needs EVERY gate, so none can be silently dropped', () => {
    const needs = yml.match(/^ {2}test:[\s\S]*?needs:\s*\[([^\]]+)\]/m)?.[1] ?? ''
    const listed = needs.split(',').map((s) => s.trim())
    for (const g of GATES) expect(listed).toContain(g)
    // Every job defined in the file except `test` itself must be depended on —
    // catches a NEW gate job added without wiring it into the aggregator, which
    // would run and be ignored.
    // Scope to the jobs: section — the top-level `on:` block also has 2-space
    // keys (`push:`), and matching those would demand `test` depend on a trigger.
    const jobsBlock = yml.slice(yml.indexOf('\njobs:\n'))
    const defined = [...jobsBlock.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]!)
    for (const j of defined.filter((j) => j !== 'test')) expect(listed).toContain(j)
  })

  test('`test` runs on failure (`if: always()`) — a skipped required check blocks nothing', () => {
    // Without always(), a failing gate SKIPS this job. GitHub does not treat a
    // skipped required check as a failure, so the PR would look mergeable.
    expect(yml).toMatch(/^ {2}test:[\s\S]*?if: always\(\)/m)
  })

  test('the aggregator fails unless every result is exactly `success`', () => {
    // Checking for the absence of 'failure' would pass on 'skipped'/'cancelled'.
    expect(yml).toContain('if [ "$r" != "success" ]')
  })

  test('the shard matrix size MATCHES the /N in NEUTRON_TEST_SHARD', () => {
    // THE silent coverage hole: widen the matrix to 6 legs but leave the spec at
    // /4 and shards 5-6 run nothing while everything stays green. Both numbers
    // live in this file, so they can and must be cross-checked.
    const legsRaw = yml.match(/shard: \[([^\]]+)\]/)?.[1]
    expect(legsRaw).toBeDefined()
    const legs = legsRaw!.split(',').length
    const denom = Number(yml.match(/NEUTRON_TEST_SHARD: \$\{\{ matrix\.shard \}\}\/(\d+)/)?.[1])
    expect(legs).toBeGreaterThan(1)
    expect(denom).toBe(legs)
  })

  test('shards do not fail-fast — one failure must not mask the others', () => {
    // Cancelling siblings turns "12 files broken" into "1 file broken" and costs
    // a full round-trip per remaining failure.
    // Anchored to a real YAML key. The first version of this matched anywhere in
    // the file — including the COMMENT above the setting that explains it — so
    // flipping the setting to true left the test green. Caught by mutation.
    expect(yml).toMatch(/^\s+fail-fast: false$/m)
  })

  test('the layering job checks out full history for the ratchet-growth guard', () => {
    // depcruise-ratchet-guard.sh diffs the baseline against origin/main; a
    // depth-1 checkout has no origin/main and the guard degrades.
    expect(yml).toMatch(/^ {2}layering:[\s\S]*?fetch-depth: 0/m)
  })
})

/**
 * 2026-07-29 — the leak gate's Tier-1 rule is only as real as its WIRING.
 *
 * `scripts/ci/leak-gate.sh` read `LEAK_GATE_PII_DENYLIST_B64`, found it unset,
 * warned, skipped the rule and exited 0 "SILENT" — on ~3,700 consecutive runs.
 * Root cause was in TWO places at once: the repository secret did not exist, and
 * no workflow passed the variable, so even creating the secret would have changed
 * nothing. The gate is now fail-closed, but fail-closed only converts a silent
 * hole into a loud one if the workflow actually hands it the inputs.
 *
 * These are text-level guards (the repo has no YAML parser dependency). They
 * exist so that deleting an `env:` line — the single edit that would silently
 * decommission the rule again — fails CI instead of passing it.
 */
describe('leak gate wiring — the env the script needs actually reaches it', () => {
  /** The lines of one top-level job, bounded by the next job key. */
  function jobBlock(name: string): string {
    const start = yml.indexOf(`\n  ${name}:\n`)
    expect(start).toBeGreaterThan(-1)
    const rest = yml.slice(start + 1)
    const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/)
    return next === -1 ? rest : rest.slice(0, next)
  }
  const purity = jobBlock('purity')

  test('the denylist SECRET is passed into the leak-gate step', () => {
    expect(purity).toMatch(
      /LEAK_GATE_PII_DENYLIST_B64:\s*\$\{\{\s*secrets\.LEAK_GATE_PII_DENYLIST_B64\s*\}\}/,
    )
  })

  test('the fork signal is passed, so genuine fork PRs are not hard-failed', () => {
    // Without this the gate cannot distinguish "fork, secrets withheld by GitHub"
    // from "canonical, wire broken", and every fork PR would exit 2.
    expect(purity).toMatch(
      /LEAK_GATE_PR_HEAD_REPO:\s*\$\{\{\s*github\.event\.pull_request\.head\.repo\.full_name\s*\}\}/,
    )
  })

  test('the commit-message scan window is passed', () => {
    expect(purity).toContain('LEAK_GATE_BASE_SHA:')
    expect(purity).toContain('github.event.pull_request.base.sha')
    expect(purity).toContain('github.event.before')
  })

  test('PR title and body are passed for scanning', () => {
    expect(purity).toContain('LEAK_GATE_PR_TITLE:')
    expect(purity).toContain('LEAK_GATE_PR_BODY:')
  })

  test('attacker-controlled PR text is never interpolated into a `run:` script', () => {
    // `${{ github.event.pull_request.body }}` inside a `run:` block is a shell
    // injection sink. It must reach the gate through `env:` only.
    const runBlocks = [...yml.matchAll(/run: \|[\s\S]*?(?=\n {6}[a-z-]+:|\n {4}- |\n {2}[a-z])/g)]
      .map((m) => m[0])
      .join('\n')
    expect(runBlocks).not.toContain('github.event.pull_request.body')
    expect(runBlocks).not.toContain('github.event.pull_request.title')
  })

  test('the purity job checks out full history for the commit-message scan', () => {
    // A depth-1 checkout has neither the PR base sha nor origin/main, and the
    // gate hard-fails rather than skipping the half of itself that covers the
    // one surface with no remediation (GHArchive mirrors commit messages).
    expect(purity).toContain('fetch-depth: 0')
  })
})

describe('scheduled full leak-gate scan', () => {
  const NIGHTLY = fileURLToPath(new URL('../../.github/workflows/leak-gate-nightly.yml', import.meta.url))

  /**
   * Read INSIDE each test, never at describe scope.
   *
   * Caught by mutation: with `readFileSync` hoisted to the describe body, deleting
   * leak-gate-nightly.yml threw while bun was still COLLECTING tests, so all three
   * cases silently vanished and the run reported `20 pass / 0 fail`. A guard whose
   * removal reddens nothing is not a guard — the file's existence has to be an
   * assertion, not a precondition.
   */
  function nightlyYml(): string {
    expect(existsSync(NIGHTLY)).toBe(true)
    return readFileSync(NIGHTLY, 'utf8')
  }

  test('the workflow file exists at all', () => {
    expect(existsSync(NIGHTLY)).toBe(true)
  })

  test('runs on a schedule — the context guaranteed to hold secrets', () => {
    const nightly = nightlyYml()
    // A fork PR legitimately skips Tier-1. Without a scheduled pass that closes
    // that hole, a fork PR could merge PII and nothing would ever look again.
    expect(nightly).toMatch(/^on:\n(?:.*\n)*?\s{2}schedule:\s*\n/m)
    expect(nightly).toMatch(/- cron: '[^']+'/)
  })

  test('passes the denylist secret (a scan without it proves nothing)', () => {
    expect(nightlyYml()).toMatch(
      /LEAK_GATE_PII_DENYLIST_B64:\s*\$\{\{\s*secrets\.LEAK_GATE_PII_DENYLIST_B64\s*\}\}/,
    )
  })

  test('invokes the same gate over the whole tree', () => {
    expect(nightlyYml()).toContain('scripts/ci/leak-gate.sh --tree .')
  })
})

/**
 * The governed-repo attributes gate is only a gate if a job RUNS it.
 *
 * `scripts/ci/check-governed-repo-attributes.ts` shipped in #315 with no
 * workflow step at all — the property it names ("this log union-merges in every
 * fresh clone") was unguarded for as long as it existed, which is the same
 * shape of hole the leak-gate wiring tests above exist to close. Its own
 * subprocess tests prove the script is CORRECT; nothing there can prove it is
 * REACHED. Deleting the `- run:` line must fail CI, not pass it.
 *
 * PRESENCE OF THE LINE IS NOT ENOUGH, and that gap was real: a first version of
 * this suite asserted only that the `- run:` key existed, so `if: false` or
 * `continue-on-error: true` on the very same step left it green while the gate
 * decided nothing. Both are single-word edits, both read as configuration
 * rather than as deletion, and both are exactly what a red gate tempts somebody
 * into. The check below is a pure function over YAML text so the MUTATIONS can
 * be run against it here — a guard whose own bypass is untested is the shape of
 * hole it exists to close.
 *
 * AND THE THIRD CLASS IS THE SHELL, which this suite missed while its own
 * docblock said "with its exit code honoured". Appending `|| true` to the `run:`
 * line leaves the step present, unconditional, `continue-on-error`-free — and
 * green regardless of what the gate decides. It was reproduced against this file
 * as a CONFIRMED blocker: the mutation landed, the suite stayed 0-fail, and the
 * deleted-step control still went red, so the suite was proving only that a
 * string was present in a file. `|| :`, `; true`, a pipe, a trailing `&` and a
 * `set +e` prefix are the same edit in other spellings, and all six are
 * mutations below.
 */
describe('governed-repo attributes gate is wired into ci.yml', () => {
  const GATE_RUN = 'bun scripts/ci/check-governed-repo-attributes.ts'
  /** The step line exactly as ci.yml writes it, so a mutation stays valid YAML. */
  const GATE_STEP = `      - run: ${GATE_RUN} .`

  /** The lines of one top-level job, bounded by the next job key. */
  function jobBlock(source: string, name: string): string {
    const start = source.indexOf(`\n  ${name}:\n`)
    if (start === -1) return ''
    const rest = source.slice(start + 1)
    const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/)
    return next === -1 ? rest : rest.slice(0, next)
  }

  /**
   * Why the gate would not decide anything, or `null` if it would.
   *
   * A step runs unconditionally, with its exit code honoured, when it carries
   * neither an `if:` (which can evaluate false) nor `continue-on-error: true`
   * (which discards its exit code); when the job around it carries neither
   * either; AND when the gate is the whole shell command, since `|| true` and
   * friends discard the status without either key appearing anywhere.
   */
  function whyNotGating(source: string): string | null {
    const job = jobBlock(source, 'layering')
    if (job === '') return 'no layering job'

    const lines = job.split('\n')
    // A STATIC regex for the shape plus a plain substring for the command.
    // Building the pattern by escaping `GATE_RUN` into a `new RegExp` was an
    // incomplete escape (it handled `/` and `.` and not `\`) — CodeQL's
    // js/incomplete-sanitization, flagged high, and it is a real class of bug
    // even where today's input is a literal. There is no reason to compile a
    // constant into a pattern.
    const stepAt = lines.findIndex((l) => /^\s+- run: /.test(l) && l.includes(GATE_RUN))
    if (stepAt === -1) return 'no step runs the gate'

    // `if:` and `continue-on-error:` are not the only single-edit bypasses. The
    // SHELL swallows an exit code just as quietly and does not read as
    // configuration at all: `… || true` is the canonical one, and `; true`, a
    // pipe (a pipeline reports its LAST command's status), a trailing `&`, and a
    // `set +e;` prefix are the same move in other spellings. A step wearing any
    // of them still shows up green in the log with the gate's own ❌ printed
    // above it. So the gate command must be the WHOLE command: nothing before
    // it, and nothing after it but its argument.
    const runLine = lines[stepAt] ?? ''
    const command = runLine.slice(runLine.indexOf('- run:') + '- run:'.length)
    const before = command.slice(0, command.indexOf(GATE_RUN))
    const after = command.slice(command.indexOf(GATE_RUN) + GATE_RUN.length)
    if (before.trim().length > 0) return 'step wraps the gate in another command'
    if (/[|;&]/.test(after)) return 'step discards the gate exit code'

    // The step is every line from its `- ` marker until the next one at the
    // same indent (a step's own keys are indented deeper than its dash).
    const indent = (lines[stepAt] ?? '').search(/\S/)
    const step: string[] = [lines[stepAt] ?? '']
    for (let i = stepAt + 1; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (line.trim().length === 0) continue
      const at = line.search(/\S/)
      if (at <= indent) break
      step.push(line)
    }

    // Job-level keys sit at 4 spaces, before the `steps:` list. Slicing at a
    // missing `steps:` would hand the WHOLE job to the job-scope check, which
    // then trips on any step's legitimate `if:` — a false alarm dressed as a
    // finding, so an absent `steps:` is treated as no job-level block.
    const stepsAt = job.indexOf('\n    steps:')
    for (const [scope, block] of [
      ['step', step.join('\n')],
      ['job', stepsAt === -1 ? '' : job.slice(0, stepsAt)],
    ] as const) {
      if (/^\s+if:/m.test(block)) return `${scope} is conditional on an if:`
      if (/^\s+continue-on-error:\s*true/m.test(block)) return `${scope} sets continue-on-error: true`
    }
    return null
  }

  test('a job runs the gate, unconditionally, with its exit code honoured', () => {
    expect(whyNotGating(yml)).toBeNull()
  })

  // The controls. Each mutation is what someone reaches for to quiet a red
  // gate, and each must be caught — otherwise the test above proves only that a
  // string is present in a file.
  const mutations: Array<[string, (s: string) => string]> = [
    ['the step is deleted', (s) => s.split('\n').filter((l) => !l.includes(GATE_RUN)).join('\n')],
    [
      'the step is disabled with if: false',
      (s) => s.replace(GATE_STEP, `      - if: false\n        run: ${GATE_RUN} .`),
    ],
    [
      'the step keeps running but its failure is swallowed',
      (s) =>
        s.replace(GATE_STEP, `      - continue-on-error: true\n        run: ${GATE_RUN} .`),
    ],
    // The same two edits written the OTHER way round — the key AFTER the `run:`
    // line, which is how a person actually edits an existing step. These are the
    // ones that reach the step-block scan; the two above are caught earlier,
    // because moving `run:` off the `- ` marker already breaks the anchor.
    [
      'if: false is appended to the existing step',
      (s) => s.replace(GATE_STEP, `${GATE_STEP}\n        if: false`),
    ],
    [
      'continue-on-error is appended to the existing step',
      (s) =>
        s.replace(GATE_STEP, `${GATE_STEP}\n        continue-on-error: true`),
    ],
    [
      'the whole job is disabled',
      (s) => s.replace('\n  layering:\n', '\n  layering:\n    if: false\n'),
    ],
    // The SHELL-level bypasses. None of these is an `if:` or a
    // `continue-on-error:`, every one of them is a single trailing edit, and
    // every one leaves the step present, running, and green whatever the gate
    // decides. `|| true` is the one that actually got through: it was reported
    // as a CONFIRMED blocker against this very suite, whose own docblock claims
    // the exit code is honoured.
    ['the failure is swallowed with || true', (s) => s.replace(GATE_STEP, `${GATE_STEP} || true`)],
    ['the failure is swallowed with || :', (s) => s.replace(GATE_STEP, `${GATE_STEP} || :`)],
    ['the exit code is hidden behind a ; ', (s) => s.replace(GATE_STEP, `${GATE_STEP}; true`)],
    [
      'the gate is piped, so the pipeline reports the last command',
      (s) => s.replace(GATE_STEP, `${GATE_STEP} | tee /dev/null`),
    ],
    ['the gate is backgrounded with &', (s) => s.replace(GATE_STEP, `${GATE_STEP} &`)],
    [
      'errexit is turned off ahead of the gate',
      (s) => s.replace(GATE_STEP, `      - run: set +e; ${GATE_RUN} .`),
    ],
  ]

  for (const [name, mutate] of mutations) {
    test(`catches the bypass: ${name}`, () => {
      const mutated = mutate(yml)
      expect(mutated).not.toBe(yml) // the mutation landed
      expect(whyNotGating(mutated)).not.toBeNull()
    })
  }

  test('the gate script it names exists on disk', () => {
    // A wired step pointing at a moved file fails only at CI time, on main.
    expect(existsSync(join(REPO_ROOT, 'scripts/ci/check-governed-repo-attributes.ts'))).toBe(true)
  })
})

/**
 * THE AS-BUILT WRITE GUARD, AND WHY IT IS NOT WIRED IN ci.yml.
 *
 * The rule's first design was an eleven-line step in the `purity` job carrying
 * an event filter and a `GUARD_BASE_SHA`/`GUARD_HEAD_SHA` mapping. It could not
 * be built. No agent in this system can write `.github/workflows/`: the GitHub
 * token is scoped `repo read:org`, the absence of `workflow` scope is asserted
 * by test elsewhere in this repo, and a push touching that directory is rejected
 * by GitHub itself — "refusing to allow an OAuth App to create or update
 * workflow `.github/workflows/ci.yml` without `workflow` scope". Measured, not
 * assumed: the probe push was made and refused.
 *
 * So the rule is expressed in files the repo owns. `as-built-write-guard.sh`
 * reads its own event filter and its own base/head shas from the Actions event
 * payload, and `check-governed-repo-attributes.ts` — which the `layering` job
 * already runs unconditionally, with `fetch-depth: 0`, and which the describe
 * ABOVE already pins as exit-code-honouring — invokes it first and propagates
 * its status.
 *
 * That relocation trades one bypass surface for another, so this describe walks
 * BOTH new surfaces with the same mutation battery the yml walk used. The three
 * invariants that survive the move unchanged are the ones that matter: the guard
 * runs for pull requests and merge-group commits, push-to-main is excluded
 * because the outer-loop appender is the log's one legitimate writer, and the
 * exit code is never discarded.
 *
 * The one genuinely NEW risk is the opposite of a bypass: a guard that now
 * decides its own applicability can decide "not applicable" over a guarded
 * event and report clean. That is pinned hardest — inside Actions, a guarded
 * event with no readable shas must exit 2.
 */
describe('as-built write guard is wired into a gate the repo can own', () => {
  const GUARD_PATH = 'scripts/ci/as-built-write-guard.sh'
  const GATE_PATH = 'scripts/ci/check-governed-repo-attributes.ts'
  const guard = readFileSync(join(REPO_ROOT, GUARD_PATH), 'utf8')
  const gate = readFileSync(join(REPO_ROOT, GATE_PATH), 'utf8')

  /**
   * Why the gate would not enforce the guard, or `null` when it would. Read off
   * the gate's SOURCE, the same way the yml walk read the workflow: the guard
   * must be spawned, its exit code must reach `process.exit`, and nothing may
   * stand between the two.
   */
  function whyNotEnforcing(source: string): string | null {
    const spawnAt = source.indexOf('as-built-write-guard.sh')
    if (spawnAt === -1) return 'the gate never names the guard'
    if (!/Bun\.spawnSync\(\[\s*'bash'/.test(source)) return 'the gate does not spawn the guard'

    // The status must propagate VERBATIM. `exitCode !== 0 → process.exit(1)`
    // would collapse the guard's 2 (could not tell) into its 1 (wrote the log),
    // and every other spelling here discards it outright.
    //
    // SCOPED TO THIS GUARD'S OWN BODY, and that scoping is load-bearing rather
    // than tidiness. This read the WHOLE file until a second guard was hosted in
    // the same gate carrying the identical propagation line — at which point both
    // mutations below (collapse to 1, discard entirely) still left a matching line
    // elsewhere in the file, so the check stayed satisfied over a gutted guard and
    // reported it enforced. Caught by this describe's own mutation battery, which
    // is exactly what it is for. The window runs from the declaration to the
    // top-level call, so it contains this function and nothing else.
    const bodyStart = source.indexOf('function guardBranchWritesOfCanonicalLog')
    const bodyEnd = source.search(/^guardBranchWritesOfCanonicalLog\(\)$/m)
    const body = bodyStart === -1 || bodyEnd <= bodyStart ? '' : source.slice(bodyStart, bodyEnd)
    if (!/if \(guard\.exitCode !== 0\) process\.exit\(guard\.exitCode\)/.test(body)) {
      return 'the gate does not propagate the guard exit code verbatim'
    }

    // Called, not merely declared. A function defined and never invoked is the
    // exact shape of the merged-green-but-unwired defect this repo keeps hitting.
    if (!/^guardBranchWritesOfCanonicalLog\(\)$/m.test(source)) {
      return 'the guard invocation is declared but never called at top level'
    }

    // It must run BEFORE the attribute verdict's early exits, or a repo with no
    // log on disk returns 0 without the diff ever being read.
    const firstExit = source.indexOf('process.exit(0)')
    const callAt = source.search(/^guardBranchWritesOfCanonicalLog\(\)$/m)
    if (firstExit !== -1 && callAt > firstExit) return 'the guard runs after an early exit 0'

    return null
  }

  /** Why the guard would fail to guard a real PR, or `null` when it would. */
  function whyNotGuarding(source: string): string | null {
    // Both guarded events, each with the payload keys GitHub actually sends.
    if (!/pull_request \| pull_request_target\)/.test(source)) return 'pull_request is not a guarded event'
    if (!/merge_group\)/.test(source)) return 'the merge queue is not a guarded event'
    if (!source.includes('pull_request.base.sha') || !source.includes('pull_request.head.sha')) {
      return 'the pull_request payload mapping is incomplete'
    }
    if (!source.includes('merge_group.base_sha') || !source.includes('merge_group.head_sha')) {
      return 'the merge_group payload mapping is incomplete'
    }

    // The strict branch: inside Actions, a guarded event that yielded no sha is
    // exit 2. Without this, relocating the event filter into the script turns
    // every unreadable payload into a silent pass.
    if (!/GITHUB_ACTIONS:-\}" = "true"/.test(source)) return 'the guard is never strict inside Actions'
    // Bound the window to the strict `if` block ITSELF, up to its own `fi`. A
    // fixed 500-character window overlapped the GUARD_BASE_SHA checks that follow,
    // which carry the same "REFUSES to skip" text and `exit 2` — so a mutation
    // that gutted the strict branch entirely still read as intact. Caught by this
    // describe's own mutation battery, which is what it is for.
    const strictAt = source.search(/if \[ "\$\{GITHUB_ACTIONS:-\}" = "true"/)
    if (strictAt === -1) return 'the strict branch is not an if on GITHUB_ACTIONS'
    const strictEnd = source.indexOf('\nfi\n', strictAt)
    if (strictEnd === -1) return 'the strict branch is unterminated'
    const strictBlock = source.slice(strictAt, strictEnd)
    if (!/REFUSES to skip/.test(strictBlock) || !/exit 2/.test(strictBlock)) {
      return 'the strict branch does not exit 2'
    }

    // An explicit pair must stay strict — that is the contract the guard's own
    // unit tests drive, and the escape hatch for the outer loop.
    if (!/if \[ -z "\$\{GUARD_BASE_SHA:-\}" \] && \[ -z "\$\{GUARD_HEAD_SHA:-\}" \]/.test(source)) {
      return 'an explicit GUARD_BASE_SHA/GUARD_HEAD_SHA pair no longer wins'
    }

    return null
  }

  test('the layering gate enforces the guard and propagates its status', () => {
    expect(whyNotEnforcing(gate)).toBeNull()
  })

  test('the guard covers pull requests and merge-group commits, strictly', () => {
    expect(whyNotGuarding(guard)).toBeNull()
  })

  test('the gate that carries the guard is the one ci.yml runs unconditionally', () => {
    // The describe above owns this assertion for the gate itself; repeating the
    // command here is what ties the guard's reachability to it. If the layering
    // step is ever renamed or made conditional, this fails beside that one
    // rather than leaving the guard silently unreachable.
    expect(yml).toContain('- run: bun scripts/ci/check-governed-repo-attributes.ts .')
  })

  const gateMutations: Array<[string, (source: string) => string]> = [
    [
      'the invocation is deleted',
      (source) => source.split('\n').filter((line) => !/^guardBranchWritesOfCanonicalLog\(\)$/.test(line)).join('\n'),
    ],
    [
      'the guard is declared but never called',
      (source) => source.replace(/^guardBranchWritesOfCanonicalLog\(\)$/m, '// guardBranchWritesOfCanonicalLog()'),
    ],
    [
      'the exit code is collapsed to 1',
      (source) =>
        source.replace(
          'if (guard.exitCode !== 0) process.exit(guard.exitCode)',
          'if (guard.exitCode !== 0) process.exit(1)',
        ),
    ],
    [
      'the exit code is discarded',
      (source) => source.replace('if (guard.exitCode !== 0) process.exit(guard.exitCode)', ''),
    ],
    ['the guard is no longer named', (source) => source.replace(/as-built-write-guard\.sh/g, 'nothing.sh')],
  ]

  for (const [name, mutate] of gateMutations) {
    test(`catches the bypass: ${name}`, () => {
      const mutated = mutate(gate)
      expect(mutated).not.toBe(gate)
      expect(whyNotEnforcing(mutated)).not.toBeNull()
    })
  }

  const guardMutations: Array<[string, (source: string) => string]> = [
    ['the merge queue is dropped', (source) => source.replace('    merge_group)', '    never_group)')],
    [
      'the strict branch is removed',
      (source) => source.replace(/if \[ "\$\{GITHUB_ACTIONS:-\}" = "true" \][\s\S]*?\nfi\n/, ''),
    ],
    [
      'the strict branch passes instead of refusing',
      (source) =>
        source.replace(
          "echo \"as-built-write-guard: event '${GITHUB_EVENT_NAME:-<none>}' is guarded but GITHUB_EVENT_PATH yielded no base/head sha; the guard REFUSES to skip.\" >&2\n  exit 2",
          'exit 0',
        ),
    ],
    ['the pull_request head mapping is dropped', (source) => source.replace('pull_request.head.sha', '')],
    ['the explicit override stops winning', (source) => source.replace('if [ -z "${GUARD_BASE_SHA:-}" ] && [ -z "${GUARD_HEAD_SHA:-}" ]', 'if true')],
  ]

  for (const [name, mutate] of guardMutations) {
    test(`catches the bypass: ${name}`, () => {
      const mutated = mutate(guard)
      expect(mutated).not.toBe(guard)
      expect(whyNotGuarding(mutated)).not.toBeNull()
    })
  }

  test('the guard script it names exists on disk', () => {
    expect(existsSync(join(REPO_ROOT, GUARD_PATH))).toBe(true)
  })
})

/**
 * THE SAME RELOCATION, FOR THE MIGRATION ORDINAL GUARD — and this one needed it
 * more, because it spent five days on main running NOWHERE.
 *
 * `migration-ordinal-guard.sh` landed with #404 and had zero callers. Its own
 * header states it "lives in the `layering` job because that is the one job
 * checked out with full history" — it never got there, for the reason the
 * describe above documents: reaching `ci.yml` needs `workflow` scope, and this
 * system's token is `repo read:org`. A guard written to prevent a specific
 * outage, merged green, enforcing nothing.
 *
 * What it prevents is measured. On 2026-08-17 two branches took the same ordinal,
 * the duplicate was SILENTLY SKIPPED at migrate time, and the deploy shipped code
 * writing columns that did not exist — every dispatch died on `no such column`.
 * The runner's own duplicate refusal fires only once such a collision has already
 * merged, so a pre-merge gate is the only one that can help.
 *
 * The wiring is pinned the same way and for the same reason: `guardMigration-
 * OrdinalCollisions` is a function that could be defined and never called, which
 * is precisely the shape that let the guard sit inert in the first place. That
 * the original defect can be restored by deleting one line is exactly what the
 * mutation battery below exists to notice.
 *
 * NO EVENT FILTER IS PINNED HERE, unlike the as-built guard, and the asymmetry is
 * deliberate rather than an omission: this guard needs none, because on a push to
 * main the tree's ordinals ARE the base's, name for name, so it passes on its own
 * logic rather than by being skipped. What IS pinned is that it fails CLOSED — an
 * unresolvable base ref and a zero-file parse must both be failures, since
 * "parsed nothing" reading as "found nothing wrong" is an error this repository
 * has shipped more than once.
 */
describe('migration ordinal guard is wired into a gate the repo can own', () => {
  const ORDINAL_GUARD_PATH = 'scripts/ci/migration-ordinal-guard.sh'
  const ORDINAL_GATE_PATH = 'scripts/ci/check-governed-repo-attributes.ts'
  const ordinalGuard = readFileSync(join(REPO_ROOT, ORDINAL_GUARD_PATH), 'utf8')
  const ordinalGate = readFileSync(join(REPO_ROOT, ORDINAL_GATE_PATH), 'utf8')

  /** Why the gate would not enforce the ordinal guard, or `null` when it would. */
  function whyNotEnforcing(source: string): string | null {
    if (!source.includes('migration-ordinal-guard.sh')) return 'the gate never names the guard'
    if (!/^guardMigrationOrdinalCollisions\(\)$/m.test(source)) {
      return 'the guard invocation is declared but never called at top level'
    }
    // The status must reach `process.exit`, scoped to THIS guard's body — the
    // as-built guard above carries the identical line, so an unscoped search
    // would stay satisfied after this one's was deleted.
    const body = source.slice(source.indexOf('function guardMigrationOrdinalCollisions'))
    if (!/if \(guard\.exitCode !== 0\) process\.exit\(guard\.exitCode\)/.test(body)) {
      return 'the gate does not propagate the guard exit code'
    }
    // Before the attribute verdict's early exits, or a repo with no as-built log
    // returns 0 without the migrations ever being read.
    const firstExit = source.indexOf('process.exit(0)')
    const callAt = source.search(/^guardMigrationOrdinalCollisions\(\)$/m)
    if (firstExit !== -1 && callAt > firstExit) return 'the guard runs after an early exit 0'
    return null
  }

  /** Why the guard would fail to catch a real collision, or `null` when it would. */
  function whyNotGuarding(source: string): string | null {
    // A base ref it cannot read must be a FAILURE, never a skip — that is the
    // half that catches the race, and a shallow checkout would silently drop it.
    if (!/rev-parse --verify --quiet "\$BASE_REF"/.test(source)) {
      return 'the guard never resolves the base ref'
    }
    if (!source.includes('cannot resolve $BASE_REF')) return 'an unreadable base ref is not a failure'
    // Parsing zero migrations must be a failure, not a pass.
    if (!/\[ "\$count" -gt 0 \] \|\| fail/.test(source)) return 'a zero-file parse is not a failure'
    // The collision test itself: same ordinal, DIFFERENT name.
    if (!source.includes('[ -n "$theirs" ] && [ "$ours" != "$theirs" ]')) {
      return 'the guard no longer compares names at a shared ordinal'
    }
    return null
  }

  test('the gate enforces the ordinal guard today', () => {
    // POSITIVE CONTROLS FIRST — a regex over an empty string reports no problem,
    // which reads exactly like a pass.
    expect(ordinalGate.length).toBeGreaterThan(1000)
    expect(ordinalGuard.length).toBeGreaterThan(1000)
    expect(whyNotEnforcing(ordinalGate)).toBeNull()
    expect(whyNotGuarding(ordinalGuard)).toBeNull()
  })

  const ordinalGateMutations: Array<[string, (source: string) => string]> = [
    [
      'the invocation is deleted — the original defect, restored',
      (source) => source.replace(/^guardMigrationOrdinalCollisions\(\)$/m, ''),
    ],
    [
      'the guard is no longer named',
      (source) => source.replace(/migration-ordinal-guard\.sh/g, 'nothing.sh'),
    ],
    [
      'the exit code is discarded',
      (source) => {
        const at = source.indexOf('function guardMigrationOrdinalCollisions')
        return (
          source.slice(0, at) +
          source.slice(at).replace('if (guard.exitCode !== 0) process.exit(guard.exitCode)', '')
        )
      },
    ],
  ]

  for (const [name, mutate] of ordinalGateMutations) {
    test(`catches the bypass: ${name}`, () => {
      const mutated = mutate(ordinalGate)
      expect(mutated).not.toBe(ordinalGate)
      expect(whyNotEnforcing(mutated)).not.toBeNull()
    })
  }

  const ordinalGuardMutations: Array<[string, (source: string) => string]> = [
    [
      'an unreadable base ref becomes a skip',
      (source) => source.replace(/if ! git rev-parse --verify --quiet "\$BASE_REF"[\s\S]*?\nfi\n/, ''),
    ],
    [
      'a zero-file parse becomes a pass',
      (source) => source.replace(/\[ "\$count" -gt 0 \] \|\| fail[\s\S]*?trusting a pass\."\n/, ''),
    ],
    [
      'the name comparison is dropped, so a shared ordinal always looks fine',
      (source) =>
        source.replace('[ -n "$theirs" ] && [ "$ours" != "$theirs" ]', '[ -n "$theirs" ] && false'),
    ],
  ]

  for (const [name, mutate] of ordinalGuardMutations) {
    test(`catches the bypass: ${name}`, () => {
      const mutated = mutate(ordinalGuard)
      expect(mutated).not.toBe(ordinalGuard)
      expect(whyNotGuarding(mutated)).not.toBeNull()
    })
  }

  test('the guard script it names exists on disk', () => {
    expect(existsSync(join(REPO_ROOT, ORDINAL_GUARD_PATH))).toBe(true)
  })
})

/**
 * 2026-08-17 — the bun install cache is TEN UNLINKED LITERALS, so it needs a guard.
 *
 * `bun.lock` takes `gbrain` as a git dependency, so `bun install --frozen-lockfile`
 * is a network fetch from a third-party host — twelve times per PR across five
 * jobs. Each job now restores bun's install cache first. The wiring that makes
 * that work is an IDENTITY between two strings written independently in each job:
 * the `path:` actions/cache saves, and the `BUN_INSTALL_CACHE_DIR` bun writes to.
 * Nothing in YAML relates them.
 *
 * That matters more than a normal duplication, because of the failure MODE. Break
 * the identity in one job and the cache saves an empty directory and restores it
 * over and over: no error, no warning, a green job, and an install that fetches
 * from the third party forever. A cache that silently misses every run is
 * indistinguishable from no cache at all while looking fixed — which is precisely
 * the shape the original change was written to prevent, and it shipped with the
 * ci.yml header claiming the identity held "by construction" when nothing held it.
 *
 * So it is asserted here instead, per job, by WALKING the file: the checks are
 * generated from whatever jobs actually install, so a new installing job is
 * covered the day it is added rather than whenever someone remembers. The one
 * hardcoded thing is the roster in the first test, and it is deliberate — it is
 * the positive control. Without it a walk that silently matched NOTHING would
 * report every check below as passing, which is the same false-green this whole
 * block exists to stop. Adding an installing job is meant to fail that one test
 * until the roster names it.
 *
 * 2026-08-18 — REWRITTEN AS ONE PURE PREDICATE PLUS EXECUTED MUTATIONS, because
 * the first version's mutation list was PROSE. It claimed ten mutations had been
 * tried; nothing re-ran them, and review found two the checks did not actually
 * catch:
 *
 *   1. HOISTING THE CACHE STEP ABOVE THE CHECKOUT. `hashFiles('bun.lock')` reads
 *      the workspace, so before a checkout it returns the EMPTY STRING and the key
 *      collapses to the `restore-keys` prefix — one entry, frozen forever at
 *      whatever the first run stored, restored on every later run whatever
 *      `bun.lock` says. The old checks passed on that mutation because they only
 *      asserted the key CONTAINED the text `hashFiles('bun.lock')`, which it still
 *      did. Text presence is not evaluation.
 *   2. BROADENING `restore-keys` TO `bun-install-`. That defeats the bun-version
 *      isolation the key exists to carry (a bun upgrade can change the cache's
 *      on-disk layout), and the old check only asserted the key STARTS WITH the
 *      prefix — which a shorter prefix satisfies even better.
 *
 * Both are now structural: the checkout must precede the cache step, and
 * `restore-keys` must equal the key with the lockfile-hash expression removed —
 * nothing broader, nothing narrower. And every mutation below is EXECUTED against
 * this file's own text, so the list cannot rot into a claim again.
 */
describe('bun install cache wiring', () => {
  const INSTALL_RUN = 'run: bun install --frozen-lockfile'
  const LOCK_HASH = "${{ hashFiles('bun.lock') }}"

  /** Split a workflow's `jobs:` mapping into { name -> body }. */
  function jobBlocks(source: string): Map<string, string> {
    const jobs = source.slice(source.indexOf('\njobs:\n') + 1)
    const out = new Map<string, string>()
    let name: string | null = null
    let buf: string[] = []
    for (const line of jobs.split('\n')) {
      const m = line.match(/^ {2}([a-z][a-z0-9-]*):$/)
      if (m) {
        if (name) out.set(name, buf.join('\n'))
        name = m[1]!
        buf = []
      } else if (name) buf.push(line)
    }
    if (name) out.set(name, buf.join('\n'))
    return out
  }

  function installingJobs(source: string): Array<[string, string]> {
    return [...jobBlocks(source)].filter(([, b]) => b.includes(INSTALL_RUN))
  }

  /**
   * The install step's `BUN_INSTALL_CACHE_DIR`, read from anywhere in that step's
   * `env:` block rather than from the line immediately after it. The first
   * version demanded it be the FIRST entry, so adding an unrelated env var above
   * it reddened the suite with the wiring completely unchanged — a false positive,
   * and false positives are what teach people to edit the test instead of the bug.
   */
  function installCacheDir(block: string): string | undefined {
    const lines = block.split('\n')
    const at = lines.findIndex((l) => l.includes(INSTALL_RUN))
    if (at === -1) return undefined
    let envAt = -1
    for (let i = at + 1; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (line.trim() === '') continue
      if (/^\s*- /.test(line)) break // the next step began; this install has no env:
      if (/^\s*env:\s*$/.test(line)) {
        envAt = i
        break
      }
    }
    if (envAt === -1) return undefined
    const envIndent = (lines[envAt] ?? '').search(/\S/)
    for (let i = envAt + 1; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (line.trim() === '') continue
      if (line.search(/\S/) <= envIndent) break
      const m = line.match(/^\s*BUN_INSTALL_CACHE_DIR:\s*(.+)$/)
      if (m) return m[1]!.trim()
    }
    return undefined
  }

  const cacheField = (block: string, field: string): string | undefined =>
    block.match(new RegExp(String.raw`uses: actions/cache@[\s\S]*?\n\s+${field}: (.+)`))?.[1]?.trim()

  /**
   * The whole guard as ONE function of the file's text, so the mutations below can
   * run it. Returns null when the wiring holds, or the reason it does not.
   */
  function whyCacheBroken(source: string): string | null {
    const installing = installingJobs(source)
    if (installing.length === 0) return 'the walk found no installing jobs'

    const keys = new Set<string>()
    const prefixes = new Set<string>()

    for (const [job, block] of installing) {
      const cachePath = cacheField(block, 'path')
      if (!cachePath) return `${job}: no actions/cache step with a path`
      const installDir = installCacheDir(block)
      if (!installDir) return `${job}: the install sets no BUN_INSTALL_CACHE_DIR`
      // The identity the whole change rests on. Compared as strings, so a typo, a
      // different `runner.*` context or a stray trailing segment all fail.
      if (installDir !== cachePath) return `${job}: cache path and BUN_INSTALL_CACHE_DIR differ`

      const checkoutAt = block.indexOf('uses: actions/checkout@')
      const cacheAt = block.indexOf('uses: actions/cache@')
      const installAt = block.indexOf(INSTALL_RUN)
      if (checkoutAt === -1) return `${job}: no checkout step`
      // hashFiles() reads the workspace: before a checkout it returns "" and the
      // key collapses to the restore-keys prefix, which then never changes again.
      if (checkoutAt > cacheAt) return `${job}: the cache is restored before the checkout`
      // Restoring after the install is a no-op that still saves, so it looks
      // exactly like a working cache while never serving one.
      if (cacheAt > installAt) return `${job}: the cache is restored after the install`

      // A tag is mutable, and this action runs with write access to the entry the
      // installs then trust.
      if (!/uses: actions\/cache@[0-9a-f]{40}\b/.test(block))
        return `${job}: the cache action is not pinned to a 40-hex sha`

      const bunVersion = block.match(/bun-version: (\S+)/)?.[1]
      if (!bunVersion) return `${job}: no bun-version`
      const key = cacheField(block, 'key')
      if (!key) return `${job}: the cache step has no key`
      // hashFiles('bun.lock') is what makes a dependency change re-fetch rather
      // than restore a tree the lockfile no longer describes. The bun version is
      // read from THIS job's setup-bun step so the two cannot drift.
      if (!key.includes(LOCK_HASH)) return `${job}: the key does not carry the lockfile hash`
      if (!key.includes(`bun${bunVersion}`)) return `${job}: the key does not carry this job's bun version`

      const prefix = block.match(/restore-keys: (.+)/)?.[1]?.trim()
      // Without restore-keys a one-line dependency bump re-downloads all 2500
      // packages — the exposure this change exists to reduce, reappearing on
      // exactly the PRs that touch dependencies.
      if (!prefix) return `${job}: no restore-keys`
      // It must be the key MINUS the lockfile hash. `startsWith` was not enough:
      // a SHORTER prefix also starts the key and throws away the bun-version
      // isolation, so a cache written under one bun layout is restored under
      // another.
      if (key.replace(LOCK_HASH, '') !== prefix)
        return `${job}: restore-keys is not the key minus the lockfile hash`

      keys.add(key)
      prefixes.add(prefix)
    }

    // Twelve legs paying for twelve separate entries is not a cache, it is twelve
    // caches — and it would blow through the repo's Actions cache quota while
    // still fetching from the third party on most legs.
    if (keys.size !== 1) return 'the installing jobs do not share one key'
    if (prefixes.size !== 1) return 'the installing jobs do not share one restore-keys prefix'
    return null
  }

  test('the walk finds the jobs that install — a parser that finds none proves nothing', () => {
    // Positive control for every assertion below. If jobBlocks() silently stops
    // matching (an indentation change, a renamed `jobs:` key), whyCacheBroken()
    // would have nothing to check. It returns a reason for the empty case, but
    // this is the check that names WHICH jobs are expected.
    expect(installingJobs(yml).map(([n]) => n).sort()).toEqual([
      'layering',
      'lint',
      'purity',
      'shard',
      'typecheck',
    ])
  })

  test('every installing job restores a cache that can actually hit', () => {
    expect(whyCacheBroken(yml)).toBeNull()
  })

  // The controls. Each one is a real edit someone could make while believing the
  // cache still works, and each must be caught — otherwise the test above proves
  // only that some strings are present in a file. Two of these (the hoist above
  // checkout, and the broadened restore-keys) PASSED the first version of this
  // guard; they are the reason it was rewritten.
  //
  // Each control names the reason it must be caught FOR. A control that trips a
  // different check than the one under test passes for an unrelated reason, which
  // makes it decoration: it would keep passing after the check it was written to
  // exercise had been deleted.
  const mutations: Array<[string, (s: string) => string, string]> = [
    [
      'the cache is hoisted above the checkout, so hashFiles reads an empty tree',
      (s) =>
        s.replace(
          /( {6}- uses: actions\/checkout@\S+[^\n]*\n)((?: {6}- uses: oven-sh\/setup-bun@[\s\S]*?\n)?(?: {8}[^\n]*\n)*)((?: {6}#[^\n]*\n)* {6}- uses: actions\/cache@[\s\S]*?restore-keys: [^\n]*\n)/,
          '$3$1$2',
        ),
      'restored before the checkout',
    ],
    [
      'restore-keys is broadened past the bun version',
      (s) => s.replace(/restore-keys: bun-install-[^\n]*/g, 'restore-keys: bun-install-'),
      'restore-keys is not the key minus the lockfile hash',
    ],
    [
      'the cache is restored after the install',
      (s) =>
        s.replace(
          /( {6}- uses: actions\/cache@[\s\S]*?restore-keys: [^\n]*\n)( {6}(?:#[^\n]*\n {6})*- run: bun install --frozen-lockfile\n(?: {8}[^\n]*\n)*)/,
          '$2$1',
        ),
      'restored after the install',
    ],
    [
      'the path identity is broken in one job',
      (s) => s.replace('path: ${{ runner.temp }}/bun-install-cache', 'path: ${{ runner.temp }}/bun-cache'),
      'cache path and BUN_INSTALL_CACHE_DIR differ',
    ],
    [
      'hashFiles is dropped from the key',
      (s) => s.replace(/key: bun-install-[^\n]*/, 'key: bun-install-${{ runner.os }}-bun1.3.9-fixed'),
      'does not carry the lockfile hash',
    ],
    [
      'the cache action is tag-pinned',
      (s) => s.replace(/uses: actions\/cache@[0-9a-f]{40}[^\n]*/, 'uses: actions/cache@v6'),
      'not pinned to a 40-hex sha',
    ],
    [
      'one job is given its own key',
      // Key AND restore-keys, in the first job only. Changing the key alone trips
      // the key/restore-keys equality check instead, which would make this a
      // control for a different check than the one it names.
      (s) =>
        s
          .replace(/(key: bun-install-)/, '$1typecheck-')
          .replace(/(restore-keys: bun-install-)/, '$1typecheck-'),
      'do not share one key',
    ],
    [
      'restore-keys is deleted',
      (s) => s.replace(/\n\s+restore-keys: [^\n]*/, ''),
      'no restore-keys',
    ],
    [
      'bun-version is bumped without touching the key',
      (s) => s.replace('bun-version: 1.3.9', 'bun-version: 1.4.0'),
      "does not carry this job's bun version",
    ],
    [
      'the install stops setting BUN_INSTALL_CACHE_DIR',
      (s) => s.replace(/\n\s+env:\n\s+BUN_INSTALL_CACHE_DIR: [^\n]*/, ''),
      'sets no BUN_INSTALL_CACHE_DIR',
    ],
  ]

  /**
   * Mutations are applied to the `jobs:` mapping ONLY, never to the header
   * comment above it. The header quotes real key strings when it reports what CI
   * measured (`Cache restored from key: bun-install-…`), so a mutation written as
   * a bare `.replace(/key: bun-install-…/)` lands in PROSE, changes nothing about
   * the wiring, and the control then reports a false pass. Two did exactly that
   * the moment a measurement was added to the header — which is the same
   * "measured against the wrong thing" failure the guard itself is about.
   */
  const mutateJobs = (mutate: (s: string) => string): string => {
    const at = yml.indexOf('\njobs:\n')
    expect(at).toBeGreaterThan(0)
    return yml.slice(0, at) + mutate(yml.slice(at))
  }

  for (const [name, mutate, because] of mutations) {
    test(`catches the break: ${name}`, () => {
      const mutated = mutateJobs(mutate)
      expect(mutated).not.toBe(yml) // the mutation landed
      expect(whyCacheBroken(mutated)).toContain(because)
    })
  }

  test('the roster catches a job that leaves the walk', () => {
    // This one is deliberately NOT in the list above: an installing job renamed
    // out of the `^ {2}[a-z][a-z0-9-]*:$` pattern simply disappears, and the
    // remaining four are still wired correctly, so whyCacheBroken() has nothing
    // to complain about. The hardcoded roster is what notices — which is the
    // whole reason it is hardcoded, and this is the control that proves it.
    const mutated = mutateJobs((s) => s.replace('\n  typecheck:\n', '\n  Typecheck:\n'))
    expect(mutated).not.toBe(yml)
    expect(whyCacheBroken(mutated)).toBeNull()
    expect(installingJobs(mutated).map(([n]) => n).sort()).not.toEqual([
      'layering',
      'lint',
      'purity',
      'shard',
      'typecheck',
    ])
  })

  test('a harmless edit is NOT reported — the guard has to be usable', () => {
    // The inverse control. A guard that reds on a change with identical wiring
    // teaches people to edit the guard, and then it stops guarding. Adding an
    // unrelated env var above BUN_INSTALL_CACHE_DIR reddened the first version of
    // this suite; it must not red this one.
    const harmless = yml.replace(
      /( {8}env:\n)( {10}BUN_INSTALL_CACHE_DIR:)/g,
      '$1          BUN_INSTALL_VERBOSE: "0"\n$2',
    )
    expect(harmless).not.toBe(yml)
    expect(whyCacheBroken(harmless)).toBeNull()
  })
})

/**
 * Every action in every workflow is pinned to a full commit sha.
 *
 * 2026-08-18. The cache guard above asserted that actions/cache specifically was
 * sha-pinned, and its comment justified that with "every other pin in this repo is
 * a sha". That was false when it was written: `actions/checkout` and
 * `oven-sh/setup-bun` were on the MOVING tags `@v4` and `@v2`, five of each, and
 * a moving tag is repointable by whoever owns it — the supply-chain hole the
 * cache's own pin exists to close, left open on the two actions that run FIRST and
 * with more access. Both are pinned now, and the claim is a test rather than a
 * comment so it cannot go stale the same way twice.
 */
describe('workflow action pins', () => {
  const WORKFLOW_DIR = fileURLToPath(new URL('../../.github/workflows', import.meta.url))
  const files = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))

  test('the workflow directory is not empty — a walk over nothing proves nothing', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    test(`${file}: every uses: is a 40-hex sha`, () => {
      const source = readFileSync(join(WORKFLOW_DIR, file), 'utf8')
      const uses = [...source.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((m) => m[1]!)
      expect(uses.length).toBeGreaterThan(0)
      const unpinned = uses.filter((u) => !/^[^@]+@[0-9a-f]{40}$/.test(u))
      expect(unpinned).toEqual([])
    })
  }
})
