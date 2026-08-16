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
 */
describe('governed-repo attributes gate is wired into ci.yml', () => {
  const GATE_RUN = 'bun scripts/ci/check-governed-repo-attributes.ts'

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
   * A step runs unconditionally when it carries neither an `if:` (which can
   * evaluate false) nor `continue-on-error: true` (which discards its exit
   * code), and when the job around it carries neither either.
   */
  function whyNotGating(source: string): string | null {
    const job = jobBlock(source, 'layering')
    if (job === '') return 'no layering job'

    const lines = job.split('\n')
    const stepAt = lines.findIndex((l) => new RegExp(`^\\s+- run: ${GATE_RUN.replace(/[/.]/g, '\\$&')} `).test(l))
    if (stepAt === -1) return 'no step runs the gate'

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
    ['the step is deleted', (s) => s.replace(new RegExp(`^.*${GATE_RUN.replace(/[/.]/g, '\\$&')}.*$`, 'm'), '')],
    [
      'the step is disabled with if: false',
      (s) => s.replace(`      - run: ${GATE_RUN}`, `      - if: false\n        run: ${GATE_RUN}`),
    ],
    [
      'the step keeps running but its failure is swallowed',
      (s) =>
        s.replace(`      - run: ${GATE_RUN}`, `      - continue-on-error: true\n        run: ${GATE_RUN}`),
    ],
    [
      'the whole job is disabled',
      (s) => s.replace('\n  layering:\n', '\n  layering:\n    if: false\n'),
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
