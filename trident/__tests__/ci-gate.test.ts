/**
 * THE CI GATE — a review panel cannot see a red build, so something else has to.
 *
 * WHY IT EXISTS. Four reviewers read the DIFF. None runs the tests, so a change that
 * type-errors or reds a shard can be unanimously APPROVED — and on a repo without
 * branch protection it merges. The reference deployment is protected by a GitHub
 * setting, which means the discipline lived in repository CONFIGURATION rather than in
 * this harness: **every self-hoster and every local-merge run had nothing at all.**
 *
 * TESTED AGAINST THE REAL FUNCTIONS, extracted from the `.mjs` source and evaluated —
 * the same technique the cross-model gate tests already use, and for the same reason:
 * a hand-copied TypeScript duplicate is a test that cannot fail for the reason it
 * claims to check. The workflow script genuinely cannot be imported (no module
 * resolution; its top-level `return` is the Workflow runtime's result API).
 */

import { describe, expect, test } from 'bun:test'

const SRC = await Bun.file(new URL('../inner-workflow.mjs', import.meta.url)).text()

interface CiResult {
  status: string
  failing: Array<{ name: string; state: string; link: string | null }>
}

/** Brace-match one function out of the source and evaluate it. */
function grab(name: string): string {
  const at = SRC.indexOf(`function ${name}(`)
  if (at === -1) throw new Error(`${name} is missing from inner-workflow.mjs`)
  let depth = 0
  let started = false
  for (let i = at; i < SRC.length; i += 1) {
    const c = SRC[i]
    if (c === '{') {
      depth += 1
      started = true
    } else if (c === '}') {
      depth -= 1
      if (started && depth === 0) return SRC.slice(at, i + 1)
    }
  }
  throw new Error(`could not brace-match ${name}`)
}

function loadReal(): {
  classifyCi: (probe: unknown) => CiResult
  ciBlockerFindings: (ci: CiResult) => Array<{ severity: string; title: string; evidence: string }>
  ciDeferredPeer: (ci: CiResult) => { name: string; title: string; evidence: string }
} {
  // The state sets are consts the functions close over, so they come along.
  const consts = SRC.slice(
    SRC.indexOf('const CI_FAILED_STATES'),
    SRC.indexOf('/**', SRC.indexOf('const CI_PENDING_STATES')),
  )
  // …and say so HERE if a refactor moves them out of the slice, rather than letting
  // `new Function` throw a bare ReferenceError from inside an unrelated test. This
  // slice ends at the next `/**`, so merely opening a JSDoc block above `probeCause`
  // is enough to lose it — which is exactly what happened while writing the readiness
  // budget below.
  if (!consts.includes('function probeCause(') || !consts.includes('function redactProbeText(')) {
    throw new Error('probeCause/redactProbeText are no longer inside the classifyCi const slice')
  }
  const factory = new Function(
    `${consts}\n${grab('classifyCi')}\n${grab('ciBlockerFindings')}\n${grab('ciDeferredPeer')}\nreturn { classifyCi, ciBlockerFindings, ciDeferredPeer }`,
  ) as () => ReturnType<typeof loadReal>
  return factory()
}

/** A `gh pr checks --json` reply, as the probe reports it. */
const probe = (rows: unknown, exit = 0): { raw: string; exit_code: number } => ({
  raw: `${JSON.stringify(rows)}\n___EXIT=${exit}`,
  exit_code: exit,
})

describe('the extraction itself works (a guard that cannot load is a guard that cannot fail)', () => {
  // Loaded INSIDE a test, never at describe time: a load failure at describe time
  // DELETES the tests instead of failing them, which is the same cannot-fail shape
  // this file exists to prevent.
  test('the three functions are extractable', () => {
    const r = loadReal()
    expect(typeof r.classifyCi).toBe('function')
    expect(typeof r.ciBlockerFindings).toBe('function')
    expect(typeof r.ciDeferredPeer).toBe('function')
  })
})

describe('classifyCi — every answer is derived in code, never read by a model', () => {
  test('all SUCCESS → green', () => {
    const { classifyCi } = loadReal()
    expect(
      classifyCi(probe([{ name: 'test', state: 'SUCCESS' }, { name: 'lint', state: 'SUCCESS' }]))
        .status,
    ).toBe('green')
  })

  test('one FAILURE → red, and it names the check', () => {
    const { classifyCi } = loadReal()
    const out = classifyCi(
      probe([
        { name: 'test', state: 'SUCCESS' },
        { name: 'shard 3/4', state: 'FAILURE', link: 'https://ci.example.com/1' },
      ]),
    )
    expect(out.status).toBe('red')
    expect(out.failing).toHaveLength(1)
    expect(out.failing[0]!.name).toBe('shard 3/4')
    expect(out.failing[0]!.link).toBe('https://ci.example.com/1')
  })

  test('every terminal-failure state counts as red', () => {
    // GitHub reports several ways for a check to have finished badly. Treating only
    // FAILURE as red would let a cancelled or timed-out gate merge.
    const { classifyCi } = loadReal()
    for (const state of ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']) {
      expect(classifyCi(probe([{ name: 'x', state }])).status).toBe('red')
    }
  })

  test('a still-running check is PENDING, not green', () => {
    const { classifyCi } = loadReal()
    for (const state of ['PENDING', 'QUEUED', 'IN_PROGRESS']) {
      expect(classifyCi(probe([{ name: 'x', state }, { name: 'y', state: 'SUCCESS' }])).status).toBe(
        'pending',
      )
    }
  })

  test('RED BEATS PENDING — a known failure does not wait for the rest', () => {
    // Reporting pending here would defer (infra-only, loop exits) instead of sending
    // Forge to fix a failure we can already see.
    const { classifyCi } = loadReal()
    expect(
      classifyCi(probe([{ name: 'a', state: 'IN_PROGRESS' }, { name: 'b', state: 'FAILURE' }]))
        .status,
    ).toBe('red')
  })

  test('SKIPPED and NEUTRAL are not failures', () => {
    // A path-filtered workflow skips legitimately; treating that as red would block
    // every diff that misses a filter.
    const { classifyCi } = loadReal()
    expect(classifyCi(probe([{ name: 'a', state: 'SKIPPED' }, { name: 'b', state: 'SUCCESS' }])).status).toBe('green')
    expect(classifyCi(probe([{ name: 'a', state: 'NEUTRAL' }])).status).toBe('green')
  })

  test('NO checks configured is `none`, distinct from green', () => {
    // A repo with no CI has nothing to wait for. Blocking it would deadlock every
    // self-hoster who has not set any up.
    const { classifyCi } = loadReal()
    expect(classifyCi(probe([])).status).toBe('none')
  })

  test('an unreadable reply is UNKNOWN, and unknown is NEVER green', () => {
    // "Could not tell" and "it passed" are different answers, and only one of them is
    // safe to merge on. gh missing, unauthenticated, a deleted PR — all land here.
    const { classifyCi } = loadReal()
    expect(classifyCi({ raw: 'gh: command not found\n___EXIT=127', exit_code: 127 }).status).toBe('unknown')
    expect(classifyCi({ raw: 'not json at all', exit_code: 1 }).status).toBe('unknown')
    expect(classifyCi({ raw: '[broken', exit_code: 1 }).status).toBe('unknown')
    // Exit 0 does NOT rescue an unparseable reply: reading a clean exit as "no
    // checks" would produce no gate at all. `gh` prints `[]` for a repo with no
    // checks, so the real no-checks case never lands here.
    expect(classifyCi({ raw: '{"not":"an array"}', exit_code: 0 }).status).toBe('unknown')
    expect(classifyCi(null).status).toBe('unknown')
    expect(classifyCi(undefined).status).toBe('unknown')
  })

  test('a NON-ZERO exit with parseable rows still trusts the rows', () => {
    // `gh pr checks` exits 8 for pending and 1 for failures, so a non-zero exit is
    // normal. Treating it as an error would make every red build "unknown" — a
    // deferral instead of a fix.
    const { classifyCi } = loadReal()
    expect(classifyCi(probe([{ name: 'a', state: 'FAILURE' }], 1)).status).toBe('red')
    expect(classifyCi(probe([{ name: 'a', state: 'PENDING' }], 8)).status).toBe('pending')
  })

  test('surrounding noise around the JSON is tolerated', () => {
    // The probe captures stdout AND stderr, so a warning line can precede the array.
    const { classifyCi } = loadReal()
    const raw = `warning: something\n[{"name":"test","state":"SUCCESS"}]\n___EXIT=0`
    expect(classifyCi({ raw, exit_code: 0 }).status).toBe('green')
  })

  test('a nameless or state-less row does not crash the classifier', () => {
    const { classifyCi } = loadReal()
    expect(classifyCi(probe([{}, { name: 'ok', state: 'SUCCESS' }])).status).toBe('green')
    expect(classifyCi(probe([{ state: 'FAILURE' }])).failing[0]!.name).toBe('unnamed check')
  })
})

describe('what the gate DOES with each answer', () => {
  test('a red check becomes a BLOCKER finding naming the check and its link', () => {
    const { classifyCi, ciBlockerFindings } = loadReal()
    const ci = classifyCi(probe([{ name: 'typecheck', state: 'FAILURE', link: 'https://ci.example.com/9' }]))
    const findings = ciBlockerFindings(ci)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.severity).toBe('blocker')
    expect(findings[0]!.title).toContain('typecheck')
    // The reviewers cannot see any of this from the diff, so the evidence has to
    // carry it.
    expect(findings[0]!.evidence).toContain('typecheck')
    expect(findings[0]!.evidence).toContain('https://ci.example.com/9')
  })

  test('green / none produce NO findings at all', () => {
    const { classifyCi, ciBlockerFindings } = loadReal()
    expect(ciBlockerFindings(classifyCi(probe([{ name: 'a', state: 'SUCCESS' }])))).toEqual([])
    expect(ciBlockerFindings(classifyCi(probe([])))).toEqual([])
  })

  test('pending becomes a DEFERRED PEER, worded as "not approved", not as a code fault', () => {
    // Shaped as a peer on purpose: it flows into the existing cross-model gate, which
    // refuses to APPROVE, and `classifyBlock` then returns 'infra-only' so the loop
    // EXITS instead of re-Forging against a timer. There is nothing in the code to fix.
    const { classifyCi, ciDeferredPeer } = loadReal()
    const peer = ciDeferredPeer(classifyCi(probe([{ name: 'a', state: 'IN_PROGRESS' }])))
    expect(peer.name).toBe('CI')
    expect(peer.evidence).toContain('had not finished')
  })

  test('unknown becomes a deferred peer that says we could not TELL', () => {
    const { classifyCi, ciDeferredPeer } = loadReal()
    const peer = ciDeferredPeer(classifyCi({ raw: 'gh: not found', exit_code: 127 }))
    expect(peer.name).toBe('CI')
    expect(peer.evidence).toContain('could not be read')
  })

  // THE TITLE IS THE PRODUCER'S CONTRACT. `enforceCrossModelGate` posts `title: p.title`
  // verbatim, so a producer that omits it ships a PR blocker reading `title: undefined`
  // — and deleting the `title:` line here used to survive the whole suite green,
  // because nothing asserted it. The title is the line a human reads first.
  test('BOTH deferred-CI peers carry a distinct, non-empty title naming the reason', () => {
    const { classifyCi, ciDeferredPeer } = loadReal()
    const pending = ciDeferredPeer(classifyCi(probe([{ name: 'a', state: 'IN_PROGRESS' }])))
    const unknown = ciDeferredPeer(classifyCi({ raw: 'gh: not found', exit_code: 127 }))
    expect(pending.title).toBe('CI status UNREADABLE (still running) — refusing to silently APPROVE')
    expect(unknown.title).toBe('CI status UNREADABLE — refusing to silently APPROVE')
    // Distinct, so "still running" is never reported as "cannot read checks at all".
    expect(pending.title).not.toBe(unknown.title)
  })
})

describe('the gate is WIRED, not merely written', () => {
  const code = SRC.split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

  test('the probe is invoked during review', () => {
    expect(code.includes('const ci = await probeCi(prForCi, round)')).toBe(true)
  })

  test('RED FORCES THE VERDICT, it does not merely append findings', () => {
    // The hole this nearly shipped with: `enforceCrossModelGate` returns the synthesis
    // UNTOUCHED when there are no deferred peers, so attaching CI blockers without
    // setting the verdict would have produced an APPROVE carrying a "CI FAILING"
    // finding — merging a red build, the exact bug the gate exists to prevent.
    const at = code.indexOf('const withCi =')
    expect(at).toBeGreaterThan(-1)
    const block = code.slice(at, code.indexOf('const peers =', at))
    expect(block.includes("verdict: 'REQUEST_CHANGES'")).toBe(true)
    expect(block.includes('ciBlockerFindings(ci)')).toBe(true)
  })

  test('an unusable CI answer joins the EXISTING peer list — one gate, peers as data', () => {
    // Not a second gate. The file's own rule: a second near-identical gate is how one
    // of the two quietly stops being enforced.
    const at = code.indexOf('const peers =')
    const block = code.slice(at, code.indexOf('const gated =', at))
    expect(block.includes('ciDeferredPeer(ci)')).toBe(true)
    expect(block.includes('...deferred')).toBe(true)
  })

  test('classifyBlock reads the peers INCLUDING the CI one', () => {
    // Otherwise a CI deferral would not classify as infra-only and the loop would
    // re-Forge against a pending check.
    expect(code.includes('classifyBlock(gated, peers)')).toBe(true)
  })

  test('LOCAL mode never spends an agent on a PR that does not exist', () => {
    const at = code.indexOf('async function probeCi(')
    const block = code.slice(at, code.indexOf('\n}', at))
    expect(block.includes('if (!isPr')).toBe(true)
    expect(block.includes("status: 'none'")).toBe(true)
  })

  test('the probe asks for RAW OUTPUT and forbids interpretation', () => {
    // A model asked "is CI green?" can answer yes for a plausible-looking wall of
    // text, and a hallucinated green merges a broken build.
    const at = SRC.indexOf('async function probeCi(')
    const block = SRC.slice(at, SRC.indexOf('\n}', at))
    expect(block).toContain('VERBATIM')
    expect(block).toContain('do NOT decide whether CI passed')
  })
})

interface Readiness {
  status: string
  reason: string
  failed?: string[]
}

function loadReadiness(source = SRC): {
  classifyReviewReadiness: (probe: unknown) => Readiness
  reviewWithPreconditions: (args: {
    probe: (attempt: number) => Promise<Readiness>
    spend: () => Promise<unknown>
    wait: () => Promise<void>
    attempts?: number
  }) => Promise<{ deferred: boolean; readiness: Readiness; value: unknown }>
  probeCause: (raw: unknown) => string
  redactProbeText: (text: unknown) => string
  REVIEW_READINESS_BUDGET_MS: number
  REVIEW_READINESS_RETRY_MS: number
  REVIEW_READINESS_ATTEMPTS: number
  readinessBudgetLabel: () => string
} {
  // The preamble carries the consts AND the two redaction/excerpt helpers
  // `classifyReviewReadiness` closes over — they sit between the consts and the
  // classifier's doc comment, so this one slice is still the whole environment.
  const required = source.slice(
    source.indexOf('const REVIEW_REQUIRED_CHECKS'),
    source.indexOf('/** Classify the fixed', source.indexOf('const REVIEW_REQUIRED_CHECKS')),
  )
  // …and if a refactor ever moves them out of that slice, say so HERE rather than
  // letting `new Function` throw a bare ReferenceError from inside a test.
  if (!required.includes('function probeCause(') || !required.includes('function redactProbeText(')) {
    throw new Error('probeCause/redactProbeText are no longer in the readiness preamble slice')
  }
  const classifyAt = source.indexOf('function classifyReviewReadiness(')
  const classifySource = source.slice(classifyAt, source.indexOf('/**\n * Retry only readiness', classifyAt))
  const reviewAt = source.indexOf('async function reviewWithPreconditions(')
  const reviewSource = source.slice(reviewAt, source.indexOf('/**\n * CI findings', reviewAt))
  const factory = new Function(
    `${required}\n${classifySource}\n${reviewSource}\nreturn { classifyReviewReadiness, reviewWithPreconditions, probeCause, redactProbeText, REVIEW_READINESS_BUDGET_MS, REVIEW_READINESS_RETRY_MS, REVIEW_READINESS_ATTEMPTS, readinessBudgetLabel }`,
  ) as () => ReturnType<typeof loadReadiness>
  return factory()
}

const readinessProbe = (
  mergeable: string,
  rows: Array<{ name: string; status: string; conclusion: string | null }>,
) => ({ raw: JSON.stringify({ mergeable, statusCheckRollup: rows }), exit_code: 0 })

const completedChecks = (conclusion: string) =>
  ['test', 'lint', 'typecheck'].map((name) => ({ name, status: 'COMPLETED', conclusion }))

describe('review-round preconditions — refuse before spending', () => {
  test('HEADLINE: a conflicting PR consumes zero review rounds and names the repair', async () => {
    const { classifyReviewReadiness, reviewWithPreconditions } = loadReadiness()
    let spent = 0
    const out = await reviewWithPreconditions({
      probe: async () => classifyReviewReadiness(readinessProbe('CONFLICTING', completedChecks('SUCCESS'))),
      spend: async () => { spent += 1 },
      wait: async () => {},
    })
    expect(out.deferred).toBe(true)
    expect(spent).toBe(0)
    expect(out.readiness.reason).toContain('conflicting with base')
  })

  test('absent, passed, and failed are three explicit states; absent spends nothing', async () => {
    const { classifyReviewReadiness, reviewWithPreconditions } = loadReadiness()
    const absent = classifyReviewReadiness(readinessProbe('MERGEABLE', completedChecks('SUCCESS').filter((r) => r.name !== 'test')))
    const passed = classifyReviewReadiness(readinessProbe('MERGEABLE', completedChecks('SUCCESS')))
    const failed = classifyReviewReadiness(readinessProbe('MERGEABLE', completedChecks('SUCCESS').map((r) => r.name === 'test' ? { ...r, conclusion: 'FAILURE' } : r)))
    expect([absent.status, passed.status, failed.status]).toEqual(['absent', 'passed', 'failed'])
    expect(absent.reason).toContain('required check test has not run')
    expect(classifyReviewReadiness(readinessProbe('MERGEABLE', completedChecks('SUCCESS').map((r) => r.name === 'test' ? { ...r, conclusion: 'SKIPPED' } : r))).status).toBe('absent')
    let spent = 0
    await reviewWithPreconditions({ probe: async () => absent, spend: async () => { spent += 1 }, wait: async () => {}, attempts: 1 })
    expect(spent).toBe(0)
  })

  test('a queued check retries without spending or incrementing a round, then reviews once', async () => {
    const { classifyReviewReadiness, reviewWithPreconditions } = loadReadiness()
    const queuedRows = completedChecks('SUCCESS').map((r) => r.name === 'test' ? { ...r, status: 'QUEUED', conclusion: null } : r)
    const answers = [classifyReviewReadiness(readinessProbe('MERGEABLE', queuedRows)), classifyReviewReadiness(readinessProbe('MERGEABLE', completedChecks('SUCCESS')))]
    let probes = 0
    let waits = 0
    let spent = 0
    const out = await reviewWithPreconditions({
      probe: async () => answers[probes++]!,
      spend: async () => { spent += 1; return 'healthy-review' },
      wait: async () => { waits += 1 },
    })
    expect({ probes, waits, spent, value: out.value }).toEqual({ probes: 2, waits: 1, spent: 1, value: 'healthy-review' })
  })

  test('healthy and failed-check PRs enter the existing review path exactly once', async () => {
    const { classifyReviewReadiness, reviewWithPreconditions } = loadReadiness()
    for (const rows of [completedChecks('SUCCESS'), completedChecks('SUCCESS').map((r) => r.name === 'lint' ? { ...r, conclusion: 'FAILURE' } : r)]) {
      let spent = 0
      const out = await reviewWithPreconditions({ probe: async () => classifyReviewReadiness(readinessProbe('MERGEABLE', rows)), spend: async () => ++spent, wait: async () => {} })
      expect(out.deferred).toBe(false)
      expect(spent).toBe(1)
    }
  })

  // ── THE BUDGET IS A MEASUREMENT, AND THESE TESTS ARE WHERE IT IS KEPT ──────
  //
  // MEASURED 2026-08-15, rjunee/neutron PR #275 commit 6ba7500: pushed 00:55:56Z,
  // required check `test` STARTED 01:01:24Z (+328 s of GitHub Actions queue time)
  // and finished 4 s later. Until the workflow is created the check is ABSENT from
  // the rollup, so the gate is asking about a row that does not exist yet.
  //
  // The old budget was 3 attempts x 15 s = 30 s and lost every single time: four
  // consecutive builds of one card were destroyed by it. Anyone tempted to shrink
  // it again has to make these go red first, which is the point of putting the
  // numbers here rather than in a comment nobody runs.
  const MEASURED_QUEUE_MS = 328_000
  const OLD_BUDGET_ATTEMPTS = 3
  const OLD_BUDGET_RETRY_MS = 15_000

  /** Absent until the (virtual) clock passes `readyAtMs`, then all three checks green. */
  const queuedUntil = (readyAtMs: number) => {
    let clock = 0
    return {
      advance: (ms: number) => { clock += ms },
      rows: () => (clock < readyAtMs ? completedChecks('SUCCESS').filter((r) => r.name !== 'test') : completedChecks('SUCCESS')),
    }
  }

  test('HEADLINE: the gate outlasts the MEASURED 328 s Actions queue and reviews once', async () => {
    const { classifyReviewReadiness, reviewWithPreconditions, REVIEW_READINESS_RETRY_MS } = loadReadiness()
    const ci = queuedUntil(MEASURED_QUEUE_MS)
    let spent = 0
    const out = await reviewWithPreconditions({
      probe: async () => classifyReviewReadiness(readinessProbe('MERGEABLE', ci.rows())),
      spend: async () => { spent += 1; return 'real-review' },
      wait: async () => ci.advance(REVIEW_READINESS_RETRY_MS),
    })
    // Deferred=false is the whole fix: the build reaches a reviewer instead of dying.
    expect({ deferred: out.deferred, spent, value: out.value }).toEqual({ deferred: false, spent: 1, value: 'real-review' })
  })

  test('REGRESSION: the OLD 30-second budget loses that exact race — 0 reviews', async () => {
    const { classifyReviewReadiness, reviewWithPreconditions } = loadReadiness()
    const ci = queuedUntil(MEASURED_QUEUE_MS)
    let spent = 0
    const out = await reviewWithPreconditions({
      probe: async () => classifyReviewReadiness(readinessProbe('MERGEABLE', ci.rows())),
      spend: async () => { spent += 1 },
      wait: async () => ci.advance(OLD_BUDGET_RETRY_MS),
      attempts: OLD_BUDGET_ATTEMPTS,
    })
    expect({ deferred: out.deferred, spent }).toEqual({ deferred: true, spent: 0 })
    expect(out.readiness.reason).toContain('required check test has not run')
  })

  test('the attempt COUNT is derived from the budget, and the budget clears the measurement', () => {
    const { REVIEW_READINESS_BUDGET_MS, REVIEW_READINESS_RETRY_MS, REVIEW_READINESS_ATTEMPTS } = loadReadiness()
    // The waiting the loop can actually do — attempts-1 waits, the first probe is free.
    const spendable = (REVIEW_READINESS_ATTEMPTS - 1) * REVIEW_READINESS_RETRY_MS
    expect(spendable).toBeGreaterThanOrEqual(REVIEW_READINESS_BUDGET_MS)
    // Generous, not tuned: at least double the measured queue. `liveness.ts` records
    // what finely-tuned thresholds cost when the thing they measure moves.
    expect(REVIEW_READINESS_BUDGET_MS).toBeGreaterThanOrEqual(MEASURED_QUEUE_MS * 2)
  })

  test('a permanently absent check still stops — and the reason says how long it waited', async () => {
    const { classifyReviewReadiness, reviewWithPreconditions, readinessBudgetLabel } = loadReadiness()
    let probes = 0
    const out = await reviewWithPreconditions({
      probe: async () => { probes += 1; return classifyReviewReadiness(readinessProbe('MERGEABLE', completedChecks('SUCCESS').filter((r) => r.name !== 'test'))) },
      spend: async () => { throw new Error('must not review on an absent check') },
      wait: async () => {},
    })
    expect(out.deferred).toBe(true)
    expect(probes).toBe(loadReadiness().REVIEW_READINESS_ATTEMPTS)
    // The owner-facing sentence must distinguish "we never waited" from "we waited
    // and it never came"; only the second is his to act on.
    expect(readinessBudgetLabel()).toBe('15 minutes')
    expect(SRC).toContain('The readiness gate waited ${readinessBudgetLabel()} and the check never appeared')
  })

  test('MUTANTS: delete conflict guard, absent→passed, and absent→failed all go RED', () => {
    const conflictMutant = SRC.replace("if (mergeable === 'CONFLICTING') {", "if (false) {")
    expect(() => expect(loadReadiness(conflictMutant).classifyReviewReadiness(readinessProbe('CONFLICTING', completedChecks('SUCCESS'))).status).toBe('conflicting')).toThrow()
    const absentPassedMutant = SRC.replace("return { status: 'absent', reason: `required check ${name} has not run` }", "return { status: 'passed', reason: '' }")
    expect(() => expect(loadReadiness(absentPassedMutant).classifyReviewReadiness(readinessProbe('MERGEABLE', completedChecks('SUCCESS').slice(1))).status).toBe('absent')).toThrow()
    const absentFailedMutant = SRC.replace("return { status: 'absent', reason: `required check ${name} has not run` }", "return { status: 'failed', reason: '', failed: [name] }")
    expect(() => expect(loadReadiness(absentFailedMutant).classifyReviewReadiness(readinessProbe('MERGEABLE', completedChecks('SUCCESS').slice(1))).status).toBe('absent')).toThrow()
  })
})

/**
 * THE PROBE'S OWN WORDS SURVIVE THE CLASSIFIER.
 *
 * MEASURED, run `8417b277` (2026-08-14). The readiness probe held, verbatim:
 *
 *   raw[0]=To get started with GitHub CLI, please run:  gh auth login
 *
 * `classifyReviewReadiness` mapped that to `{status:'unknown', reason:'PR readiness could
 * not be read'}` and DROPPED `raw`. The build then died as REQUEST_CHANGES with a stored
 * reason blaming ten review rounds that never ran. #240's rule, applied here: measure the
 * cause, and having measured it, do not throw it away.
 *
 * The risk this opens is the same one `redactPushError` exists for — a probe's raw output
 * is exactly where an echoed remote URL or token surfaces — so carrying the text and
 * redacting it are ONE change.
 */
describe('classifyReviewReadiness — an unreadable probe quotes what it could not read', () => {
  test("HEADLINE: the gh-auth message reaches the reason instead of being discarded", () => {
    const { classifyReviewReadiness } = loadReadiness()
    const out = classifyReviewReadiness({
      raw: 'To get started with GitHub CLI, please run:\n  gh auth login',
      exit_code: 1,
    })
    expect(out.status).toBe('unknown')
    expect(out.reason).toContain('PR readiness could not be read')
    // The whole point: the repair is now IN the sentence a human reads.
    expect(out.reason).toContain('gh auth login')
  })

  test('every unreadable branch quotes the probe, not just the non-zero exit', () => {
    const { classifyReviewReadiness } = loadReadiness()
    // exit 0 with no braces at all, exit 0 with unparseable braces, and exit 0 with the
    // wrong shape — three distinct returns that all used to say the same nine words.
    for (const raw of ['gh: something odd happened', '{not json at all', '{"mergeable":"MERGEABLE"}']) {
      const out = classifyReviewReadiness({ raw, exit_code: 0 })
      expect(out.status).toBe('unknown')
      expect(out.reason.startsWith('PR readiness could not be read: ')).toBe(true)
      expect(out.reason).toContain(raw.split('\n')[0]!.slice(0, 20))
    }
  })

  test('a credential echoed by the probe never reaches the reason', () => {
    const { classifyReviewReadiness } = loadReadiness()
    const raw = "fatal: could not read Password for 'https://x-access-token:ghp_abc123SECRET@github.com/o/r'"
    expect(raw).toContain('ghp_abc123SECRET') // positive control: it IS in the input
    const out = classifyReviewReadiness({ raw, exit_code: 1 })
    expect(out.reason).not.toContain('ghp_abc123SECRET')
    expect(out.reason).toContain('***@')
    // …and the diagnosis survives, or redaction has eaten the reason for carrying it.
    expect(out.reason).toContain('could not read Password')
  })

  test('nothing measured → nothing asserted: the bare sentence, exactly as before', () => {
    const { classifyReviewReadiness } = loadReadiness()
    for (const probe of [{ raw: '', exit_code: 1 }, { raw: '   \n\n  ', exit_code: 1 }, { exit_code: 1 }]) {
      expect(classifyReviewReadiness(probe).reason).toBe('PR readiness could not be read')
    }
    // …and a probe that is not an object at all has no `raw` to quote.
    expect(classifyReviewReadiness(null).reason).toBe('PR readiness could not be read')
    expect(classifyReviewReadiness(undefined).reason).toBe('PR readiness could not be read')
  })

  test('an unbounded paste is bounded — this reason ends up in a chat row', () => {
    const { classifyReviewReadiness } = loadReadiness()
    const out = classifyReviewReadiness({ raw: 'x'.repeat(500), exit_code: 1 })
    expect(out.reason.length).toBeLessThanOrEqual(250)
    expect(out.reason).toContain('PR readiness could not be read')
  })

  test('the readable states are untouched — conflicting/pending/absent/passed/failed', () => {
    // The enrichment must not have leaked into any branch that DID read the probe.
    const { classifyReviewReadiness } = loadReadiness()
    expect(classifyReviewReadiness(readinessProbe('CONFLICTING', completedChecks('SUCCESS'))).reason).toBe(
      'PR is conflicting with base',
    )
    expect(classifyReviewReadiness(readinessProbe('UNKNOWN', completedChecks('SUCCESS'))).reason).toBe(
      'PR mergeability is still being calculated',
    )
    expect(classifyReviewReadiness(readinessProbe('MERGEABLE', completedChecks('SUCCESS'))).status).toBe('passed')
  })

  test('MUTANT: dropping the excerpt goes RED', () => {
    const mutant = SRC.replace(
      "reason: cause === '' ? 'PR readiness could not be read' : 'PR readiness could not be read: ' + cause,",
      "reason: 'PR readiness could not be read',",
    )
    expect(mutant).not.toBe(SRC) // positive control: the replacement matched
    expect(() =>
      expect(
        loadReadiness(mutant).classifyReviewReadiness({ raw: 'gh auth login', exit_code: 1 }).reason,
      ).toContain('gh auth login'),
    ).toThrow()
  })
})

/**
 * `ciDeferredPeer` — "could not tell" now says WHAT it could not tell.
 */
describe('the deferred-CI peer quotes the probe', () => {
  test('an unreadable CI probe carries the probe words into the peer evidence', () => {
    const { classifyCi, ciDeferredPeer } = loadReal()
    const peer = ciDeferredPeer(classifyCi({ raw: 'gh: To get started, run: gh auth login', exit_code: 127 }))
    expect(peer.evidence).toContain('gh auth login')
    // The existing sentence is kept AFTER the quotation, not replaced by it.
    expect(peer.evidence).toContain('could not be read')
  })

  test('a PENDING peer is unchanged — there is no probe complaint to quote', () => {
    const { classifyCi, ciDeferredPeer } = loadReal()
    const peer = ciDeferredPeer(
      classifyCi({ raw: JSON.stringify([{ name: 'a', state: 'IN_PROGRESS' }]), exit_code: 8 }),
    )
    expect(peer.evidence.startsWith('the PR checks had not finished')).toBe(true)
  })
})

/**
 * `infraTerminalCause` — the one line the terminal result carries out of the workflow.
 *
 * The orchestrator has always REFUSED to infer a cause from `(round, checkpoint)`, twice
 * on Codex's insistence and twice correctly. So the cause has to be measured where it is
 * known — here — or the stored reason stays generic forever.
 */
describe('infraTerminalCause — the LANE finding is the measured cause', () => {
  function loadTerminalCause(source = SRC): (synthesis: unknown) => string {
    const kind = source.slice(source.indexOf('const LANE_FINDING_KIND'), source.indexOf('\n', source.indexOf('const LANE_FINDING_KIND')))
    const factory = new Function(
      `${kind}\n${grab('redactProbeText')}\n${grab('infraTerminalCause')}\nreturn infraTerminalCause`,
    ) as () => (synthesis: unknown) => string
    return factory()
  }

  test('HEADLINE: the deferral title — which quotes the probe — is what comes out', () => {
    const infraTerminalCause = loadTerminalCause()
    const title = 'REVIEW DEFERRED — PR readiness could not be read: gh auth login'
    expect(
      infraTerminalCause({ findings: [{ severity: 'blocker', kind: 'lane', title }] }),
    ).toBe(title)
  })

  test('the LANE finding wins over an ordinary one, wherever it sits', () => {
    const infraTerminalCause = loadTerminalCause()
    expect(
      infraTerminalCause({
        findings: [
          { severity: 'blocker', title: 'CI FAILING: test' },
          { severity: 'blocker', kind: 'lane', title: 'REVIEW DEFERRED — no seat ran' },
        ],
      }),
    ).toBe('REVIEW DEFERRED — no seat ran')
  })

  test('no lane finding → the first titled finding; no findings → empty', () => {
    const infraTerminalCause = loadTerminalCause()
    expect(infraTerminalCause({ findings: [{ severity: 'blocker', title: 'CI FAILING: test' }] })).toBe(
      'CI FAILING: test',
    )
    expect(infraTerminalCause({ findings: [] })).toBe('')
    expect(infraTerminalCause({})).toBe('')
    expect(infraTerminalCause(null)).toBe('')
    expect(infraTerminalCause({ findings: [{ severity: 'blocker' }, null, { title: '' }] })).toBe('')
  })

  test('a credential in a finding title is redacted, and the line is bounded', () => {
    const infraTerminalCause = loadTerminalCause()
    const out = infraTerminalCause({
      findings: [{ kind: 'lane', title: 'REVIEW DEFERRED — https://x:ghp_abc123@github.com/o/r ' + 'y'.repeat(500) }],
    })
    expect(out).not.toContain('ghp_abc123')
    expect(out).toContain('***@')
    expect(out.length).toBeLessThanOrEqual(300)
  })
})

/**
 * WIRING — the terminal result actually carries the cause, and only where it should.
 * Source assertions, because the terminal literal lives inside the workflow body and
 * cannot be evaluated in isolation.
 */
describe('the terminal result emits terminalCause for infra-only stops only', () => {
  test('the gate is BOTH infra-only AND a non-empty measured cause', () => {
    const gate = SRC.slice(SRC.indexOf('const isInfraOnlyStop ='), SRC.indexOf('log(', SRC.indexOf('const isInfraOnlyStop =')))
    expect(gate).toContain("synthesis.blockKind === 'infra-only'")
    expect(gate).toContain("terminalCause !== ''")
    expect(gate).toContain('roundLostItsWork === null')
    expect(gate).toContain("finalVerdict !== 'APPROVE'")
    expect(SRC).toContain('...(isInfraOnlyStop ? { terminalCause } : {}),')
  })

  /**
   * A THROW CARRIES THE MESSAGE IT THREW — AND NOTHING ELSE.
   *
   * This used to assert the opposite (`failureResult` must carry NO `terminalCause`), on
   * the reasoning that a crash is not a measured infra-only stop. Half of that is right and
   * is still pinned below: a crash has no BLOCK KIND, so it must never claim the code was
   * judged or that "review never ran". But the thrown MESSAGE is a measurement — the
   * workflow composed it at the point the fact was known — and dropping it is what left run
   * 3d2696c3 ("forge:build completed without a full local commit OID") reported to the
   * operator as "…without Argus APPROVE" on a path Argus never reached.
   */
  test('the THROWN-workflow failure result carries the message, and no block kind', () => {
    const failure = SRC.slice(SRC.indexOf('const failureResult = {'), SRC.indexOf('\n  }', SRC.indexOf('const failureResult = {')))
    // The thrown text, through the same redact + cap helper every other cause uses…
    expect(failure).toContain('terminalCause: infraCause(thrownMessage)')
    // …and NOT a fabricated block kind: that field is what licenses the outer loop's
    // "review never ran (infra-only)" sentence, and a crash measured no such thing.
    // (The PROPERTY, not the word — the comment beside it names the field on purpose.)
    expect(failure).not.toContain('blockKind:')
    // The message reported to the log and the message persisted are ONE value, so the
    // transcript and the row cannot disagree about why the run died.
    expect(SRC).toContain('log(`trident-v2 inner THREW: ${thrownMessage}`)')
  })
})
