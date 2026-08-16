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

interface RequiredConfig {
  mode: string
  required?: string[]
  /** The subset of `required` bound to one producing App — see `bindingOf`. */
  appBound?: string[]
  produced?: string[] | null
  cause?: string
}

function loadReadiness(source = SRC): {
  classifyReviewReadiness: (probe: unknown, requiredConfig?: unknown, elapsedMs?: number) => Readiness
  classifyRequiredChecksProbe: (probe: unknown) => RequiredConfig
  confirmedConfigError: (
    first: Readiness,
    freshConfig: unknown,
    reclassify: (cfg: unknown) => Readiness,
  ) => Readiness
  probeSections: (raw: unknown) => Record<string, string>
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
  REVIEW_READINESS_CONFIG_GRACE_MS: number
  readinessBudgetLabel: () => string
  readinessGraceLabel: () => string
} {
  // The preamble carries the budget consts AND the helpers `classifyReviewReadiness`
  // closes over — the two redaction/excerpt ones and `classifyRequiredChecksProbe`.
  // They sit between the budget const and the classifier's doc comment, so this one
  // slice is still the whole environment.
  //
  // EVERY ANCHOR BELOW IS CHECKED BY NAME. A slice loader that silently produces `-1`
  // fails as a bare ReferenceError inside an unrelated test, which is how a moved
  // constant reads as "four tests are broken" instead of "the loader needs updating".
  const anchor = (needle: string, from = 0): number => {
    const at = source.indexOf(needle, from)
    if (at === -1) {
      throw new Error(
        `ci-gate.test.ts slice anchor ${JSON.stringify(needle)} is no longer in inner-workflow.mjs — ` +
          'the readiness slice loader needs updating to the new boundary',
      )
    }
    return at
  }
  const preambleAt = anchor('const REVIEW_READINESS_BUDGET_MS')
  const required = source.slice(preambleAt, anchor('/** Classify the fixed', preambleAt))
  // …and if a refactor ever moves the helpers out of that slice, say so HERE rather
  // than letting `new Function` throw a bare ReferenceError from inside a test.
  for (const helper of [
    'probeCause(',
    'redactProbeText(',
    'classifyRequiredChecksProbe(',
    'probeSections(',
    'normalizeRollupRow(',
    'confirmedConfigError(',
  ]) {
    if (!required.includes(`function ${helper}`)) {
      throw new Error(`${helper} is no longer inside the readiness preamble slice`)
    }
  }
  const classifyAt = anchor('function classifyReviewReadiness(')
  const classifySource = source.slice(classifyAt, anchor('/**\n * Retry only readiness', classifyAt))
  const reviewAt = anchor('async function reviewWithPreconditions(')
  const reviewSource = source.slice(reviewAt, anchor('/**\n * CI findings', reviewAt))
  const factory = new Function(
    `${required}\n${classifySource}\n${reviewSource}\nreturn { classifyReviewReadiness, classifyRequiredChecksProbe, confirmedConfigError, probeSections, reviewWithPreconditions, probeCause, redactProbeText, REVIEW_READINESS_BUDGET_MS, REVIEW_READINESS_RETRY_MS, REVIEW_READINESS_ATTEMPTS, REVIEW_READINESS_CONFIG_GRACE_MS, readinessBudgetLabel, readinessGraceLabel }`,
  ) as () => ReturnType<typeof loadReadiness>
  return factory()
}

const readinessProbe = (
  mergeable: string,
  rows: Array<{ name: string; status: string; conclusion: string | null }>,
) => ({ raw: JSON.stringify({ mergeable, statusCheckRollup: rows }), exit_code: 0 })

/**
 * What the base branch requires, as `classifyRequiredChecksProbe` resolves it.
 *
 * `['test','lint','typecheck']` survives in this file as FIXTURE data — those names
 * are what THIS repository's protection asks for, and the point of the change is that
 * the workflow reads them from GitHub instead of carrying them as a literal.
 */
const requiredCfg = (required: string[], produced: string[] | null = required) => ({
  mode: 'resolved',
  required,
  produced,
})
const THIS_REPO = () => requiredCfg(['test', 'lint', 'typecheck'])

const completedChecks = (conclusion: string) =>
  ['test', 'lint', 'typecheck'].map((name) => ({ name, status: 'COMPLETED', conclusion }))

/**
 * A MUTATION TEST HAS TO PROVE THREE THINGS, AND EACH ALONE IS WORTHLESS.
 *
 * Asserting the MUTANT'S OWN answer (`expect(mutantAnswer).toBe('config-error')`)
 * documents that the mutant behaves differently and stops there — it never shows that
 * any guard in this file would CATCH it. A suite of those stays green while the defect
 * walks straight back in, which is precisely the failure this PR exists to fix one
 * level down: a test that pins behaviour is not a test that defends it. (Argus r2
 * measured three of them here, all green against their own mutants.)
 *
 * Asserting only that something threw is worse: a mutant whose source no longer parses
 * throws on LOAD, so `toThrow()` passes while the mutation never ran at all.
 *
 * So all three, in order: the replacement MATCHED, the mutant LOADS, and the real
 * guard's own assertion replayed against it goes RED. What the mutant answers instead
 * is then recorded as documentation — never as the assertion carrying the test.
 */
function mutate(mutantSource: string): ReturnType<typeof loadReadiness> {
  expect(mutantSource).not.toBe(SRC)
  return loadReadiness(mutantSource)
}
/** The guard's own assertion, replayed against the mutant. It must FAIL. */
const goesRed = (guardAssertion: () => void) => expect(guardAssertion).toThrow()

describe('review-round preconditions — refuse before spending', () => {
  test('HEADLINE: a conflicting PR consumes zero review rounds and names the repair', async () => {
    const { classifyReviewReadiness, reviewWithPreconditions } = loadReadiness()
    let spent = 0
    const out = await reviewWithPreconditions({
      probe: async () => classifyReviewReadiness(readinessProbe('CONFLICTING', completedChecks('SUCCESS')), THIS_REPO()),
      spend: async () => { spent += 1 },
      wait: async () => {},
    })
    expect(out.deferred).toBe(true)
    expect(spent).toBe(0)
    expect(out.readiness.reason).toContain('conflicting with base')
  })

  test('absent, passed, and failed are three explicit states; absent spends nothing', async () => {
    const { classifyReviewReadiness, reviewWithPreconditions } = loadReadiness()
    const absent = classifyReviewReadiness(readinessProbe('MERGEABLE', completedChecks('SUCCESS').filter((r) => r.name !== 'test')), THIS_REPO())
    const passed = classifyReviewReadiness(readinessProbe('MERGEABLE', completedChecks('SUCCESS')), THIS_REPO())
    const failed = classifyReviewReadiness(readinessProbe('MERGEABLE', completedChecks('SUCCESS').map((r) => r.name === 'test' ? { ...r, conclusion: 'FAILURE' } : r)), THIS_REPO())
    expect([absent.status, passed.status, failed.status]).toEqual(['absent', 'passed', 'failed'])
    expect(absent.reason).toContain('required check test has not run')
    expect(classifyReviewReadiness(readinessProbe('MERGEABLE', completedChecks('SUCCESS').map((r) => r.name === 'test' ? { ...r, conclusion: 'SKIPPED' } : r)), THIS_REPO()).status).toBe('absent')
    let spent = 0
    await reviewWithPreconditions({ probe: async () => absent, spend: async () => { spent += 1 }, wait: async () => {}, attempts: 1 })
    expect(spent).toBe(0)
  })

  test('a queued check retries without spending or incrementing a round, then reviews once', async () => {
    const { classifyReviewReadiness, reviewWithPreconditions } = loadReadiness()
    const queuedRows = completedChecks('SUCCESS').map((r) => r.name === 'test' ? { ...r, status: 'QUEUED', conclusion: null } : r)
    const answers = [classifyReviewReadiness(readinessProbe('MERGEABLE', queuedRows), THIS_REPO()), classifyReviewReadiness(readinessProbe('MERGEABLE', completedChecks('SUCCESS')), THIS_REPO())]
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
      const out = await reviewWithPreconditions({ probe: async () => classifyReviewReadiness(readinessProbe('MERGEABLE', rows), THIS_REPO()), spend: async () => ++spent, wait: async () => {} })
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
      probe: async () => classifyReviewReadiness(readinessProbe('MERGEABLE', ci.rows()), THIS_REPO()),
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
      probe: async () => classifyReviewReadiness(readinessProbe('MERGEABLE', ci.rows()), THIS_REPO()),
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
      probe: async () => { probes += 1; return classifyReviewReadiness(readinessProbe('MERGEABLE', completedChecks('SUCCESS').filter((r) => r.name !== 'test')), THIS_REPO()) },
      spend: async () => { throw new Error('must not review on an absent check') },
      wait: async () => {},
    })
    expect(out.deferred).toBe(true)
    expect(probes).toBe(loadReadiness().REVIEW_READINESS_ATTEMPTS)
    // The owner-facing sentence must distinguish "we never waited" from "we waited
    // and it never came"; only the second is his to act on.
    expect(readinessBudgetLabel()).toBe('15 minutes')
    expect(SRC).toContain('The readiness gate waited at least ${readinessBudgetLabel()} and the check never appeared')
  })

  test('MUTANTS: delete conflict guard, absent→passed, and absent→failed all go RED', () => {
    const conflictMutant = SRC.replace("if (mergeable === 'CONFLICTING') {", "if (false) {")
    expect(() => expect(loadReadiness(conflictMutant).classifyReviewReadiness(readinessProbe('CONFLICTING', completedChecks('SUCCESS')), THIS_REPO()).status).toBe('conflicting')).toThrow()
    const absentPassedMutant = SRC.replace("return { status: 'absent', reason: `required check ${name} has not run` }", "return { status: 'passed', reason: '' }")
    expect(() => expect(loadReadiness(absentPassedMutant).classifyReviewReadiness(readinessProbe('MERGEABLE', completedChecks('SUCCESS').slice(1)), THIS_REPO()).status).toBe('absent')).toThrow()
    const absentFailedMutant = SRC.replace("return { status: 'absent', reason: `required check ${name} has not run` }", "return { status: 'failed', reason: '', failed: [name] }")
    expect(() => expect(loadReadiness(absentFailedMutant).classifyReviewReadiness(readinessProbe('MERGEABLE', completedChecks('SUCCESS').slice(1)), THIS_REPO()).status).toBe('absent')).toThrow()
  })
})

/**
 * WHICH CHECKS ARE REQUIRED IS THE BASE BRANCH'S ANSWER, NOT A LITERAL IN THE SOURCE.
 *
 * MEASURED, a sibling repository's run `a6da50ea` / PR #515. The gate carried
 * `REVIEW_REQUIRED_CHECKS = ['test','lint','typecheck']` — THIS repository's job names
 * — into a workflow that runs against several repositories. That repository emits
 * `check`, `frontend`, `license-gate`, … and none of the three exists there, so a PR
 * that was 8-of-9 green (including an 11m23s `check` sweep) burned the whole 15-minute
 * budget and deferred with `required check test has not run`: a queue-delay sentence
 * for a configuration fault. Review had never run in that repo and could not.
 */
const ENTERPRISE_ROLLUP = [
  'check',
  'frontend',
  'license-gate',
  'live-postgres',
  'live-postgres-pooled',
  'sbom',
  'upgrade',
  'vuln-scan',
  'review-gate',
].map((name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' }))

/**
 * The five-section transcription `probeRequiredChecks` hands to the classifier.
 *
 * `branch` defaults to the shape that PROVES the base branch is unprotected
 * (`protected:false`), so every fixture that is not ABOUT the 404 ambiguity keeps
 * reading as it did. The tests that are about it pass the field explicitly.
 *
 * THE PRODUCED LISTS ARE OBJECTS, NOT BARE ARRAYS — `{n, names}`, because the probe
 * asks for GitHub's `total_count` beside the names so a truncated page is detectable.
 * `named()` builds the untruncated shape; a test that wants truncation writes `n`
 * larger than the array by hand.
 */
const named = (names: string[], n?: number) => JSON.stringify({ n: n ?? names.length, names })
/**
 * A FIXTURE MAY NOT DESCRIBE TWO WORLDS AT ONCE.
 *
 * The branch payload and the rulesets payload are two readings of ONE repository, so a
 * fixture that makes them disagree tests a state GitHub never emits — and a test that
 * passes on an impossible world defends nothing. Measured on the base branch this gate
 * runs against: a branch a ruleset governs reports `protected:true` (with
 * `protection.enabled:false`, no classic protection), never `protected:false`.
 *
 * Only enforced where the branch section is LOAD-BEARING — the classifier reads it
 * solely when the protection subresource 404s. With a readable protection endpoint the
 * branch text is inert, so pinning it there would be noise rather than a guard.
 */
const assertBranchAgreesWithRules = (s: { prot: string; protExit: number; rules: string; branch?: string }) => {
  const branchIsRead = s.protExit !== 0
  const rulesRequire = s.rules.includes('required_status_checks')
  const claimsUnprotected = (s.branch ?? '{"protected":false}').includes('"protected":false')
  if (branchIsRead && rulesRequire && claimsUnprotected) {
    throw new Error(
      'impossible fixture: a branch governed by a ruleset that requires a status check ' +
        'reports protected:true — pass RULESET_GOVERNED_BRANCH_MEASURED, not protected:false',
    )
  }
  return ''
}
const requiredProbe = (s: {
  prot: string
  protExit: number
  rules: string
  rulesExit: number
  runs?: string
  runsExit?: number
  statuses?: string
  statusesExit?: number
  branch?: string
  branchExit?: number
}) => ({
  raw:
    `${assertBranchAgreesWithRules(s)}${s.prot}\n___PROT_EXIT=${s.protExit}\n` +
    `___SECTION=BRANCH\n${s.branch ?? '{"protected":false}'}\n___BRANCH_EXIT=${s.branchExit ?? 0}\n` +
    `___SECTION=RULES\n${s.rules}\n___RULES_EXIT=${s.rulesExit}\n` +
    `___SECTION=RUNS\n${s.runs ?? named([])}\n___RUNS_EXIT=${s.runsExit ?? 0}\n` +
    `___SECTION=STATUSES\n${s.statuses ?? named([])}\n___STATUSES_EXIT=${s.statusesExit ?? 0}\n___EXIT=0`,
  exit_code: 0,
})
const NOT_FOUND = 'gh: Not Found (HTTP 404)'
/**
 * A RULESET-GOVERNED BRANCH, carrying ONLY the two flags: `protected` is TRUE (a
 * ruleset applies) while `protection.enabled` is FALSE (no classic protection). The old
 * fixture defaulted `protected:false` everywhere, a state such a branch never reports,
 * which is why no test could see that the shipped classifier answered `unknown` on the
 * primary repository and deferred every round.
 *
 * THIS IS THE `protection.enabled` RUNG SPECIFICALLY — the projection carries no
 * `contexts` key, so it is the case that must be settled by the flags alone.
 * `RULESET_GOVERNED_BRANCH_MEASURED` below is what the probe now actually receives.
 */
const RULESET_GOVERNED_BRANCH = '{"protected":true,"protectionEnabled":false}'
/**
 * …and the FULL projection, measured this session with a credential holding no admin
 * role on the base branch this gate runs against. The probe asks for the contexts now,
 * so this — not the two-flag shape above — is the live response.
 */
const RULESET_GOVERNED_BRANCH_MEASURED = '{"protected":true,"protectionEnabled":false,"contexts":[],"checks":[]}'
/** Classic protection really is on, and this credential may not read what it requires. */
const CLASSIC_PROTECTED_BRANCH = '{"protected":true,"protectionEnabled":true}'

describe('the required-check set comes from the base branch, not from this repo’s job names', () => {
  test('HEADLINE: the sibling repository rollup PASSES readiness on an unprotected base', () => {
    // The exact rollup of PR #515, on a base whose protection endpoint 404s. There is
    // no `test`/`lint`/`typecheck` anywhere in it, and it is healthy.
    const { classifyReviewReadiness } = loadReadiness()
    const out = classifyReviewReadiness(readinessProbe('MERGEABLE', ENTERPRISE_ROLLUP), requiredCfg([], null))
    expect(out.status).toBe('passed')
  })

  test('HEADLINE: the same rollup under a protection demanding `test` NAMES the config error', () => {
    // The other half of the guard: if the base branch really does require a name this
    // repository never produces, the gate says so in those words — immediately.
    const { classifyReviewReadiness } = loadReadiness()
    const { REVIEW_READINESS_CONFIG_GRACE_MS } = loadReadiness()
    const out = classifyReviewReadiness(
      readinessProbe('MERGEABLE', ENTERPRISE_ROLLUP),
      requiredCfg(['test'], ['check', 'frontend']),
      REVIEW_READINESS_CONFIG_GRACE_MS,
    )
    expect(out.status).toBe('config-error')
    // THE REASON STATES THE EVIDENCE, NOT A CONCLUSION THE DATA CANNOT SUPPORT. It used
    // to read "is not produced by any workflow in this repository" — an absolute that
    // one snapshot of the base head can never establish, and one that sends the owner
    // hunting for a workflow that may exist and simply be conditional.
    expect(out.reason).toBe(
      'required check test has not appeared after at least 10 minutes, every other check on this PR has finished, ' +
        'and the base branch head reports 2 other checks without it',
    )
    expect(out.reason).not.toContain('any workflow')
  })

  test('…and there is NO third outcome for that rollup: it never defers silently', async () => {
    // Exhaustive by construction — the only two configs a base branch can produce for
    // this rollup are "requires nothing" and "requires a name nothing here emits", and
    // both are answered above. Here: the config error spends ZERO review seats, and it
    // stops on the settle window rather than on the full readiness budget.
    const {
      classifyReviewReadiness,
      reviewWithPreconditions,
      REVIEW_READINESS_RETRY_MS,
      REVIEW_READINESS_ATTEMPTS,
      REVIEW_READINESS_CONFIG_GRACE_MS,
    } = loadReadiness()
    let probes = 0
    let waits = 0
    let spent = 0
    const out = await reviewWithPreconditions({
      probe: async (attempt: number) => {
        probes += 1
        return classifyReviewReadiness(
          readinessProbe('MERGEABLE', ENTERPRISE_ROLLUP),
          requiredCfg(['test'], ['check', 'frontend']),
          (attempt - 1) * REVIEW_READINESS_RETRY_MS,
        )
      },
      spend: async () => { spent += 1 },
      wait: async () => { waits += 1 },
    })
    expect({ spent, deferred: out.deferred }).toEqual({ spent: 0, deferred: true })
    expect(out.readiness.status).toBe('config-error')
    // It stops the moment the grace has elapsed — not one probe later, and far short of
    // the full budget. That is the "fail fast" property, stated as arithmetic.
    expect(probes).toBe(REVIEW_READINESS_CONFIG_GRACE_MS / REVIEW_READINESS_RETRY_MS + 1)
    expect(probes).toBeLessThan(REVIEW_READINESS_ATTEMPTS)
    expect(waits).toBe(probes - 1)
    // The deferral tells the owner to REPAIR the configuration, not to wait again — and
    // names the conditional-filter case rather than asserting no such workflow exists.
    expect(SRC).toContain('This reads as a repository configuration error rather than a queue delay')
    expect(SRC).toContain('if the job is real but conditional')
  })

  test('AN EMPTY produced LIST IS NEVER A CONFIG ERROR, however long it persists', () => {
    // A base commit whose CI never ran (or whose checks have expired) reports NOTHING.
    // Absence from an empty list is not evidence about any name, and treating it as
    // evidence turns every such base branch into a permanent configuration fault well
    // before the budget — the fail-fast firing on the one input that proves nothing.
    const { classifyReviewReadiness, REVIEW_READINESS_CONFIG_GRACE_MS, REVIEW_READINESS_BUDGET_MS } = loadReadiness()
    const at = (elapsed: number) =>
      classifyReviewReadiness(readinessProbe('MERGEABLE', ENTERPRISE_ROLLUP), requiredCfg(['test'], []), elapsed)
    expect(at(REVIEW_READINESS_CONFIG_GRACE_MS).status).toBe('absent')
    expect(at(REVIEW_READINESS_BUDGET_MS).status).toBe('absent')
    // The control: the SAME elapsed time with a non-empty base-head list DOES stop.
    expect(
      classifyReviewReadiness(
        readinessProbe('MERGEABLE', ENTERPRISE_ROLLUP),
        requiredCfg(['test'], ['check']),
        REVIEW_READINESS_CONFIG_GRACE_MS,
      ).status,
    ).toBe('config-error')
  })

  test('MUTANT: letting an EMPTY produced list fail fast goes RED', () => {
    const { REVIEW_READINESS_CONFIG_GRACE_MS } = loadReadiness()
    const answer = mutate(SRC.replace('        produced.length > 0 &&\n', '')).classifyReviewReadiness(
      readinessProbe('MERGEABLE', ENTERPRISE_ROLLUP),
      requiredCfg(['test'], []),
      REVIEW_READINESS_CONFIG_GRACE_MS,
    ).status
    // The guard above ("AN EMPTY produced LIST IS NEVER A CONFIG ERROR") replayed:
    goesRed(() => expect(answer).toBe('absent'))
    expect(answer).toBe('config-error') // …what it answers instead
  })

  test('MUTANT: turning the config error back into an absent WAIT goes RED', () => {
    const mutant = SRC.replace(
      "          status: 'config-error',",
      "          status: 'absent',",
    )
    expect(mutant).not.toBe(SRC) // positive control: the replacement matched
    const { REVIEW_READINESS_CONFIG_GRACE_MS } = loadReadiness()
    expect(() =>
      expect(
        loadReadiness(mutant).classifyReviewReadiness(
          readinessProbe('MERGEABLE', ENTERPRISE_ROLLUP),
          requiredCfg(['test'], ['check', 'frontend']),
          REVIEW_READINESS_CONFIG_GRACE_MS,
        ).status,
      ).toBe('config-error'),
    ).toThrow()
  })

  test('UNPROTECTED: at least one check and all of them green — an empty rollup never passes', () => {
    const { classifyReviewReadiness } = loadReadiness()
    const un = (rows: Array<{ name: string; status: string; conclusion: string | null }>) =>
      classifyReviewReadiness(readinessProbe('MERGEABLE', rows), requiredCfg([], null))
    expect(un([{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }]).status).toBe('passed')
    // The property the deleted constant existed for: a rollup with nothing in it is
    // the CodeQL-only PR whose real workflow never started. It waits; it never passes.
    expect(un([]).status).toBe('absent')
    expect(un([]).reason).toBe('no checks have run on this PR yet')
    expect(un([{ name: 'check', status: 'COMPLETED', conclusion: 'SKIPPED' }]).status).toBe('absent')
    expect(un([{ name: 'check', status: 'QUEUED', conclusion: null }]).status).toBe('pending')
    const failed = un([
      { name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'frontend', status: 'COMPLETED', conclusion: 'FAILURE' },
    ])
    expect(failed.status).toBe('failed')
    expect(failed.failed).toEqual(['frontend'])
  })

  test('an empty rollup on an unprotected base spends the budget and then DEFERS', async () => {
    const { classifyReviewReadiness, reviewWithPreconditions } = loadReadiness()
    let spent = 0
    const out = await reviewWithPreconditions({
      probe: async () => classifyReviewReadiness(readinessProbe('MERGEABLE', []), requiredCfg([], null)),
      spend: async () => { spent += 1 },
      wait: async () => {},
      attempts: 3,
    })
    expect({ deferred: out.deferred, spent }).toEqual({ deferred: true, spent: 0 })
  })

  test('DECLARED BUT NOT YET REPORTED still waits, exactly as before', () => {
    // The distinction the whole change turns on: `test` IS produced here, it simply
    // has not been reported yet. That is a queue delay and it keeps waiting.
    const { classifyReviewReadiness } = loadReadiness()
    const missing = classifyReviewReadiness(
      readinessProbe('MERGEABLE', [{ name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }]),
      requiredCfg(['test'], ['test']),
    )
    expect(missing.status).toBe('absent')
    expect(missing.reason).toBe('required check test has not run')
    const queued = classifyReviewReadiness(
      readinessProbe('MERGEABLE', [{ name: 'test', status: 'QUEUED', conclusion: null }]),
      requiredCfg(['test'], ['test']),
    )
    expect(queued.status).toBe('pending')
    expect(queued.reason).toBe('required check test is still running')
  })

  test('FAIL-SAFE: an unreadable check-run list waits, it never fails fast', () => {
    // `produced: null` may only ever DISABLE the config-error fast-fail. Reading "we
    // could not list this repo's checks" as "this repo produces none" would turn every
    // unreadable probe into a permanent config error on a perfectly healthy PR.
    const { classifyReviewReadiness } = loadReadiness()
    const out = classifyReviewReadiness(
      readinessProbe('MERGEABLE', [{ name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }]),
      requiredCfg(['test'], null),
    )
    expect(out.status).toBe('absent')
    expect(out.reason).toBe('required check test has not run')
  })

  test('an UNKNOWN required-check config is never green — it defers quoting the cause', () => {
    const { classifyReviewReadiness } = loadReadiness()
    const out = classifyReviewReadiness(readinessProbe('MERGEABLE', ENTERPRISE_ROLLUP), {
      mode: 'unknown',
      cause: 'gh auth login',
    })
    expect(out.status).toBe('unknown')
    expect(out.reason).toContain('required checks for the base branch could not be read')
    expect(out.reason).toContain('gh auth login')
  })

  test('NO REPO-SPECIFIC JOB NAME SURVIVES IN THE WORKFLOW SOURCE', () => {
    // The defect itself, pinned: this repo's job names in a file that runs against
    // several repositories. They live in THIS file now, as fixture data.
    expect(SRC).not.toContain('REVIEW_REQUIRED_CHECKS')
    expect(SRC).not.toMatch(/'test',\s*'lint',\s*'typecheck'/)
  })
})

describe('classifyRequiredChecksProbe — five reads, one answer, judged in code', () => {
  test('branch protection contexts become the required set', () => {
    const { classifyRequiredChecksProbe } = loadReadiness()
    const out = classifyRequiredChecksProbe(
      requiredProbe({
        prot: '{"contexts":["check","frontend"]}',
        protExit: 0,
        rules: '[]',
        rulesExit: 0,
        runs: named(['check', 'frontend', 'sbom']),
      }),
    )
    expect(out).toEqual({
      mode: 'resolved',
      required: ['check', 'frontend'],
      appBound: [],
      produced: ['check', 'frontend', 'sbom'],
    })
  })

  test('a 404 on protection is an ANSWER — the ruleset still speaks', () => {
    // The measured sibling-repository shape: the protection endpoint 404s, so a
    // ruleset (a different GitHub feature) is the only thing that can require a name.
    //
    // THE BRANCH PAYLOAD IS STATED, AND IT IS THE RULESET-GOVERNED ONE. This test used
    // to take the fixture default (`protected:false`) while asserting that a NON-EMPTY
    // ruleset speaks — a combination GitHub cannot emit, because a branch a ruleset
    // governs reports `protected:true`. The test passed on a world that does not exist,
    // which is the same defect class this PR exists to fix, one level up.
    const { classifyRequiredChecksProbe } = loadReadiness()
    const out = classifyRequiredChecksProbe(
      requiredProbe({
        prot: NOT_FOUND,
        protExit: 1,
        branch: RULESET_GOVERNED_BRANCH_MEASURED,
        rules: '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"review-gate"}]}}]',
        rulesExit: 0,
        runs: named(['review-gate']),
      }),
    )
    expect(out.mode).toBe('resolved')
    expect(out.required).toEqual(['review-gate'])
  })

  test('the fixture builder REFUSES a branch payload that contradicts its own rulesets', () => {
    // The guard that keeps the test above honest. A ruleset requiring a status check and
    // a branch reporting `protected:false` describe two different repositories, and the
    // flagship test asserted exactly that pairing until this round.
    expect(() =>
      requiredProbe({
        prot: NOT_FOUND,
        protExit: 1,
        branch: '{"protected":false}',
        rules: '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"review-gate"}]}}]',
        rulesExit: 0,
      }),
    ).toThrow(/impossible fixture/)
    // …and the DEFAULT branch payload is the same impossible claim when the protection
    // endpoint 404s, so omitting it cannot smuggle the combination back in.
    expect(() =>
      requiredProbe({
        prot: NOT_FOUND,
        protExit: 1,
        rules: '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"review-gate"}]}}]',
        rulesExit: 0,
      }),
    ).toThrow(/impossible fixture/)
    // THE CONTROLS — proving the guard is discriminating rather than always-on.
    // A branch a ruleset governs, which is what GitHub actually emits: allowed.
    expect(() =>
      requiredProbe({
        prot: NOT_FOUND,
        protExit: 1,
        branch: RULESET_GOVERNED_BRANCH_MEASURED,
        rules: '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"review-gate"}]}}]',
        rulesExit: 0,
      }),
    ).not.toThrow()
    // A genuinely unprotected branch with NO ruleset: `protected:false` is the truth.
    expect(() => requiredProbe({ prot: NOT_FOUND, protExit: 1, rules: '[]', rulesExit: 0 })).not.toThrow()
    // A READABLE protection endpoint: the branch section is inert, so it is not pinned.
    expect(() =>
      requiredProbe({
        prot: '{"contexts":["check"]}',
        protExit: 0,
        rules: '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"frontend"}]}}]',
        rulesExit: 0,
      }),
    ).not.toThrow()
  })

  // WAS: '404 protection + no rulesets is a definitively UNPROTECTED base'.
  //
  // That test asserted the defect. It fed a bare 404 with NOTHING establishing whether
  // the credential was even allowed to ask, and required the classifier to answer
  // `required: []` — the permissive all-green rule. It is the reason the bug shipped:
  // the behaviour was pinned, so nothing downstream could ever notice it.
  //
  // The 404 is genuinely ambiguous, so the replacement asserts the DECISION under each
  // reading rather than the permissive one under both.
  test('404 + PROOF the branch is unprotected is a definitively UNPROTECTED base', () => {
    const { classifyRequiredChecksProbe } = loadReadiness()
    // `branches/{b}` says `protected:false`, which plain pull access can read. THAT is
    // what makes the 404 an answer.
    const out = classifyRequiredChecksProbe(
      requiredProbe({
        prot: NOT_FOUND,
        protExit: 1,
        branch: '{"protected":false}',
        rules: '[]',
        rulesExit: 0,
        runs: named(['check']),
      }),
    )
    expect(out).toEqual({ mode: 'resolved', required: [], appBound: [], produced: ['check'] })
  })

  test('HEADLINE: the REAL ruleset-governed branch resolves — protected:true, protection.enabled:false, rules speak', () => {
    // THE FAIL-SHUT THE FIRST FIX SHIPPED. This is the measured state of the base branch
    // this gate runs against, read with a credential holding no admin role: protection
    // 404s, `protected` is TRUE because a ruleset applies, and the ruleset requires
    // `test`. Reading `protected` alone left this `unknown`, so the gate deferred EVERY
    // review round on the repository trident builds — a gate that never runs.
    //
    // `protection.enabled:false` is the field that settles it, and the same non-admin
    // credential gets it back: no CLASSIC protection exists, so the 404 was GitHub
    // answering rather than refusing, and the ruleset half is already covered below.
    const { classifyRequiredChecksProbe, classifyReviewReadiness } = loadReadiness()
    const cfg = classifyRequiredChecksProbe(
      requiredProbe({
        prot: NOT_FOUND,
        protExit: 1,
        branch: RULESET_GOVERNED_BRANCH,
        rules: '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"test"}]}}]',
        rulesExit: 0,
        runs: named(['test', 'CodeQL']),
      }),
    )
    expect(cfg).toEqual({ mode: 'resolved', required: ['test'], appBound: [], produced: ['test', 'CodeQL'] })
    // …and the round it unblocks: a green `test` reaches review instead of deferring.
    expect(
      classifyReviewReadiness(readinessProbe('MERGEABLE', [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }]), cfg)
        .status,
    ).toBe('passed')
  })

  test('MUTANT: reading only `protected` re-breaks the ruleset-governed branch', () => {
    // The exact regression, re-introduced: drop the `protection.enabled` half of the
    // proof and the primary repository goes back to deferring every round.
    const mutant = SRC.replace(
      'branchObj !== null && (branchObj.protected === false || branchObj.protectionEnabled === false)',
      'branchObj !== null && branchObj.protected === false',
    )
    expect(mutant).not.toBe(SRC) // positive control: the replacement matched
    const out = loadReadiness(mutant).classifyRequiredChecksProbe(
      requiredProbe({
        prot: NOT_FOUND,
        protExit: 1,
        branch: RULESET_GOVERNED_BRANCH,
        rules: '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"test"}]}}]',
        rulesExit: 0,
        runs: named(['test']),
      }),
    )
    expect(out.mode).toBe('unknown')
  })

  test('HEADLINE: an ADMIN ROLE IS NOT PROOF — the repo-permissions read is gone entirely', () => {
    // The fail-OPEN half of the same predicate. `permissions.admin` comes from
    // `GET /repos`, which needs only Metadata-read, and it describes the caller's
    // repository ROLE — not the token's scopes. A fine-grained token can hold the admin
    // role through its user and still lack Administration-read, so its 404 means "may
    // not ask" while `admin:true` was calling it "there is none" and resolving
    // `required: []`: the permissive all-green rule on a genuinely protected base.
    //
    // Pinned at the source, because the fix is a DELETION and only the source can show
    // that the field is no longer consulted or even requested.
    // The jq PATH, not the bare words — the comment explaining why the field is gone
    // has to be allowed to name it, or the pin forbids documenting its own reason.
    expect(SRC).not.toContain('.permissions.admin')
    expect(SRC).not.toContain('permObj')
    expect(SRC).not.toContain('___PERM_EXIT')
    // And the behaviour: classic protection is really on, so no admin claim can make
    // this resolve. The probe no longer emits a PERM section at all.
    const { classifyRequiredChecksProbe } = loadReadiness()
    const out = classifyRequiredChecksProbe(
      requiredProbe({
        prot: NOT_FOUND,
        protExit: 1,
        branch: CLASSIC_PROTECTED_BRANCH,
        rules: '[]',
        rulesExit: 0,
        runs: named(['check']),
      }),
    )
    expect(out.mode).toBe('unknown')
  })

  test('HEADLINE: an AUTHORIZATION-shaped 404 is UNKNOWN — the gate defers, it does not go permissive', async () => {
    // The failure the old test pinned. A credential with PR + check scope and no
    // Administration-read gets a 404 from the protection endpoint on a branch that IS
    // protected, because GitHub answers 404 rather than 403 for a resource you may not
    // ask about. The branch read proves protection exists; nothing proves the token
    // could have read it. Answering `required: []` here downgrades a protected base to
    // the all-green rule and reports success on a review that never ran.
    const { classifyRequiredChecksProbe, classifyReviewReadiness, reviewWithPreconditions } = loadReadiness()
    const cfg = classifyRequiredChecksProbe(
      requiredProbe({
        prot: NOT_FOUND,
        protExit: 1,
        branch: CLASSIC_PROTECTED_BRANCH,
        rules: '[]',
        rulesExit: 0,
        runs: named(['check']),
      }),
    )
    expect(cfg.mode).toBe('unknown')
    expect(cfg.required).toBeUndefined()
    expect(cfg.cause).toContain('Administration-read')
    // …and the decision that follows: a fully green rollup does NOT reach a review seat.
    const readiness = classifyReviewReadiness(readinessProbe('MERGEABLE', ENTERPRISE_ROLLUP), cfg)
    expect(readiness.status).toBe('unknown')
    let spent = 0
    const out = await reviewWithPreconditions({
      probe: async () => readiness,
      spend: async () => { spent += 1 },
      wait: async () => {},
    })
    expect({ deferred: out.deferred, spent }).toEqual({ deferred: true, spent: 0 })
  })

  test('an UNREADABLE branch read leaves the 404 ambiguous, so it is UNKNOWN', () => {
    // No proof available — the disambiguating read itself failed. The honest answer is
    // "could not tell", never the permissive one.
    const { classifyRequiredChecksProbe } = loadReadiness()
    const out = classifyRequiredChecksProbe(
      requiredProbe({
        prot: NOT_FOUND,
        protExit: 1,
        branch: 'gh: server error (HTTP 502)',
        branchExit: 1,
        rules: '[]',
        rulesExit: 0,
      }),
    )
    expect(out.mode).toBe('unknown')
  })

  test('MUTANT: restoring "a 404 alone means unprotected" goes RED', () => {
    const out = mutate(SRC.replace('} else if (!unprotectedProven) {', '} else if (false) {')).classifyRequiredChecksProbe(
      requiredProbe({
        prot: NOT_FOUND,
        protExit: 1,
        branch: CLASSIC_PROTECTED_BRANCH,
        rules: '[]',
        rulesExit: 0,
      }),
    )
    // The guard above ("an AUTHORIZATION-shaped 404 is UNKNOWN") replayed against it:
    goesRed(() => expect(out.mode).toBe('unknown'))
    // …and what it answers instead: the permissive all-green rule on a protected base.
    expect({ mode: out.mode, required: out.required }).toEqual({ mode: 'resolved', required: [] })
  })

  test('a NON-404 read failure is unknown, and it quotes what the probe said', () => {
    // Unauthenticated is not "nothing is required" — that reading turns a protected
    // repo into an unprotected one on a transient credential fault.
    const { classifyRequiredChecksProbe } = loadReadiness()
    const out = classifyRequiredChecksProbe(
      requiredProbe({
        prot: 'gh: To get started with GitHub CLI, please run: gh auth login',
        protExit: 1,
        rules: '[]',
        rulesExit: 0,
      }),
    )
    expect(out.mode).toBe('unknown')
    expect(out.cause).toContain('gh auth login')
    // …and the same for the rules read.
    const rules = classifyRequiredChecksProbe(
      requiredProbe({ prot: NOT_FOUND, protExit: 1, rules: 'gh: server error (HTTP 500)', rulesExit: 1 }),
    )
    expect(rules.mode).toBe('unknown')
    expect(rules.cause).toContain('500')
  })

  test('an unreadable check-run list is `produced: null`, not an unknown', () => {
    const { classifyRequiredChecksProbe } = loadReadiness()
    const out = classifyRequiredChecksProbe(
      requiredProbe({
        prot: '{"contexts":["check"]}',
        protExit: 0,
        rules: '[]',
        rulesExit: 0,
        runs: 'gh: server error (HTTP 502)',
        runsExit: 1,
      }),
    )
    expect(out).toEqual({ mode: 'resolved', required: ['check'], appBound: [], produced: null })
  })

  test('a dead seat, a missing raw, and a shapeless probe are all unknown', () => {
    const { classifyRequiredChecksProbe } = loadReadiness()
    for (const p of [null, undefined, {}, { raw: 42, exit_code: 0 }]) {
      expect(classifyRequiredChecksProbe(p).mode).toBe('unknown')
    }
  })

  test('protection `checks[].context` and rulesets UNION, deduped', () => {
    const { classifyRequiredChecksProbe } = loadReadiness()
    const out = classifyRequiredChecksProbe(
      requiredProbe({
        prot: '{"contexts":["check"],"checks":[{"context":"check","app_id":1},{"context":"frontend","app_id":1}]}',
        protExit: 0,
        rules: '[{"type":"deletion"},{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"frontend"},{"context":"sbom"}]}}]',
        rulesExit: 0,
      }),
    )
    expect(out.required).toEqual(['check', 'frontend', 'sbom'])
  })

  test('`produced` is the UNION of check runs and classic commit statuses', () => {
    // Reading only `check-runs` is what made a status-context name look unproduced.
    const { classifyRequiredChecksProbe } = loadReadiness()
    const out = classifyRequiredChecksProbe(
      requiredProbe({
        prot: '{"contexts":["legacy-ci"]}',
        protExit: 0,
        rules: '[]',
        rulesExit: 0,
        runs: named(['check']),
        statuses: named(['legacy-ci', 'check']),
      }),
    )
    expect(out).toEqual({ mode: 'resolved', required: ['legacy-ci'], appBound: [], produced: ['check', 'legacy-ci'] })
  })

  test('FAIL-SAFE: an unreadable STATUS list nulls the whole union, it never half-answers', () => {
    // A partial union is the dangerous shape — authoritative-looking and missing exactly
    // the names the failed read would have supplied, which is a config-error on a name
    // that is present and green.
    const { classifyRequiredChecksProbe } = loadReadiness()
    const out = classifyRequiredChecksProbe(
      requiredProbe({
        prot: '{"contexts":["legacy-ci"]}',
        protExit: 0,
        rules: '[]',
        rulesExit: 0,
        runs: named(['check']),
        statuses: 'gh: server error (HTTP 502)',
        statusesExit: 1,
      }),
    )
    expect(out.produced).toBeNull()
  })

  test('A TRUNCATED produced LIST IS UNREADABLE, NOT SHORT', () => {
    // `per_page=100` with no pagination exits 0 and returns a complete-LOOKING array,
    // so a base head with more than 100 reported checks would silently drop names — and
    // a dropped name is indistinguishable from one no workflow emits, which is the one
    // reading that STOPS a build. GitHub's own `total_count` is what makes the two
    // distinguishable, so a count larger than the array nulls the union out.
    const { classifyRequiredChecksProbe } = loadReadiness()
    const truncated = classifyRequiredChecksProbe(
      requiredProbe({
        prot: '{"contexts":["late-check"]}',
        protExit: 0,
        rules: '[]',
        rulesExit: 0,
        runs: named(['check', 'frontend'], 137),
        statuses: named([]),
      }),
    )
    expect(truncated.produced).toBeNull()
    // The control: the SAME payload with a count that matches is trusted.
    expect(
      classifyRequiredChecksProbe(
        requiredProbe({
          prot: '{"contexts":["late-check"]}',
          protExit: 0,
          rules: '[]',
          rulesExit: 0,
          runs: named(['check', 'frontend']),
          statuses: named([]),
        }),
      ).produced,
    ).toEqual(['check', 'frontend'])
  })

  test('MUTANT: trusting a truncated list turns a real check into a config error', () => {
    // What the truncation blindness actually costs, end to end: `late-check` IS produced
    // here, it just fell off page 1 — and the mutant stops the build for it.
    const mutant = SRC.replace('return total > names.length ? null : names', 'return names')
    expect(mutant).not.toBe(SRC) // positive control: the replacement matched
    const loaded = loadReadiness(mutant)
    const cfg = loaded.classifyRequiredChecksProbe(
      requiredProbe({
        prot: '{"contexts":["late-check"]}',
        protExit: 0,
        rules: '[]',
        rulesExit: 0,
        runs: named(['check', 'frontend'], 137),
        statuses: named([]),
      }),
    )
    expect(cfg.produced).toEqual(['check', 'frontend'])
    expect(
      loaded.classifyReviewReadiness(
        readinessProbe('MERGEABLE', ENTERPRISE_ROLLUP),
        cfg,
        loaded.REVIEW_READINESS_CONFIG_GRACE_MS,
      ).status,
    ).toBe('config-error')
  })

  test('the probe ASKS for total_count on both produced-list reads', () => {
    // The classifier can only detect truncation if the probe requested the count — a
    // jq that returns a bare array makes the check silently inert.
    expect(SRC).toContain('{n:.total_count,names:[.check_runs[].name]}')
    expect(SRC).toContain('{n:.total_count,names:[.statuses[].context]}')
  })

  test('MUTANT: dropping commit statuses from `produced` goes RED', () => {
    const mutant = SRC.replace("const statusNames = listFrom(statusesText, 'STATUSES')", 'const statusNames = []')
    expect(mutant).not.toBe(SRC) // positive control: the replacement matched
    // The mutant's ACTUAL answer — `legacy-ci` vanishes from `produced`, which is what
    // then became `not produced by any workflow in this repository`.
    expect(
      loadReadiness(mutant).classifyRequiredChecksProbe(
        requiredProbe({
          prot: '{"contexts":["legacy-ci"]}',
          protExit: 0,
          rules: '[]',
          rulesExit: 0,
          runs: named(['check']),
          statuses: named(['legacy-ci']),
        }),
      ).produced,
    ).toEqual(['check'])
  })
})

/**
 * BOTH ROLLUP SHAPES, OR A CLASSIC-STATUS REPO CAN NEVER SATISFY ITS OWN CHECKS.
 *
 * `statusCheckRollup` returns CheckRun rows (`name`/`status`/`conclusion`) for GitHub
 * Actions jobs and StatusContext rows (`context`/`state`) for classic commit statuses,
 * and one rollup can hold both — including two rows carrying the SAME name. The gate
 * read only the CheckRun fields, so a StatusContext had no name at all: a required
 * check named `legacy-ci`, present and SUCCESS, came back as
 * `config-error: required check legacy-ci is not produced by any workflow in this
 * repository`. Not a delay, not a wait — a permanent refusal of a legitimate setup.
 */
const statusRow = (context: string, state: string) => ({ __typename: 'StatusContext', context, state })
const checkRow = (name: string, status: string, conclusion: string | null) => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
})

describe('statusCheckRollup carries TWO row shapes and both are judged', () => {
  test('HEADLINE: a required check present only as a classic commit status PASSES', () => {
    const { classifyReviewReadiness, REVIEW_READINESS_CONFIG_GRACE_MS } = loadReadiness()
    const cfg = requiredCfg(['legacy-ci'], ['legacy-ci'])
    // Well past the settle window, so nothing but the shape can explain a failure here.
    const out = classifyReviewReadiness(
      readinessProbe('MERGEABLE', [statusRow('legacy-ci', 'SUCCESS')] as never),
      cfg,
      REVIEW_READINESS_CONFIG_GRACE_MS,
    )
    expect(out.status).toBe('passed')
    expect(out.reason).toBe('')
  })

  test('a StatusContext is PENDING, FAILURE and ERROR too — state is the whole answer', () => {
    const { classifyReviewReadiness } = loadReadiness()
    const one = (state: string) =>
      classifyReviewReadiness(
        readinessProbe('MERGEABLE', [statusRow('legacy-ci', state)] as never),
        requiredCfg(['legacy-ci'], ['legacy-ci']),
      )
    expect(one('PENDING').status).toBe('pending')
    expect(one('EXPECTED').status).toBe('pending')
    expect(one('FAILURE').status).toBe('failed')
    expect(one('FAILURE').failed).toEqual(['legacy-ci'])
    expect(one('ERROR').status).toBe('failed')
  })

  test('MIXED, SAME NAME: a green CheckRun does not cover a failing StatusContext', () => {
    // Both rows are kept and BOTH must be green. A rollup that disagrees with itself is
    // not evidence the check passed, and last-row-wins would have made the answer
    // depend on GitHub's ordering.
    const { classifyReviewReadiness } = loadReadiness()
    const cfg = requiredCfg(['ci'], ['ci'])
    const bothGreen = classifyReviewReadiness(
      readinessProbe('MERGEABLE', [checkRow('ci', 'COMPLETED', 'SUCCESS'), statusRow('ci', 'SUCCESS')] as never),
      cfg,
    )
    expect(bothGreen.status).toBe('passed')
    const statusFailing = classifyReviewReadiness(
      readinessProbe('MERGEABLE', [checkRow('ci', 'COMPLETED', 'SUCCESS'), statusRow('ci', 'FAILURE')] as never),
      cfg,
    )
    expect(statusFailing.status).toBe('failed')
    expect(statusFailing.failed).toEqual(['ci'])
    // …and in the other order, so the answer cannot depend on which row arrived last.
    expect(
      classifyReviewReadiness(
        readinessProbe('MERGEABLE', [statusRow('ci', 'FAILURE'), checkRow('ci', 'COMPLETED', 'SUCCESS')] as never),
        cfg,
      ).status,
    ).toBe('failed')
    // A still-pending status under a finished check run is still PENDING.
    expect(
      classifyReviewReadiness(
        readinessProbe('MERGEABLE', [checkRow('ci', 'COMPLETED', 'SUCCESS'), statusRow('ci', 'PENDING')] as never),
        cfg,
      ).status,
    ).toBe('pending')
  })

  test('MIXED, SAME NAME: a SKIPPED check run does not hide a green status', () => {
    // SKIPPED means "did not run", so it is excluded rather than judged — the name DID
    // run, under the other shape.
    const { classifyReviewReadiness } = loadReadiness()
    expect(
      classifyReviewReadiness(
        readinessProbe('MERGEABLE', [checkRow('ci', 'COMPLETED', 'SKIPPED'), statusRow('ci', 'SUCCESS')] as never),
        requiredCfg(['ci'], ['ci']),
      ).status,
    ).toBe('passed')
  })

  test('the UNPROTECTED rule counts status contexts as checks that ran', () => {
    const { classifyReviewReadiness } = loadReadiness()
    const un = (rows: unknown[]) => classifyReviewReadiness(readinessProbe('MERGEABLE', rows as never), requiredCfg([], null))
    expect(un([statusRow('legacy-ci', 'SUCCESS')]).status).toBe('passed')
    expect(un([statusRow('legacy-ci', 'PENDING')]).status).toBe('pending')
    const failed = un([statusRow('legacy-ci', 'SUCCESS'), statusRow('deploy', 'FAILURE')])
    expect(failed.status).toBe('failed')
    expect(failed.failed).toEqual(['deploy'])
  })

  test('a row with neither shape is ignored, not counted as a nameless check', () => {
    const { classifyReviewReadiness } = loadReadiness()
    expect(
      classifyReviewReadiness(readinessProbe('MERGEABLE', [{ foo: 'bar' }] as never), requiredCfg([], null)).status,
    ).toBe('absent')
  })

  test('MUTANT: reading only the CheckRun fields goes RED on the classic-status repo', () => {
    const mutant = SRC.replace(
      '  const name =\n' +
        "    typeof row.name === 'string' && row.name !== ''\n" +
        '      ? row.name\n' +
        "      : typeof row.context === 'string' && row.context !== ''\n" +
        '        ? row.context\n' +
        "        : ''",
      "  const name = typeof row.name === 'string' ? row.name : ''",
    )
    const { REVIEW_READINESS_CONFIG_GRACE_MS } = loadReadiness()
    const mutated = mutate(mutant)
    const out = mutated.classifyReviewReadiness(
      readinessProbe('MERGEABLE', [statusRow('legacy-ci', 'SUCCESS')] as never),
      requiredCfg(['legacy-ci'], ['legacy-ci']),
      REVIEW_READINESS_CONFIG_GRACE_MS,
    )
    // The guard above ("a required check present ONLY as a classic status is satisfied")
    // replayed against the mutant: the green status is invisible to it.
    goesRed(() => expect(out.status).toBe('passed'))
    expect(out.status).toBe('absent') // …what it answers instead
    // …and with `produced` from the check-runs-only read, it is the reported repro.
    //
    // THE MUTANT MAKES EVERY ROW NAMELESS, so the rollup this classifier can see is
    // EMPTY — and an empty rollup is exactly the state the config-error fast-fail must
    // refuse. It used to answer with the configuration sentence (`every other check on
    // this PR has finished`) over zero checks, which was the vacuous-`rollupSettled`
    // bug asserted as though it were the specification. The honest answer is that the
    // check has not run, and the reason no longer claims a settled rollup it cannot see.
    expect(
      mutated.classifyReviewReadiness(
        readinessProbe('MERGEABLE', [statusRow('legacy-ci', 'SUCCESS')] as never),
        requiredCfg(['legacy-ci'], ['check']),
        REVIEW_READINESS_CONFIG_GRACE_MS,
      ).reason,
    ).toBe('required check legacy-ci has not run')
  })
})

/**
 * ONE BASE-HEAD SNAPSHOT IS EVIDENCE, NOT PROOF.
 *
 * `produced` is the names GitHub has reported on the BASE BRANCH HEAD. A
 * `pull_request`-only job, or one gated on a path/branch/event filter, is legitimately
 * absent from it — and on a PR's first poll nothing has appeared yet at all. Firing the
 * config error on that snapshot immediately turns a correct repository into a
 * permanent configuration fault seconds after the push.
 *
 * The absence must OUTLAST the settle window before it means "never". The fast-fail the
 * original change added is preserved: a name genuinely no workflow emits still stops
 * well before the full budget.
 */
describe('“has not appeared YET” is not “no workflow produces it”', () => {
  test('HEADLINE: a pull_request-only check absent from the base head WAITS on the first poll', async () => {
    const { classifyReviewReadiness, reviewWithPreconditions, REVIEW_READINESS_RETRY_MS } = loadReadiness()
    // `pr-only` runs on `pull_request`, so it has never been reported on the base head.
    const cfg = requiredCfg(['pr-only'], ['check', 'frontend'])
    const first = classifyReviewReadiness(readinessProbe('MERGEABLE', ENTERPRISE_ROLLUP), cfg, 0)
    expect(first.status).toBe('absent')
    expect(first.reason).toBe('required check pr-only has not run')
    // …and the gate keeps polling: it waits for the check, and reviews it when it lands.
    let probes = 0
    let spent = 0
    const out = await reviewWithPreconditions({
      probe: async (attempt: number) => {
        probes += 1
        const rows = attempt < 3 ? ENTERPRISE_ROLLUP : [...ENTERPRISE_ROLLUP, checkRow('pr-only', 'COMPLETED', 'SUCCESS')]
        return classifyReviewReadiness(readinessProbe('MERGEABLE', rows as never), cfg, (attempt - 1) * REVIEW_READINESS_RETRY_MS)
      },
      spend: async () => { spent += 1; return 'reviewed' },
      wait: async () => {},
    })
    expect({ probes, spent, deferred: out.deferred, value: out.value }).toEqual({
      probes: 3,
      spent: 1,
      deferred: false,
      value: 'reviewed',
    })
    expect(out.readiness.status).toBe('passed')
  })

  test('the SAME absence past the settle window IS the config error', () => {
    const { classifyReviewReadiness, REVIEW_READINESS_CONFIG_GRACE_MS, REVIEW_READINESS_RETRY_MS } = loadReadiness()
    const cfg = requiredCfg(['pr-only'], ['check', 'frontend'])
    const at = (elapsed: number) => classifyReviewReadiness(readinessProbe('MERGEABLE', ENTERPRISE_ROLLUP), cfg, elapsed).status
    // The boundary from both sides — one retry short of the window still waits.
    expect(at(REVIEW_READINESS_CONFIG_GRACE_MS - REVIEW_READINESS_RETRY_MS)).toBe('absent')
    expect(at(REVIEW_READINESS_CONFIG_GRACE_MS)).toBe('config-error')
  })

  test('the settle window is longer than the MEASURED time for a check to appear', () => {
    // 328 s on this repository's PR #275 — the number the budget comment is built on. A
    // grace shorter than that converts a routine queue delay into a config fault.
    const { REVIEW_READINESS_CONFIG_GRACE_MS } = loadReadiness()
    expect(REVIEW_READINESS_CONFIG_GRACE_MS).toBeGreaterThan(328000)
  })

  test('the settle window is DERIVED from the budget, not a second tuned constant', () => {
    // Two hand-written durations beside each other is how the budget comment came to
    // argue for a 3x margin while the number next to it was 1.5x. As a ratio it moves
    // WITH the budget and the fast-fail stays reachable by construction.
    const { REVIEW_READINESS_CONFIG_GRACE_MS, REVIEW_READINESS_BUDGET_MS, REVIEW_READINESS_RETRY_MS } = loadReadiness()
    expect(REVIEW_READINESS_CONFIG_GRACE_MS).toBe(
      REVIEW_READINESS_RETRY_MS * Math.ceil((REVIEW_READINESS_BUDGET_MS * 2) / 3 / REVIEW_READINESS_RETRY_MS),
    )
    expect(SRC).not.toMatch(/const REVIEW_READINESS_CONFIG_GRACE_MS = \d+$/m)
    // …and it is a real increase over the 8 minutes that shipped: ~1.8x the measurement.
    expect(REVIEW_READINESS_CONFIG_GRACE_MS).toBeGreaterThan(480000)
  })

  test('the settle window is a WHOLE NUMBER OF RETRIES, at any budget', () => {
    // The gate cannot spend a fraction of a sleep, so a window that is not a multiple of
    // the retry is crossed LATE — the owner is told "waited at least 10 minutes" while
    // the loop actually slept longer, and the attempt arithmetic below stops being an
    // integer. Measured (Argus r2) at a mutant budget of 600000 ms: 14.33 probes
    // asserted against 15 actually spent, so the guard was only true at one budget.
    const { REVIEW_READINESS_CONFIG_GRACE_MS, REVIEW_READINESS_RETRY_MS } = loadReadiness()
    expect(REVIEW_READINESS_CONFIG_GRACE_MS % REVIEW_READINESS_RETRY_MS).toBe(0)
    // The property under a DIFFERENT budget, which is the half the old guard could not
    // see: re-derive the constant the way the source does and it is still integral.
    for (const budget of [600000, 900000, 450000, 1234567]) {
      const grace = REVIEW_READINESS_RETRY_MS * Math.ceil((budget * 2) / 3 / REVIEW_READINESS_RETRY_MS)
      expect(grace % REVIEW_READINESS_RETRY_MS).toBe(0)
      expect(grace).toBeLessThan(budget)
      expect(grace).toBeGreaterThanOrEqual((budget * 2) / 3)
    }
  })

  test('MUTANT: an un-snapped settle window goes RED on the integral-attempt guard', () => {
    const mutant = SRC.replace(
      'const REVIEW_READINESS_CONFIG_GRACE_MS =\n  REVIEW_READINESS_RETRY_MS * Math.ceil((REVIEW_READINESS_BUDGET_MS * 2) / 3 / REVIEW_READINESS_RETRY_MS)',
      'const REVIEW_READINESS_CONFIG_GRACE_MS = Math.round((REVIEW_READINESS_BUDGET_MS * 2) / 3) + 1',
    )
    const m = mutate(mutant)
    // The guard above, replayed: the window is no longer a whole number of retries.
    goesRed(() => expect(m.REVIEW_READINESS_CONFIG_GRACE_MS % m.REVIEW_READINESS_RETRY_MS).toBe(0))
    expect(m.REVIEW_READINESS_CONFIG_GRACE_MS % m.REVIEW_READINESS_RETRY_MS).toBe(1)
  })

  test('the settle window is STRICTLY below the budget, or the fast-fail is unreachable', () => {
    // Fails CLOSED and invisibly if this ever inverts: the config-error branch stops
    // firing, the gate burns the whole budget on a fault it can already name, and the
    // symptom looks like patience.
    const { REVIEW_READINESS_CONFIG_GRACE_MS, REVIEW_READINESS_BUDGET_MS, readinessGraceLabel } = loadReadiness()
    expect(REVIEW_READINESS_CONFIG_GRACE_MS).toBeLessThan(REVIEW_READINESS_BUDGET_MS)
    // The sentence the owner reads is derived from the same constant the loop spends.
    expect(readinessGraceLabel()).toBe('10 minutes')
    expect(SRC).toContain('The gate waited at least ${readinessGraceLabel()} first')
  })

  test('MUTANT: firing the config error on the first probe goes RED', () => {
    const answer = mutate(
      SRC.replace('elapsedMs >= REVIEW_READINESS_CONFIG_GRACE_MS', 'elapsedMs >= 0'),
    ).classifyReviewReadiness(
      readinessProbe('MERGEABLE', ENTERPRISE_ROLLUP),
      requiredCfg(['pr-only'], ['check', 'frontend']),
      0,
    ).status
    // The HEADLINE guard above ("a pull_request-only check WAITS on the first poll"):
    goesRed(() => expect(answer).toBe('absent'))
    // …what it answers instead: a permanent configuration fault, declared before the
    // job could possibly have appeared.
    expect(answer).toBe('config-error')
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
    expect(classifyReviewReadiness(readinessProbe('CONFLICTING', completedChecks('SUCCESS')), THIS_REPO()).reason).toBe(
      'PR is conflicting with base',
    )
    expect(classifyReviewReadiness(readinessProbe('UNKNOWN', completedChecks('SUCCESS')), THIS_REPO()).reason).toBe(
      'PR mergeability is still being calculated',
    )
    expect(classifyReviewReadiness(readinessProbe('MERGEABLE', completedChecks('SUCCESS')), THIS_REPO()).status).toBe('passed')
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

/**
 * THE BRANCH PAYLOAD ANSWERS THE QUESTION THE 404 REFUSED.
 *
 * Round 1 read a 404 from `branches/{b}/protection/required_status_checks` as proof the
 * base was unprotected, which is the gate FAILING OPEN. Round 2 replaced that with a
 * `protected`/`protection.enabled` probe and, when neither field cleared the branch,
 * `mode:'unknown'` — which is the gate FAILING CLOSED, and on the far more common
 * configuration: a genuinely classic-protected base defers EVERY round, forever, with
 * zero rounds spent. Both report a review that never happened.
 *
 * MEASURED THIS SESSION with a credential holding no admin role. All three 404 on the
 * protection subresource; all three answer the branch read:
 *
 *   this repo        @ main → {"protected":true,"protectionEnabled":false,"contexts":[]}
 *   rails/rails      @ main → {"protected":true,"protectionEnabled":true, "contexts":[]}
 *   microsoft/vscode @ main → {"protected":true,"protectionEnabled":true, "contexts":[23]}
 *
 * The last two are the deadlock, and the third carries the exact list the deferral was
 * throwing away — including `{"app_id":15368,"context":"Linux / CLI"}`, which is the
 * producer binding the classifier now keeps.
 */
describe('a 404 is not proof, and it is not a dead end either', () => {
  /** `microsoft/vscode` @ main, projected as the probe asks for it. */
  const VSCODE_BRANCH = JSON.stringify({
    protected: true,
    protectionEnabled: true,
    contexts: ['Compile & Hygiene', 'Linux / CLI', 'license/cla'],
    checks: [
      { context: 'Compile & Hygiene', app_id: 15368 },
      { context: 'Linux / CLI', app_id: 15368 },
      { context: 'license/cla', app_id: 95686 },
    ],
  })
  /** `rails/rails` @ main: classic protection on, requiring no status contexts. */
  const RAILS_BRANCH = JSON.stringify({ protected: true, protectionEnabled: true, contexts: [], checks: [] })

  test('HEADLINE: a classic-protected base RESOLVES from the branch payload instead of deferring forever', async () => {
    // Against round 2 this is `mode:'unknown'` → status `unknown` → REQUEST_CHANGES
    // "REVIEW DEFERRED" with zero rounds spent, every round, on 2 of the 3 measured
    // repositories. The required list was in a response the probe already made.
    const { classifyRequiredChecksProbe, classifyReviewReadiness, reviewWithPreconditions } = loadReadiness()
    const cfg = classifyRequiredChecksProbe(
      requiredProbe({
        prot: NOT_FOUND,
        protExit: 1,
        branch: VSCODE_BRANCH,
        rules: '[]',
        rulesExit: 0,
        runs: named(['Compile & Hygiene', 'Linux / CLI', 'license/cla']),
      }),
    )
    expect(cfg.mode).toBe('resolved')
    expect(cfg.required).toEqual(['Compile & Hygiene', 'Linux / CLI', 'license/cla'])
    // …and the round it unblocks: a green rollup reaches a review seat.
    const rows = [
      checkRow('Compile & Hygiene', 'COMPLETED', 'SUCCESS'),
      checkRow('Linux / CLI', 'COMPLETED', 'SUCCESS'),
      checkRow('license/cla', 'COMPLETED', 'SUCCESS'),
    ]
    let spent = 0
    const out = await reviewWithPreconditions({
      probe: async () => classifyReviewReadiness(readinessProbe('MERGEABLE', rows as never), cfg),
      spend: async () => { spent += 1; return 'reviewed' },
      wait: async () => {},
    })
    expect({ deferred: out.deferred, spent, status: out.readiness.status }).toEqual({
      deferred: false,
      spent: 1,
      status: 'passed',
    })
  })

  test('the LIVE projection of this gate’s own base branch still resolves', () => {
    // The fixture the probe actually receives now that it asks for the contexts:
    // `{"protected":true,"protectionEnabled":false,"contexts":[],"checks":[]}`, measured
    // this session. Both rungs agree here, and the ruleset supplies the required name —
    // so the field the probe added cannot change the answer on the primary repository.
    const { classifyRequiredChecksProbe } = loadReadiness()
    const out = classifyRequiredChecksProbe(
      requiredProbe({
        prot: NOT_FOUND,
        protExit: 1,
        branch: RULESET_GOVERNED_BRANCH_MEASURED,
        rules: '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"test","integration_id":15368}]}}]',
        rulesExit: 0,
        runs: named(['test']),
      }),
    )
    expect(out).toEqual({ mode: 'resolved', required: ['test'], appBound: ['test'], produced: ['test'] })
  })

  test('classic protection requiring NO contexts is an answer, not a silence', () => {
    // `rails/rails`: protection is on and its required-context list is empty. An empty
    // ARRAY resolves (to nothing required); it is the absent KEY that means "not told".
    const { classifyRequiredChecksProbe } = loadReadiness()
    const out = classifyRequiredChecksProbe(
      requiredProbe({ prot: NOT_FOUND, protExit: 1, branch: RAILS_BRANCH, rules: '[]', rulesExit: 0, runs: named(['ci']) }),
    )
    expect(out).toEqual({ mode: 'resolved', required: [], appBound: [], produced: ['ci'] })
  })

  test('…and the ambiguity is still UNKNOWN when the payload carries no contexts field', () => {
    // The fail-open this whole change exists to prevent is unchanged: protection says
    // 404, the branch says it IS classically protected, and nothing tells us what it
    // requires. That is not an unprotected base and it never becomes one.
    const { classifyRequiredChecksProbe } = loadReadiness()
    const out = classifyRequiredChecksProbe(
      requiredProbe({ prot: NOT_FOUND, protExit: 1, branch: CLASSIC_PROTECTED_BRANCH, rules: '[]', rulesExit: 0 }),
    )
    expect(out.mode).toBe('unknown')
    expect(out.cause).toContain('required_status_checks.contexts')
    expect(out.cause).toContain('Administration-read')
  })

  test('the PROBE actually asks for the field the classifier reads', () => {
    // The wiring half. A classifier that reads `contexts` from a projection that never
    // requested it resolves nothing and quietly reverts to the deadlock.
    expect(SRC).toContain('contexts:(.protection.required_status_checks.contexts // null)')
    expect(SRC).toContain('map({context:.context,app_id:.app_id})')
  })

  test('MUTANT: discarding the branch payload contexts goes RED', () => {
    const out = mutate(
      SRC.replace('    if (branchContexts !== null) {', '    if (false) {'),
    ).classifyRequiredChecksProbe(
      requiredProbe({ prot: NOT_FOUND, protExit: 1, branch: VSCODE_BRANCH, rules: '[]', rulesExit: 0 }),
    )
    // The HEADLINE guard replayed: the classic-protected base resolves.
    goesRed(() => expect(out.mode).toBe('resolved'))
    expect(out.mode).toBe('unknown') // …the round-2 deadlock, restored
  })
})

/**
 * A REQUIRED CHECK CAN NAME ITS PRODUCER, AND THE NAME ALONE DOES NOT.
 *
 * Branch protection and rulesets both bind a required check to one App:
 * `{"context":"test","integration_id":15368}` on this repository's own ruleset,
 * `{"app_id":15368,"context":"Linux / CLI"}` on `microsoft/vscode`'s branch payload
 * (both measured this session). Keying satisfaction on the context alone let anything
 * carrying the name satisfy it.
 *
 * WHAT THIS CAN AND CANNOT PROVE, stated rather than implied. `gh pr view --json
 * statusCheckRollup` returns no app or check-suite identity for a CheckRun (measured:
 * `{__typename,name,status,conclusion,startedAt,completedAt,detailsUrl,workflowName}`),
 * so the WRONG APP with the RIGHT NAME still passes. What the rollup does carry is the
 * row SHAPE, and a commit status is not a check run — so the one wrong producer this
 * data can identify is now refused.
 */
describe('an app-bound required check is not satisfied by a commit status', () => {
  const boundProbe = (rules: string) =>
    requiredProbe({ prot: NOT_FOUND, protExit: 1, branch: RULESET_GOVERNED_BRANCH, rules, rulesExit: 0, runs: named(['ci']) })
  const BOUND = { mode: 'resolved', required: ['ci'], appBound: ['ci'], produced: ['ci'] }

  test('the binding survives from all three sources it can arrive in', () => {
    const { classifyRequiredChecksProbe } = loadReadiness()
    // 1. the ruleset payload, which spells it `integration_id`
    expect(
      classifyRequiredChecksProbe(
        boundProbe(
          '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"ci","integration_id":15368}]}}]',
        ),
      ).appBound,
    ).toEqual(['ci'])
    // 2. the protection subresource, which spells it `app_id`
    expect(
      classifyRequiredChecksProbe(
        requiredProbe({
          prot: '{"contexts":["ci"],"checks":[{"context":"ci","app_id":15368}]}',
          protExit: 0,
          rules: '[]',
          rulesExit: 0,
        }),
      ).appBound,
    ).toEqual(['ci'])
    // 3. the branch payload, on the 404 path
    expect(
      classifyRequiredChecksProbe(
        requiredProbe({
          prot: NOT_FOUND,
          protExit: 1,
          branch: JSON.stringify({
            protected: true,
            protectionEnabled: true,
            contexts: ['ci'],
            checks: [{ context: 'ci', app_id: 15368 }],
          }),
          rules: '[]',
          rulesExit: 0,
        }),
      ).appBound,
    ).toEqual(['ci'])
    // …and a requirement with NO producer named stays unbound.
    expect(
      classifyRequiredChecksProbe(
        boundProbe('[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"ci"}]}}]'),
      ).appBound,
    ).toEqual([])
  })

  test('HEADLINE: a same-name commit status does NOT satisfy an app-bound requirement', () => {
    // The reviewer's repro: protection requires {context:'ci', app_id:123}; the rollup
    // is all-green because a DIFFERENT producer posted a status named `ci`. Read by name
    // alone the base branch's own condition reads as met, and review proceeds.
    const { classifyReviewReadiness } = loadReadiness()
    const out = classifyReviewReadiness(readinessProbe('MERGEABLE', [statusRow('ci', 'SUCCESS')] as never), BOUND)
    expect(out.status).toBe('absent')
    expect(out.reason).toContain('only a commit status reported it')
    // The controls, both directions:
    // 1. the SAME rollup where the requirement is not app-bound still passes — the
    //    classic-status repair this PR also carries is not undone by the binding.
    expect(
      classifyReviewReadiness(readinessProbe('MERGEABLE', [statusRow('ci', 'SUCCESS')] as never), requiredCfg(['ci'], ['ci']))
        .status,
    ).toBe('passed')
    // 2. the bound requirement IS satisfied by a check run of that name.
    expect(
      classifyReviewReadiness(readinessProbe('MERGEABLE', [checkRow('ci', 'COMPLETED', 'SUCCESS')] as never), BOUND).status,
    ).toBe('passed')
  })

  test('a check run beside the status answers for it, in both directions', () => {
    const { classifyReviewReadiness } = loadReadiness()
    // The status is green and the check run is not: the bound requirement FAILS, because
    // the row that answers for it is the check run.
    const failed = classifyReviewReadiness(
      readinessProbe('MERGEABLE', [statusRow('ci', 'SUCCESS'), checkRow('ci', 'COMPLETED', 'FAILURE')] as never),
      BOUND,
    )
    expect({ status: failed.status, failed: failed.failed }).toEqual({ status: 'failed', failed: ['ci'] })
    // …and a red STATUS cannot fail a requirement it was never allowed to satisfy.
    expect(
      classifyReviewReadiness(
        readinessProbe('MERGEABLE', [statusRow('ci', 'FAILURE'), checkRow('ci', 'COMPLETED', 'SUCCESS')] as never),
        BOUND,
      ).status,
    ).toBe('passed')
  })

  test('MUTANT: ignoring the binding goes RED', () => {
    const out = mutate(
      SRC.replace("!appBound.has(name) || r.kind === 'CheckRun'", 'true'),
    ).classifyReviewReadiness(readinessProbe('MERGEABLE', [statusRow('ci', 'SUCCESS')] as never), BOUND)
    // The HEADLINE guard replayed against it:
    goesRed(() => expect(out.status).toBe('absent'))
    expect(out.status).toBe('passed') // …the wrong producer satisfying the requirement
  })
})

/**
 * THE FAST-FAIL NEEDS THE PR TO HAVE GONE QUIET, NOT JUST THE CLOCK TO HAVE RUN.
 *
 * Round 2 delayed the base-head snapshot's ambiguity by a settle window instead of
 * resolving it: a required job that was QUEUED or RUNNING at minute 10 was still called
 * a repository configuration error, because the only facts consulted were a snapshot
 * that cannot see a `pull_request`-only job and a clock. GitHub creates a check run when
 * the job is queued, so a job that exists and is merely slow IS in the PR's own rollup
 * as a non-terminal row — and that is the evidence the stop was missing.
 */
describe('the config error waits while this PR is still moving', () => {
  const prOnly = () => requiredCfg(['pr-only'], ['check', 'frontend'])
  const settled = [checkRow('check', 'COMPLETED', 'SUCCESS'), checkRow('frontend', 'COMPLETED', 'SUCCESS')]
  const stillMoving = [checkRow('check', 'COMPLETED', 'SUCCESS'), checkRow('frontend', 'IN_PROGRESS', null)]

  test('HEADLINE: past the settle window, an unfinished rollup still WAITS', () => {
    const { classifyReviewReadiness, REVIEW_READINESS_CONFIG_GRACE_MS, REVIEW_READINESS_BUDGET_MS } = loadReadiness()
    const at = (rows: unknown[], elapsed: number) =>
      classifyReviewReadiness(readinessProbe('MERGEABLE', rows as never), prOnly(), elapsed)
    expect(at(stillMoving, REVIEW_READINESS_CONFIG_GRACE_MS).status).toBe('absent')
    // …and it keeps waiting for the whole budget rather than converting to a fault.
    expect(at(stillMoving, REVIEW_READINESS_BUDGET_MS).status).toBe('absent')
    // THE CONTROL: the same absence, the same clock, on a rollup that HAS finished.
    expect(at(settled, REVIEW_READINESS_CONFIG_GRACE_MS).status).toBe('config-error')
  })

  test('a QUEUED row counts as moving too, and a SKIPPED one does not', () => {
    const { classifyReviewReadiness, REVIEW_READINESS_CONFIG_GRACE_MS } = loadReadiness()
    const at = (rows: unknown[]) =>
      classifyReviewReadiness(readinessProbe('MERGEABLE', rows as never), prOnly(), REVIEW_READINESS_CONFIG_GRACE_MS).status
    expect(at([checkRow('check', 'COMPLETED', 'SUCCESS'), checkRow('frontend', 'QUEUED', null)])).toBe('absent')
    expect(at([checkRow('check', 'COMPLETED', 'SUCCESS'), statusRow('frontend', 'PENDING')])).toBe('absent')
    // SKIPPED is "did not run", so it cannot hold the gate open forever.
    expect(at([checkRow('check', 'COMPLETED', 'SUCCESS'), checkRow('frontend', 'COMPLETED', 'SKIPPED')])).toBe('config-error')
  })

  /**
   * AN EMPTY ROLLUP SATISFIED "EVERYTHING HAS FINISHED" VACUOUSLY.
   *
   * `rollupSettled` began life as `true` and was falsified only from inside a loop over
   * the rollup's own rows, so ZERO rows left it true — and the fast-fail then declared a
   * configuration fault whose sentence read `every other check on this PR has finished`
   * over a PR where nothing had started. Because config-error is terminal, that also
   * spent the remaining waits on a state that only needed waiting.
   *
   * The trigger is ordinary: a fork / first-time-contributor PR whose workflows sit
   * `awaiting approval` reports `statusCheckRollup: []` until a maintainer approves.
   */
  test('HEADLINE: an EMPTY rollup waits — it is not a settled one', async () => {
    const { classifyReviewReadiness, reviewWithPreconditions, REVIEW_READINESS_CONFIG_GRACE_MS, REVIEW_READINESS_BUDGET_MS } =
      loadReadiness()
    const at = (rows: unknown[], elapsed: number) =>
      classifyReviewReadiness(readinessProbe('MERGEABLE', rows as never), prOnly(), elapsed)
    // Past the grace, and then past the WHOLE budget: still waiting, never a fault.
    expect(at([], REVIEW_READINESS_CONFIG_GRACE_MS).status).toBe('absent')
    expect(at([], REVIEW_READINESS_BUDGET_MS).status).toBe('absent')
    // …and it does not claim a settled rollup it cannot see.
    expect(at([], REVIEW_READINESS_BUDGET_MS).reason).toBe('required check pr-only has not run')
    // THE CONTROL: same clock, same absent required name, on a rollup that HAS rows and
    // has finished — the fast-fail is genuinely reachable here, so the assertions above
    // are about emptiness rather than about an unreachable branch.
    expect(at(settled, REVIEW_READINESS_CONFIG_GRACE_MS).status).toBe('config-error')
    // The consequence that matters: waits get spent instead of the round dying at once.
    let waits = 0
    const out = await reviewWithPreconditions({
      probe: async () => at([], REVIEW_READINESS_BUDGET_MS),
      spend: async () => 'reviewed',
      wait: async () => {
        waits += 1
      },
      attempts: 3,
    })
    expect({ deferred: out.deferred, waits }).toEqual({ deferred: true, waits: 2 })
  })

  test('MUTANT: seeding rollupSettled to `true` again goes RED on the empty rollup', () => {
    const mutant = SRC.replace('  let rollupSettled = byName.size > 0', '  let rollupSettled = true')
    // The replacement MATCHED (an unchanged source would silently test nothing)…
    expect(mutant).not.toBe(SRC)
    const { REVIEW_READINESS_CONFIG_GRACE_MS } = loadReadiness()
    // …the mutant LOADS…
    const mutated = mutate(mutant)
    const out = mutated.classifyReviewReadiness(
      readinessProbe('MERGEABLE', [] as never),
      prOnly(),
      REVIEW_READINESS_CONFIG_GRACE_MS,
    )
    // …and the guard's own assertion, replayed against it, goes RED.
    goesRed(() => expect(out.status).toBe('absent'))
    expect(out.status).toBe('config-error') // …what it answers instead
    expect(out.reason).toContain('every other check on this PR has finished') // …over zero checks
  })

  test('the deferral sentence states the new evidence', () => {
    const { classifyReviewReadiness, REVIEW_READINESS_CONFIG_GRACE_MS } = loadReadiness()
    const out = classifyReviewReadiness(
      readinessProbe('MERGEABLE', settled as never),
      prOnly(),
      REVIEW_READINESS_CONFIG_GRACE_MS,
    )
    expect(out.reason).toBe(
      'required check pr-only has not appeared after at least 10 minutes, every other check on this PR has finished, ' +
        'and the base branch head reports 2 other checks without it',
    )
  })

  test('MUTANT: dropping the settled condition goes RED', () => {
    const out = mutate(SRC.replace('        rollupSettled\n', '        true\n')).classifyReviewReadiness(
      readinessProbe('MERGEABLE', stillMoving as never),
      prOnly(),
      loadReadiness().REVIEW_READINESS_CONFIG_GRACE_MS,
    )
    // The HEADLINE guard replayed against it:
    goesRed(() => expect(out.status).toBe('absent'))
    expect(out.status).toBe('config-error') // …a running job called a configuration fault
  })
})

/**
 * AND THE SNAPSHOT IT DOES STOP ON IS RE-READ FIRST.
 *
 * `produced` is resolved ONCE per round and reused by every attempt, so by the time the
 * fast-fail fires it can be a full settle window old. `confirmedConfigError` re-derives
 * the verdict from a fresh read before letting the only terminal snapshot-based stop
 * stand — and refuses to let a failed re-read overwrite it in either direction.
 */
describe('a stop built on a snapshot is confirmed against a fresh one', () => {
  const CONFIG_ERROR = { status: 'config-error', reason: 'required check pr-only has not appeared…' } as never
  const PASSED = { status: 'passed', reason: '', failed: [] } as never

  test('HEADLINE: a base head that has since produced the check CANCELS the stop', () => {
    const { confirmedConfigError } = loadReadiness()
    const fresh = { mode: 'resolved', required: ['pr-only'], appBound: [], produced: ['check', 'pr-only'] }
    // The re-classification is the caller's; what this decides is whether it happens.
    expect(confirmedConfigError(CONFIG_ERROR, fresh, () => PASSED)).toBe(PASSED)
  })

  test('a fresh read that did NOT resolve leaves the verdict alone', () => {
    const { confirmedConfigError } = loadReadiness()
    let reclassified = 0
    const keep = () => { reclassified += 1; return PASSED }
    expect(confirmedConfigError(CONFIG_ERROR, { mode: 'unknown', cause: 'gh auth login' }, keep)).toBe(CONFIG_ERROR)
    expect(confirmedConfigError(CONFIG_ERROR, null, keep)).toBe(CONFIG_ERROR)
    expect(confirmedConfigError(CONFIG_ERROR, undefined, keep)).toBe(CONFIG_ERROR)
    // A transient credential failure is not evidence, so it never even re-runs.
    expect(reclassified).toBe(0)
  })

  test('every OTHER verdict is returned untouched, and costs no second read', () => {
    const { confirmedConfigError } = loadReadiness()
    const fresh = { mode: 'resolved', required: [], appBound: [], produced: [] }
    let reclassified = 0
    for (const status of ['passed', 'failed', 'absent', 'pending', 'unknown', 'conflicting']) {
      const verdict = { status, reason: '' } as never
      expect(confirmedConfigError(verdict, fresh, () => { reclassified += 1; return PASSED })).toBe(verdict)
    }
    expect(reclassified).toBe(0)
  })

  test('WIRED: the extra read is spent only on the config-error attempt', () => {
    // The seat is paid for once, on the one attempt of the one round where the stop
    // would otherwise fire — a healthy build never pays for it.
    expect(SRC).toContain(
      "const fresh = readiness.status === 'config-error' ? await probeRequiredChecks(prForReview, `${round}-confirm`) : null",
    )
    expect(SRC).toContain(
      'return confirmedConfigError(readiness, fresh, (cfg) => classifyReviewReadiness(res, cfg, elapsedMs))',
    )
  })
})

/**
 * THE TRANSCRIPT IS SPLIT ON THE LAST MARKER, FOR THE REASON `exitOf` ALREADY WAS.
 *
 * The probe's own command line carries all four section markers, so ONE echoed command
 * in the transcript moved every boundary to the echo and mis-assigned every section.
 */
describe('an echoed command line cannot mis-slice the transcript', () => {
  const CLEAN = requiredProbe({
    prot: '{"contexts":["check"]}',
    protExit: 0,
    branch: RULESET_GOVERNED_BRANCH,
    rules: '[]',
    rulesExit: 0,
    runs: named(['check']),
  })
  // What a traced shell prepends: the command, containing every marker and the
  // `repos/{owner}/{repo}` braces that also defeat a first-`{` JSON slice.
  const ECHO =
    '+ gh api repos/{owner}/{repo}/branches/main/protection/required_status_checks; echo ___SECTION=BRANCH; ' +
    'echo ___SECTION=RULES; echo ___SECTION=RUNS; echo ___SECTION=STATUSES\n'

  test('HEADLINE: the prefixed transcript resolves exactly as the clean one does', () => {
    const { classifyRequiredChecksProbe } = loadReadiness()
    const clean = classifyRequiredChecksProbe(CLEAN)
    expect(clean).toEqual({ mode: 'resolved', required: ['check'], appBound: [], produced: ['check'] })
    expect(classifyRequiredChecksProbe({ raw: ECHO + CLEAN.raw, exit_code: 0 })).toEqual(clean)
  })

  test('the sections themselves land where they belong', () => {
    const { probeSections } = loadReadiness()
    const sec = probeSections(ECHO + CLEAN.raw)
    expect(sec.PROT).toContain('"contexts":["check"]')
    expect(sec.BRANCH).toContain('"protectionEnabled":false')
    expect(sec.RUNS).toContain('"names":["check"]')
    // An ABSENT section is '' rather than someone else's text.
    expect(probeSections('nothing here at all').RULES).toBe('')
  })

  test('MUTANT: splitting on the FIRST marker goes RED', () => {
    const mutant = SRC.replace(
      'const found = limit <= 0 ? -1 : text.lastIndexOf(marker(PROBE_SECTION_KEYS[i]), limit - 1)',
      'const found = text.indexOf(marker(PROBE_SECTION_KEYS[i]))',
    )
    const out = mutate(mutant).classifyRequiredChecksProbe({ raw: ECHO + CLEAN.raw, exit_code: 0 })
    // The HEADLINE guard replayed against it:
    goesRed(() => expect(out.mode).toBe('resolved'))
    expect(out.mode).toBe('unknown')
  })
})

/**
 * A TRUNCATED PRODUCED LIST DISABLES THE FAST-FAIL, AND THAT IS NOT FREE.
 *
 * `per_page=100` without pagination returns a complete-LOOKING array, so both reads ask
 * for GitHub's `total_count` and a short list nulls out. The consequence is pinned here
 * as well as documented in the source because it is otherwise invisible: on a base head
 * with more than 100 checks (`microsoft/vscode` measured at 120) a genuinely mis-named
 * required check no longer stops early — it burns the full budget and defers as
 * `absent`, which reads like a queue problem rather than a configuration one.
 */
describe('truncation is unreadable, not short', () => {
  test('HEADLINE: a truncated base-head list WAITS instead of failing fast, at any elapsed time', () => {
    const { classifyRequiredChecksProbe, classifyReviewReadiness, REVIEW_READINESS_BUDGET_MS } = loadReadiness()
    const cfg = classifyRequiredChecksProbe(
      requiredProbe({
        prot: '{"contexts":["pr-only"]}',
        protExit: 0,
        rules: '[]',
        rulesExit: 0,
        runs: named(['check', 'frontend'], 120),
      }),
    )
    expect(cfg.produced).toBeNull()
    const out = classifyReviewReadiness(
      readinessProbe('MERGEABLE', [checkRow('check', 'COMPLETED', 'SUCCESS')] as never),
      cfg,
      REVIEW_READINESS_BUDGET_MS,
    )
    expect(out.status).toBe('absent')
    expect(out.reason).toBe('required check pr-only has not run')
    // THE CONTROL: the identical list, untruncated, DOES stop.
    const complete = classifyRequiredChecksProbe(
      requiredProbe({
        prot: '{"contexts":["pr-only"]}',
        protExit: 0,
        rules: '[]',
        rulesExit: 0,
        runs: named(['check', 'frontend']),
      }),
    )
    expect(complete.produced).toEqual(['check', 'frontend'])
    expect(
      classifyReviewReadiness(
        readinessProbe('MERGEABLE', [checkRow('check', 'COMPLETED', 'SUCCESS')] as never),
        complete,
        REVIEW_READINESS_BUDGET_MS,
      ).status,
    ).toBe('config-error')
  })

  test('the cost of that safety is written down where the guard is', () => {
    expect(SRC).toContain('SAY WHAT THAT COSTS, BECAUSE IT IS NOT FREE AND IT IS INVISIBLE')
  })
})
