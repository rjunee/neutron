/**
 * Unit — trident/leak-preflight.ts, the deterministic purity preflight.
 *
 * Every case drives the real module against a SCRIPTED fake host runner, so the
 * whole flow (worktree add, gate run, fixer, commit, compare-and-swap, cleanup)
 * is exercised with no subprocess and no filesystem. What is proven here is the
 * behaviour that made this module necessary on 2026-08-31: findings are parsed
 * without their excerpts, the fix loop TERMINATES on its bound, an exit-3
 * INCOMPLETE never reads as clean, a sentinel-less exit 0 is an error, and the
 * throwaway worktree is removed on every exit — including a thrown one.
 *
 * NOTE: the rule ids these fixtures name embed the six-letter retired
 * multi-org word that `scripts/ci/leak-gate.sh:367` / `:387` ban anywhere in a
 * committed file. They are assembled from FRAGMENTS at runtime (below), never
 * written as literals, so this suite's own source stays silent under the very
 * gate it models — the discipline `scripts/ci/leak-gate-selftest.test.ts`
 * established.
 */
import { describe, expect, test } from 'bun:test'

import type { EnvCapableHostRunner, HostCommandResult } from './git-mode.ts'
import {
  GATE_SCRUBBED_ENV,
  LEAK_GATE_TIMEOUT_MS,
  classifyLeakGateRun,
  ownLeakGateScript,
  parseLeakGateOutput,
  runLeakGatePreflight,
  type LeakPreflightFixer,
} from './leak-preflight.ts'

// ── Fixtures ─────────────────────────────────────────────────────────────────
const T2 = 'ten' + 'ant'
const RULE_W = `${T2}-word`
const RULE_P = `${T2}-purged`
const PLAN_DOC = '.trident/plans/trident/x.md'

const H0 = '0'.repeat(40)
const H1 = 'a'.repeat(40)
const H2 = 'b'.repeat(40)
const BASE = 'c'.repeat(40)
const REPO = 'repos/neutron'
const SCRATCH = 'repos/neutron-leak-scan'
// THIS INSTALL's gate — deliberately NOT under SCRATCH, which is the whole point: the scanned
// checkout supplies the tree, never the code that reads it.
const GATE = 'install/scripts/ci/leak-gate.sh'
const BRANCH = 'trident/example'

const FAIL_OUT = [
  '── Tier 2: vocabulary ─────',
  `  [${RULE_W}] ${PLAN_DOC}:7:Repo rules: never write the flagged vocabulary`,
  `  [${RULE_P}] ${PLAN_DOC}:24:zero flagged words in the commit`,
  '    TOTAL FINDINGS: 2',
  'LEAK GATE: FAIL — the public tree must be fully silent.',
].join('\n')

const INCOMPLETE_OUT = [
  '    TOTAL FINDINGS: 0',
  '    RULES THAT COULD NOT RUN: pii-denylist, pii-denylist-msg',
  "LEAK GATE: INCOMPLETE — 0 findings from the rules that RAN, but the rules",
].join('\n')

const SILENT_OUT = ['    TOTAL FINDINGS: 0', 'LEAK GATE: SILENT ✅'].join('\n')

// What the REAL gate says about a `git worktree add` scan tree: the pointer FILE
// `.git` (one line, `gitdir: <absolute path on this host>`) is walked because the
// gate only excludes the `.git` DIRECTORY. The excerpt is elided in the fixture
// for the same reason the parser drops it.
const POINTER_ONLY_OUT = [
  '── Tier 2: vocabulary ─────',
  `  [${RULE_P}] .git:1:gitdir: …`,
  '    TOTAL FINDINGS: 1',
  'LEAK GATE: FAIL — the public tree must be fully silent.',
].join('\n')

const POINTER_AND_REAL_OUT = [
  '── Tier 2: vocabulary ─────',
  `  [${RULE_P}] .git:1:gitdir: …`,
  `  [${RULE_W}] ${PLAN_DOC}:7:Repo rules: never write the flagged vocabulary`,
  '    TOTAL FINDINGS: 2',
  'LEAK GATE: FAIL — the public tree must be fully silent.',
].join('\n')

const POINTER_ONLY_INCOMPLETE_OUT = [
  `  [${RULE_P}] .git:1:gitdir: …`,
  '    TOTAL FINDINGS: 1',
  '    RULES THAT COULD NOT RUN: pii-denylist, pii-denylist-msg',
  'LEAK GATE: FAIL — the public tree must be fully silent.',
].join('\n')

const ok: HostCommandResult = { ok: true, stdout: '', stderr: '', exit_code: 0 }
const fail: HostCommandResult = { ok: false, stdout: '', stderr: '', exit_code: 1 }
const gateResult = (stdout: string, exit_code: number): HostCommandResult => ({
  ok: exit_code === 0,
  stdout,
  stderr: '',
  exit_code,
})

interface Call {
  argv: string[]
  cwd: string | undefined
  extraEnv: Record<string, string> | undefined
  timeoutMs: number | undefined
}

/**
 * A fake `EnvCapableHostRunner` that records every call and routes on the joined
 * argv. Everything unrouted answers ok/empty, so a case only scripts what it
 * cares about.
 */
function makeHost(opts: {
  gate?: HostCommandResult[]
  gateThrows?: boolean
  gateScriptPresent?: boolean
  nothingStaged?: boolean
  /** `git diff --cached --name-status` output the fixer's stage is audited against. */
  stagedNameStatus?: string
  revParse?: string[]
  commitOk?: boolean
  updateRefOk?: boolean
}): { run: EnvCapableHostRunner; calls: Call[] } {
  const calls: Call[] = []
  let gateIdx = 0
  let revIdx = 0
  const run: EnvCapableHostRunner = async (cmd, cwd, extraEnv, timeoutMs) => {
    calls.push({ argv: cmd, cwd, extraEnv, timeoutMs })
    const joined = cmd.join(' ')
    if (cmd[0] === 'test') return opts.gateScriptPresent === false ? fail : ok
    if (joined.includes('leak-gate.sh')) {
      if (opts.gateThrows === true) throw new Error('gate spawn failed')
      const scripted = opts.gate ?? []
      return scripted[Math.min(gateIdx++, scripted.length - 1)] ?? ok
    }
    if (joined.includes('diff --cached --name-status'))
      return {
        ...ok,
        stdout: opts.nothingStaged === true ? '' : (opts.stagedNameStatus ?? `M\t${PLAN_DOC}\n`),
      }
    if (joined.includes('commit -m')) return opts.commitOk === false ? fail : ok
    if (joined.includes('rev-parse')) {
      const heads = opts.revParse ?? [H1]
      return { ...ok, stdout: `${heads[Math.min(revIdx++, heads.length - 1)] ?? H1}\n` }
    }
    if (joined.includes('update-ref')) return opts.updateRefOk === false ? fail : ok
    return ok
  }
  return { run, calls }
}

// Not merely "mentions the script": the `test -f` probe names a gate path too and must not be
// counted as a gate RUN. A run is the `env … bash <gate> --tree` argv.
const gateCalls = (calls: Call[]): Call[] =>
  calls.filter((c) => c.argv[0] !== 'test' && c.argv.includes('--tree'))
const matching = (calls: Call[], needle: string): Call[] =>
  calls.filter((c) => c.argv.join(' ').includes(needle))

const preflight = (
  run: EnvCapableHostRunner,
  extra: { fixer?: LeakPreflightFixer; base_sha?: string } = {},
) =>
  runLeakGatePreflight({
    run_host: run,
    repo_path: REPO,
    branch: BRANCH,
    head: H0,
    base_sha: extra.base_sha ?? BASE,
    scratch_dir: SCRATCH,
    gate_script: GATE,
    ...(extra.fixer === undefined ? {} : { fixer: extra.fixer }),
  })

// ── Cases ────────────────────────────────────────────────────────────────────
describe('runLeakGatePreflight', () => {
  test('findings with no fixer are reported, not swallowed, and the scan worktree is torn down', async () => {
    const { run, calls } = makeHost({ gate: [gateResult(FAIL_OUT, 1)] })
    const out = await preflight(run)

    expect(out.status).toBe('findings-unresolved')
    expect(out.findings).toEqual([
      { rule: RULE_W, file: PLAN_DOC, line: 7 },
      { rule: RULE_P, file: PLAN_DOC, line: 24 },
    ])
    expect(out.attempts).toBe(0)
    expect(out.head).toBe(H0)
    expect(gateCalls(calls)).toHaveLength(1)
    expect(matching(calls, 'worktree add')).toHaveLength(1)
    expect(matching(calls, 'worktree remove')).toHaveLength(1)

    // The explicit budget is not optional: the default watchdog is far shorter
    // than a real gate run, and the base sha pins the message scan window.
    const gate = gateCalls(calls)[0]
    expect(gate?.timeoutMs).toBe(LEAK_GATE_TIMEOUT_MS)
    expect(gate?.extraEnv?.LEAK_GATE_BASE_SHA).toBe(BASE)
    expect(gate?.cwd).toBe(SCRATCH)
  })

  test('the 2-attempt bound TERMINATES: 3 gate runs, 2 fixes, a chained compare-and-swap', async () => {
    const { run, calls } = makeHost({ gate: [gateResult(FAIL_OUT, 1)], revParse: [H1, H2] })
    let fixerCalls = 0
    const fixer: LeakPreflightFixer = async () => {
      fixerCalls += 1
      return { fixed: true }
    }

    const out = await preflight(run, { fixer })

    expect(out.status).toBe('findings-unresolved')
    expect(out.attempts).toBe(2)
    expect(out.head).toBe(H2)
    expect(gateCalls(calls)).toHaveLength(3)
    expect(fixerCalls).toBe(2)
    expect(matching(calls, 'commit -m')).toHaveLength(2)

    const swaps = matching(calls, 'update-ref')
    expect(swaps).toHaveLength(2)
    expect(swaps[0]?.argv.slice(-3)).toEqual([`refs/heads/${BRANCH}`, H1, H0])
    expect(swaps[1]?.argv.slice(-3)).toEqual([`refs/heads/${BRANCH}`, H2, H1])
  })

  test('a fix that lands reports status fixed at the NEW head', async () => {
    const { run, calls } = makeHost({
      gate: [gateResult(FAIL_OUT, 1), gateResult(SILENT_OUT, 0)],
      revParse: [H1],
    })
    const fixer: LeakPreflightFixer = async () => ({ fixed: true })

    const out = await preflight(run, { fixer })

    expect(out.status).toBe('fixed')
    expect(out.attempts).toBe(1)
    expect(out.head).toBe(H1)
    expect(out.findings).toEqual([])
    expect(gateCalls(calls)).toHaveLength(2)
  })

  /**
   * THE SCAN TREE'S OWN POINTER FILE. `git worktree add` writes `.git` as a
   * FILE holding `gitdir: <absolute path on this host>`, and the gate's walk
   * excludes only the `.git` DIRECTORY — so on a linked worktree that line is
   * reported every single run, while CI (a real `.git` directory) never sees
   * it. It is not part of the branch, no reword can reach it, and left in it
   * would burn both fix attempts and annotate every PR with a finding no
   * commit contains.
   */
  test('the scan worktree pointer file is not a branch finding: FAIL on `.git` alone reads as silent', async () => {
    const { run, calls } = makeHost({ gate: [gateResult(POINTER_ONLY_OUT, 1)] })
    let fixerCalls = 0
    const fixer: LeakPreflightFixer = async () => {
      fixerCalls += 1
      return { fixed: true }
    }

    const out = await preflight(run, { fixer })

    expect(out.status).toBe('clean')
    expect(out.findings).toEqual([])
    expect(out.attempts).toBe(0)
    expect(out.head).toBe(H0)
    // No reword turn, no commit, no ref move over an untracked pointer file.
    expect(fixerCalls).toBe(0)
    expect(gateCalls(calls)).toHaveLength(1)
    expect(matching(calls, 'commit -m')).toHaveLength(0)
    expect(matching(calls, 'update-ref')).toHaveLength(0)
    expect(matching(calls, 'worktree remove')).toHaveLength(1)
  })

  test('dropping the pointer file does not drop a REAL finding beside it', async () => {
    const { run } = makeHost({ gate: [gateResult(POINTER_AND_REAL_OUT, 1)] })

    const out = await preflight(run)

    expect(out.status).toBe('findings-unresolved')
    expect(out.findings).toEqual([{ rule: RULE_W, file: PLAN_DOC, line: 7 }])
  })

  test('a pointer-only FAIL with a tier that could not run is INCOMPLETE, never clean', async () => {
    const { run } = makeHost({ gate: [gateResult(POINTER_ONLY_INCOMPLETE_OUT, 1)] })

    const out = await preflight(run)

    expect(out.status).toBe('incomplete')
    expect(out.findings).toEqual([])
    expect(out.skipped_rules).toEqual(['pii-denylist', 'pii-denylist-msg'])
  })

  test('exit 3 INCOMPLETE names the skipped tiers and is NEVER reported as clean', async () => {
    const { run } = makeHost({ gate: [gateResult(INCOMPLETE_OUT, 3)] })
    const out = await preflight(run)

    expect(out.status).toBe('incomplete')
    expect(out.skipped_rules).toEqual(['pii-denylist', 'pii-denylist-msg'])
    expect(out.note).toContain('pii-denylist')
    expect(out.note).toContain('pii-denylist-msg')
    expect(out.findings).toEqual([])
  })

  test('an exit 0 with NO verdict sentinel is a gate error, never clean', async () => {
    const { run } = makeHost({ gate: [gateResult('', 0)] })
    const out = await preflight(run)

    expect(out.status).toBe('gate-error')
  })

  test('a repo with no gate script is skipped, and nothing else is run', async () => {
    const { run, calls } = makeHost({ gateScriptPresent: false })
    const out = await preflight(run)

    expect(out.status).toBe('skipped-no-gate')
    expect(calls).toHaveLength(1)
  })

  test('a fixer that claims a fix but stages nothing does not commit or move the branch', async () => {
    const { run, calls } = makeHost({ gate: [gateResult(FAIL_OUT, 1)], nothingStaged: true })
    const fixer: LeakPreflightFixer = async () => ({ fixed: true })

    const out = await preflight(run, { fixer })

    expect(out.status).toBe('findings-unresolved')
    expect(out.note).toContain('staged nothing')
    expect(matching(calls, 'commit -m')).toHaveLength(0)
    expect(matching(calls, 'update-ref')).toHaveLength(0)
  })

  test('a scan worktree that cannot be provisioned is a gate error, and the gate never runs', async () => {
    const calls: Call[] = []
    const run: EnvCapableHostRunner = async (cmd, cwd, extraEnv, timeoutMs) => {
      calls.push({ argv: cmd, cwd, extraEnv, timeoutMs })
      if (cmd.join(' ').includes('worktree add')) return { ...fail, stderr: 'fatal: already exists' }
      return ok
    }
    const out = await runLeakGatePreflight({
      run_host: run,
      repo_path: REPO,
      branch: BRANCH,
      head: H0,
      base_sha: BASE,
      scratch_dir: SCRATCH,
      gate_script: GATE,
    })

    expect(out.status).toBe('gate-error')
    expect(out.head).toBe(H0)
    // Nothing was scanned, so nothing may be reported as clean — and no teardown is attempted
    // for a worktree that was never added.
    expect(gateCalls(calls)).toHaveLength(0)
    expect(matching(calls, 'worktree remove')).toHaveLength(0)
  })

  test('a THROWN host call becomes a gate error and still tears the worktree down', async () => {
    const { run, calls } = makeHost({ gateThrows: true })
    const out = await preflight(run)

    expect(out.status).toBe('gate-error')
    expect(matching(calls, 'worktree remove')).toHaveLength(1)
  })

  /**
   * THE SCANNED CHECKOUT SUPPLIES THE TREE, NEVER THE CODE THAT READS IT — and never gets the
   * credential either. Round 1 ran `bash <scratch>/scripts/ci/leak-gate.sh`, i.e. the BRANCH's own
   * copy of the script (which in turn `awk -f`s the branch's own extractor), under a runner whose
   * environment carries the owner's GitHub token. Two independent controls now, and both are
   * asserted on the same argv: WHAT runs, and what is in scope while it does.
   */
  test('the gate that RUNS is this installation\'s, and the credential is not in its environment', async () => {
    const { run, calls } = makeHost({ gate: [gateResult(SILENT_OUT, 0)] })
    await preflight(run)

    const gate = gateCalls(calls)[0]
    const argv = gate?.argv ?? []
    // The trusted copy, named exactly; nothing under the scanned tree is executed.
    expect(argv).toContain(GATE)
    expect(argv.some((a) => a.startsWith(SCRATCH) && a.endsWith('leak-gate.sh'))).toBe(false)
    // The scanned tree is still the SUBJECT of the scan.
    expect(argv.slice(-2)).toEqual(['--tree', SCRATCH])
    // …and every credential-bearing variable is unset for the child.
    expect(argv[0]?.endsWith('env')).toBe(true)
    for (const name of GATE_SCRUBBED_ENV) {
      const at = argv.indexOf(name)
      expect(at, `${name} is not scrubbed`).toBeGreaterThan(0)
      expect(argv[at - 1]).toBe('-u')
    }
    // The scrub happens BEFORE `bash`, or it scrubs nothing.
    expect(argv.indexOf('bash')).toBeGreaterThan(argv.indexOf(GATE_SCRUBBED_ENV[0]!))
  })

  test('the scrub list names the credential AND the three CI-context variables', () => {
    // GH_TOKEN + the helper triple: what the exfil repro read out of the environment.
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'])
      expect(GATE_SCRUBBED_ENV).toContain(name)
    // …and the three that would flip the gate into its canonical secret context, where a missing
    // denylist is a hard exit 2 — i.e. this preflight permanently inert.
    for (const name of ['GITHUB_ACTIONS', 'GITHUB_RUN_ID', 'GITHUB_EVENT_NAME'])
      expect(GATE_SCRUBBED_ENV).toContain(name)
  })

  test('this installation resolves its own gate, so production never falls back to a checkout copy', () => {
    // Walks up from the module, exactly as the merge driver does. In this repo it must resolve.
    expect(ownLeakGateScript()).toMatch(/scripts\/ci\/leak-gate\.sh$/)
  })

  test('a stale scan path cannot wedge later rounds: the worktree registry is pruned first', async () => {
    const { run, calls } = makeHost({ gate: [gateResult(SILENT_OUT, 0)] })
    await preflight(run)

    const prune = calls.findIndex((c) => c.argv.join(' ').includes('worktree prune'))
    const add = calls.findIndex((c) => c.argv.join(' ').includes('worktree add'))
    expect(prune).toBeGreaterThan(-1)
    expect(add).toBeGreaterThan(prune)
  })

  /**
   * A FIX IS AN IN-PLACE REWORD OF WHAT WAS FLAGGED — audited against the index, not taken on the
   * fixer's word. The prompt forbids deleting the plan doc and forbids touching the scanner; a
   * prompt is not a control, so each refusal is proven here, and each one leaves the branch ref
   * exactly where it was with the findings still reported.
   */
  test.each([
    ['a deletion is not a reword', `D\t${PLAN_DOC}\n`, 'other than an in-place reword'],
    ['a file the gate never flagged', `M\t${PLAN_DOC}\nM\tdocs/unrelated.md\n`, 'did not flag'],
    ['the scanner itself', `M\t${PLAN_DOC}\nM\tscripts/ci/leak-gate.sh\n`, 'the scanner itself'],
    ['the allowlist', `M\tscripts/ci/leak-gate-allowlist.txt\n`, 'the scanner itself'],
  ])('a staged fix is REFUSED when it is %s', async (_name, nameStatus, expected) => {
    const { run, calls } = makeHost({ gate: [gateResult(FAIL_OUT, 1)], stagedNameStatus: nameStatus })
    const fixer: LeakPreflightFixer = async () => ({ fixed: true })

    const out = await preflight(run, { fixer })

    expect(out.status).toBe('findings-unresolved')
    expect(out.note).toContain(expected)
    expect(out.head).toBe(H0)
    expect(matching(calls, 'commit -m')).toHaveLength(0)
    expect(matching(calls, 'update-ref')).toHaveLength(0)
    // …and the findings still reach the caller, so the PR is annotated with them.
    expect(out.findings).toHaveLength(2)
  })

  test('an in-place reword of exactly the flagged file IS committed', async () => {
    const { run, calls } = makeHost({
      gate: [gateResult(FAIL_OUT, 1), gateResult(SILENT_OUT, 0)],
      stagedNameStatus: `M\t${PLAN_DOC}\n`,
      revParse: [H1],
    })
    const fixer: LeakPreflightFixer = async () => ({ fixed: true })

    const out = await preflight(run, { fixer })

    expect(out.status).toBe('fixed')
    expect(out.head).toBe(H1)
    expect(matching(calls, 'commit -m')).toHaveLength(1)
  })

  /**
   * `fixed` IS A PASSING WORD, and a tier that could not run has not passed. A reword that lands
   * under a skipped tier says `incomplete` and keeps the skipped tiers on the outcome; the attempt
   * count is what carries "and a fix did land".
   */
  test('a successful fix under a SKIPPED tier still reports incomplete, never fixed', async () => {
    const { run } = makeHost({
      gate: [gateResult(FAIL_OUT, 1), gateResult(INCOMPLETE_OUT, 3)],
      revParse: [H1],
    })
    const fixer: LeakPreflightFixer = async () => ({ fixed: true })

    const out = await preflight(run, { fixer })

    expect(out.status).toBe('incomplete')
    expect(out.attempts).toBe(1)
    expect(out.head).toBe(H1)
    expect(out.skipped_rules).toEqual(['pii-denylist', 'pii-denylist-msg'])
    expect(out.note).toContain('self-correction attempt')
  })

  test('a pointer-only FAIL under a SKIPPED tier after a fix is incomplete too', async () => {
    const { run } = makeHost({
      gate: [gateResult(FAIL_OUT, 1), gateResult(POINTER_ONLY_INCOMPLETE_OUT, 1)],
      revParse: [H1],
    })
    const fixer: LeakPreflightFixer = async () => ({ fixed: true })

    const out = await preflight(run, { fixer })

    expect(out.status).toBe('incomplete')
    expect(out.skipped_rules).toEqual(['pii-denylist', 'pii-denylist-msg'])
  })

  test('a sha256 base sha still PINS the commit-message window instead of silently widening it', async () => {
    const { run, calls } = makeHost({ gate: [gateResult(SILENT_OUT, 0)] })
    const sha256 = 'd'.repeat(64)
    const out = await preflight(run, { base_sha: sha256 })

    expect(out.status).toBe('clean')
    expect(gateCalls(calls)[0]?.extraEnv?.LEAK_GATE_BASE_SHA).toBe(sha256)
  })

  test('an empty base sha leaves the scan window unpinned rather than passing junk', async () => {
    const { run, calls } = makeHost({ gate: [gateResult(SILENT_OUT, 0)] })
    const out = await preflight(run, { base_sha: '' })

    expect(out.status).toBe('clean')
    expect(gateCalls(calls)[0]?.extraEnv?.LEAK_GATE_BASE_SHA).toBeUndefined()
  })
})

describe('parseLeakGateOutput', () => {
  test('the truncation continuation line is not a finding', () => {
    const { findings } = parseLeakGateOutput(
      [`  [${RULE_W}] ${PLAN_DOC}:7:some flagged prose`, `  [${RULE_W}] … and 3 more`].join('\n'),
    )
    expect(findings).toEqual([{ rule: RULE_W, file: PLAN_DOC, line: 7 }])
  })

  test('a colon-and-digits inside the EXCERPT does not steal the file/line split', () => {
    const { findings } = parseLeakGateOutput(`  [${RULE_W}] ${PLAN_DOC}:7:prose inner:33:text`)
    expect(findings).toEqual([{ rule: RULE_W, file: PLAN_DOC, line: 7 }])
  })

  test('a finding carries exactly rule/file/line — the excerpt never survives the boundary', () => {
    const { findings } = parseLeakGateOutput(`  [${RULE_P}] ${PLAN_DOC}:24:flagged words in the commit`)
    expect(findings.map((f) => Object.keys(f).sort())).toEqual([['file', 'line', 'rule']])
  })
})

describe('classifyLeakGateRun', () => {
  test('code and sentinel are BOTH required for every verdict', () => {
    expect(classifyLeakGateRun(gateResult(SILENT_OUT, 0))).toBe('clean')
    expect(classifyLeakGateRun(gateResult(INCOMPLETE_OUT, 3))).toBe('incomplete')
    expect(classifyLeakGateRun(gateResult(FAIL_OUT, 1))).toBe('findings')
    expect(classifyLeakGateRun(gateResult('', 0))).toBe('error')
    expect(classifyLeakGateRun(gateResult(SILENT_OUT, 1))).toBe('error')
    expect(classifyLeakGateRun(gateResult(FAIL_OUT, 0))).toBe('error')
  })
})
