/**
 * #542 — A RATE-LIMITED CROSS-MODEL PROVIDER MUST BE REPORTABLE AS ITSELF.
 *
 * The defect: `trident/kimi-review.ts` folded HTTP 429 into `deferred`, and the
 * verdict schemas in `trident/inner-workflow.mjs` have no way to say anything else.
 * A deferred cross-model seat becomes a LANE finding whose TITLE is the run's ENTIRE
 * terminal cause (`infraTerminalCause` → `terminal_cause` → `failure_reason` → the
 * operator's summary), and that title said "DEFERRED — refusing to silently APPROVE"
 * over evidence offering "the review call failed, timed out, or returned no answer
 * text". None of it was true. The panel ran in full, paid for itself, refused the
 * merge, and then sent the operator to look at the network instead of the balance.
 *
 * THE FIX IS NOT A NEW ENUM MEMBER. `deferred` already carries the only thing the
 * gate asks — "a configured reviewer produced no review" — which is exactly as true
 * of a 429 as of a timeout. A fourth status member would have to be threaded through
 * every `=== 'deferred'` comparison in the workflow, and each one missed is a gate
 * that silently stops blocking: the fail-OPEN direction. So the STATUS BLOCKS and a
 * FACT FIELD NAMES, the division `codexTruncated` already uses.
 *
 * WHAT THESE TESTS PIN, and both halves matter:
 *
 *   1. A 429 produces the honest row — a title that says QUOTA and HTTP 429, does
 *      NOT say "deferred", and reaches the operator as infrastructure.
 *   2. A GENUINE findings-carrying REQUEST_CHANGES is STILL 'code', STILL `genuine`,
 *      and STILL blocks. Without this half the fix is a merge-anything hole.
 *   3. A 429 mid-panel does not mark the panel as having reviewed.
 *   4. The two halves of every cross-file contract here actually match: the stderr
 *      token, and the phrase `delivery.ts` keys its advice on.
 *
 * TESTED AGAINST THE REAL FUNCTIONS, extracted from the `.mjs` and evaluated — the
 * technique the cross-model gate and CI gate tests already use, for the reason they
 * document: the workflow body cannot be imported (its top-level `return` is the
 * Workflow runtime's result API), and a hand-copied TypeScript duplicate is a test
 * that cannot fail for the reason it claims to check.
 */

import { describe, expect, test } from 'bun:test'

import { interpretFailure } from '../delivery.ts'
import {
  KIMI_QUOTA_TOKEN,
  QUOTA_EXHAUSTED_HTTP,
  reviewWithKimi,
  type KimiFetch,
} from '../kimi-review.ts'
import {
  classifyInnerFailure,
  innerTerminalFailureReason,
  recordedTerminalVerdict,
} from '../orchestrator.ts'
import { makeTridentRun } from '../testing/make-trident-run.ts'
import type { TridentRun } from '../store.ts'

const SRC = await Bun.file(new URL('../inner-workflow.mjs', import.meta.url)).text()

/** Brace-match one function out of the workflow source. */
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

/** One top-level `const` line, lifted from the SAME source the shipped code uses. */
function grabConst(name: string): string {
  const line = SRC.split('\n').find((l) => l.startsWith(`const ${name} =`))
  if (line === undefined) throw new Error(`const ${name} is missing from inner-workflow.mjs`)
  return line
}

interface Peer {
  name: string
  title: string
  evidence: string
}

interface Real {
  deferredCrossModelPeers: (statuses: unknown, routes?: unknown, exhausted?: unknown) => Peer[]
  quotaExhaustedPeer: (name: string) => Peer
  crossModelQuotaExhausted: (slot: number | null, verdicts: unknown[], key: string | null) => boolean
  seatQuotaKey: (group: string) => string | null
  crossModelPeerStatus: (slot: number | null, verdicts: unknown[], statusKey: string) => string
  enforceCrossModelGate: (s: unknown, peers: unknown[]) => { verdict: string; findings: unknown[] }
  classifyBlock: (s: unknown, peers: unknown[], noReviewRan?: boolean, panelRejected?: boolean) => string
  infraTerminalCause: (s: unknown) => string
}

/**
 * LOADED INSIDE EACH TEST, never in a describe body. A load failure in a describe body
 * DELETES the tests instead of failing them — "0 fail" with every test silently absent,
 * which is the guard-cannot-fail shape this whole area exists to prevent.
 */
function loadReal(): Real {
  const factory = new Function(
    [
      grabConst('LANE_FINDING_KIND'),
      grabConst('NON_BLOCKING_SEVERITIES'),
      grabConst('ADVISORY_FINDING_KEY'),
      grabConst('CORE_SEAT_STATUS_KEY'),
      grabConst('usableStatus'),
      grabConst('TERMINAL_CAUSE_MAX'),
      grab('isNonBlockingFinding'),
      grab('isCodeWorkFinding'),
      grab('redactProbeText'),
      grab('quotaExhaustedPeer'),
      grab('deferredCrossModelPeers'),
      grab('crossModelQuotaExhausted'),
      grab('seatQuotaKey'),
      grab('crossModelPeerStatus'),
      grab('enforceCrossModelGate'),
      grab('classifyBlock'),
      grab('infraTerminalCause'),
      'return { deferredCrossModelPeers, quotaExhaustedPeer, crossModelQuotaExhausted,' +
        ' seatQuotaKey, crossModelPeerStatus, enforceCrossModelGate, classifyBlock, infraTerminalCause }',
    ].join('\n'),
  ) as () => Real
  return factory()
}

const DIFF = '--- a/x.ts\n+++ b/x.ts\n@@\n-const a = 1\n+const a = 2\n'
const KEY = 'sk-kimi-synthetic'

function fetchStatus(status: number, body: unknown = { error: 'rate limited' }): KimiFetch {
  return async () => ({ ok: false, status, text: async () => JSON.stringify(body) })
}

/** A harvested, failed row carrying the workflow's own infra-only terminal result. */
function infraRun(cause: string, overrides: Partial<TridentRun> = {}): TridentRun {
  return makeTridentRun({
    id: 'run-1',
    slug: 'add-flag',
    project_slug: 'proj-1',
    phase: 'failed',
    branch: 'trident/add-flag',
    repo_path: '/repo',
    task: 'add a feature flag',
    harvested_at: 1755300000000,
    inner_result: JSON.stringify({
      ok: false,
      verdict: 'REQUEST_CHANGES',
      round: 1,
      checkpoint: null,
      blockKind: 'infra-only',
      terminalCause: cause,
    }),
    failure_reason: `review never ran (infra-only) at round 1 of 10: ${cause}`,
    ...overrides,
  })
}

describe('#542 the producer — a 429 is measured as quota, without leaving `deferred`', () => {
  test('HEADLINE: a 429 sets quotaExhausted and names the fact; the status still BLOCKS', async () => {
    const r = await reviewWithKimi({
      diff: DIFF,
      task: 'bump a',
      apiKey: KEY,
      fetchImpl: fetchStatus(QUOTA_EXHAUSTED_HTTP),
    })
    // The status is unchanged on purpose — this is what every gate in the workflow
    // reads, and 'deferred' is the true answer to the only question it asks.
    expect(r.status).toBe('deferred')
    expect(r.text).toBe('')
    // ...and the NEW fact, which is what makes the failure reportable.
    expect(r.quotaExhausted).toBe(true)
    expect(r.reason).toContain('429')
    expect(r.reason).toContain('no allowance left')
  })

  test('and it claims NOTHING about which kind of 429 it was', async () => {
    // The provider uses one code for a per-minute rate limit and for an empty
    // balance and does not say which. "wait" and "top up" are different actions, so
    // guessing between them would be a confident sentence about an unmeasured cause.
    const r = await reviewWithKimi({
      diff: DIFF,
      task: 'bump a',
      apiKey: KEY,
      fetchImpl: fetchStatus(QUOTA_EXHAUSTED_HTTP),
    })
    expect(r.reason).toContain('rate limit')
    expect(r.reason).toContain('did not say which')
  })

  test('EVERY OTHER non-ok status is unflagged — a rejected key is not a quota problem', async () => {
    for (const status of [401, 403, 500, 502, 529]) {
      const r = await reviewWithKimi({
        diff: DIFF,
        task: 'bump a',
        apiKey: KEY,
        fetchImpl: fetchStatus(status),
      })
      expect(r.status).toBe('deferred')
      expect(r.quotaExhausted).toBeUndefined()
      expect(r.reason).toContain(String(status))
    }
  })

  test('a transport throw and an answerless 200 are unflagged too', async () => {
    const thrown = await reviewWithKimi({
      diff: DIFF,
      task: 'bump a',
      apiKey: KEY,
      fetchImpl: async () => {
        throw new Error('socket hang up')
      },
    })
    expect(thrown.status).toBe('deferred')
    expect(thrown.quotaExhausted).toBeUndefined()

    const answerless = await reviewWithKimi({
      diff: DIFF,
      task: 'bump a',
      apiKey: KEY,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ content: [{ type: 'thinking', thinking: '...' }] }),
      }),
    })
    expect(answerless.status).toBe('deferred')
    expect(answerless.quotaExhausted).toBeUndefined()
  })
})

describe('#542 the CLI — the fact reaches stderr as a greppable token, not as prose', () => {
  test('the CLI writes the token from the FIELD, so rewording `reason` cannot unhook the grep', () => {
    const src = Bun.file(new URL('../kimi-review-cli.ts', import.meta.url))
    return src.text().then((text) => {
      // The emission is conditioned on the FACT FIELD. Keying it on the reason text
      // instead is the drift this asserts against: `reason` is human prose and gets
      // reworded, and the bridge's grep is a contract.
      expect(text).toContain('if (result.quotaExhausted === true) process.stderr.write(`${KIMI_QUOTA_TOKEN}\\n`)')
      // The exit code is DELIBERATELY still the deferred one — the vocabulary is
      // shared with codex-review.sh and the panel's question is answered `no` either way.
      expect(text).toContain("result.status === 'not_connected' ? EXIT_NOT_CONNECTED : EXIT_DEFERRED")
    })
  })

  test('BOTH HALVES MOVE TOGETHER: the token in the .mjs equals the exported one', () => {
    // The workflow body has no module resolution, so the token is a literal in two
    // files. A silent divergence makes every quota failure decay into the generic
    // deferral row — safe, and exactly the bug.
    const line = grabConst('KIMI_QUOTA_TOKEN')
    expect(line).toContain(`'${KIMI_QUOTA_TOKEN}'`)
  })

  test('the review bridge actually GREPS for it and tells the model to copy the result verbatim', () => {
    // A fact only the model reads is a fact the workflow cannot act on — the reason
    // the codex bridge greps CODEX_REVIEW_DIFF_TRUNCATED rather than asking GPT-5.
    const prompt = grab('kimiReviewerPrompt')
    expect(prompt).toContain('grep -q ${shSingleQuote(KIMI_QUOTA_TOKEN)}')
    expect(prompt).toContain('KIMI_QUOTA=1')
    expect(prompt).toContain('KIMI_QUOTA=0')
    expect(prompt).toContain('kimiQuotaExhausted: copy the KIMI_QUOTA line VERBATIM')
    // ...and the schema must be able to carry it, or the bridge has nowhere to put it.
    expect(SRC).toContain('kimiQuotaExhausted: {')
  })
})

describe('#542 the honest row — a quota refusal is reportable as itself', () => {
  test('HEADLINE: the lane title says QUOTA and HTTP 429, and never says "deferred"', () => {
    const { deferredCrossModelPeers } = loadReal()
    const [peer] = deferredCrossModelPeers(
      { codex: 'connected', kimi: 'deferred' },
      {},
      { kimi: true },
    )
    expect(peer).toBeDefined()
    // The title IS the run's whole terminal cause, so this is the sentence the
    // operator ends up reading.
    expect(peer!.title).toContain('QUOTA EXHAUSTED')
    expect(peer!.title).toContain('HTTP 429')
    expect(peer!.title).toContain('no review was performed')
    // A deferral is a review that declined to be given. This is a reviewer that was
    // never reachable, and the two have different remedies.
    expect(peer!.title.toLowerCase()).not.toContain('deferred')
    expect(peer!.name).toBe('Kimi K3')
  })

  test('the evidence names BOTH remedies and refuses to invent a review', () => {
    const { deferredCrossModelPeers } = loadReal()
    const [peer] = deferredCrossModelPeers({ codex: 'connected', kimi: 'deferred' }, {}, { kimi: true })
    expect(peer!.evidence).toContain('rate limit')
    expect(peer!.evidence).toContain('top the account up')
    expect(peer!.evidence).toContain('nothing in the')
    // The old row's three claims, all of them false over a 429, must be retracted.
    expect(peer!.evidence).toContain('NOTHING failed and nothing timed')
  })

  test('and it is NOT the row a real transport failure gets — the flag is what switches', () => {
    const { deferredCrossModelPeers } = loadReal()
    const [plain] = deferredCrossModelPeers({ codex: 'connected', kimi: 'deferred' }, {})
    expect(plain!.title).toContain('DEFERRED')
    expect(plain!.title).not.toContain('QUOTA')
  })

  test('the quota row is ONE function serving every slot and family — no fourth sentence', () => {
    const { deferredCrossModelPeers, quotaExhaustedPeer } = loadReal()
    // Slot one, codex family.
    const [slotOne] = deferredCrossModelPeers({ codex: 'deferred', kimi: 'connected' }, {}, { codex: true })
    expect(slotOne).toEqual(quotaExhaustedPeer('Codex'))
    // Slot two carrying a codex tier instead of kimi — the seats are slots, not vendors.
    const [slotTwo] = deferredCrossModelPeers(
      { codex: 'connected', kimi: 'deferred' },
      { kimi: { group: 'codex' } },
      { kimi: true },
    )
    expect(slotTwo).toEqual(quotaExhaustedPeer('Cross-model review 2 (Codex)'))
    // Both seats out of allowance at once is two rows, not one.
    expect(
      deferredCrossModelPeers({ codex: 'deferred', kimi: 'deferred' }, {}, { codex: true, kimi: true }),
    ).toHaveLength(2)
  })

  test('a CONNECTED or NOT_CONNECTED seat writes no row at all, flag or no flag', () => {
    const { deferredCrossModelPeers } = loadReal()
    // The flag only ever refines a row that already exists. A quota flag on a seat
    // that ANSWERED must not manufacture a block out of nothing.
    expect(deferredCrossModelPeers({ codex: 'connected', kimi: 'connected' }, {}, { kimi: true })).toEqual([])
    expect(
      deferredCrossModelPeers({ codex: 'not_connected', kimi: 'not_connected' }, {}, { codex: true, kimi: true }),
    ).toEqual([])
  })
})

describe('#542 unknown authorises nothing — every non-`true` flag falls back to the deferral row', () => {
  test('absent, undefined, null, a string, 1, and a dead seat all read as NOT quota', () => {
    const { crossModelQuotaExhausted, deferredCrossModelPeers } = loadReal()
    // The flag travels through a bridge agent copying a grepped line into a schema
    // field. A missing field, a stringified 'true', a null: every one of those is a
    // flag that did not arrive, and an unknown cause must fall back to the row that
    // assumes LESS. That row blocks identically — only the reporting differs, and
    // asserting a billing fact nobody measured is the same defect wearing the other hat.
    for (const v of [undefined, null, 'true', 1, {}, 0, false]) {
      expect(crossModelQuotaExhausted(1, [null, { kimiQuotaExhausted: v }], 'kimiQuotaExhausted')).toBe(false)
    }
    expect(crossModelQuotaExhausted(1, [null, { kimiQuotaExhausted: true }], 'kimiQuotaExhausted')).toBe(true)
    // A seat that produced NO verdict at all is 'deferred' (crossModelPeerStatus) and
    // unflagged: it is a dead lane, not a billing fact.
    expect(crossModelQuotaExhausted(1, [null, null], 'kimiQuotaExhausted')).toBe(false)
    expect(crossModelQuotaExhausted(1, [], 'kimiQuotaExhausted')).toBe(false)
    // An unconfigured seat has no failure to explain.
    expect(crossModelQuotaExhausted(null, [{ kimiQuotaExhausted: true }], 'kimiQuotaExhausted')).toBe(false)
    // ...and the row that results from an unflagged deferral is the generic one.
    const [peer] = deferredCrossModelPeers({ codex: 'connected', kimi: 'deferred' }, {}, { kimi: false })
    expect(peer!.title).toContain('DEFERRED')
  })

  test('the quota key comes from the ROUTE, never from the slot name', () => {
    const { seatQuotaKey, crossModelQuotaExhausted } = loadReal()
    // Either slot can hold either family, so `codexSlot` holding a kimi tier is an
    // ordinary configuration. Hard-coding 'codexQuotaExhausted' for slot one would
    // read a field that verdict never carries and restore the bug on that route.
    expect(seatQuotaKey('kimi')).toBe('kimiQuotaExhausted')
    expect(seatQuotaKey('codex')).toBe('codexQuotaExhausted')
    // A claude seat fills VERDICT_SCHEMA, which has no quota field and no provider to
    // be refused by — its credential is the session's own. `null` says so.
    expect(seatQuotaKey('claude')).toBe(null)
    expect(crossModelQuotaExhausted(0, [{ kimiQuotaExhausted: true }], seatQuotaKey('claude'))).toBe(false)
    // ...and the derivation is what the call site actually uses.
    expect(SRC).toContain('crossModelQuotaExhausted(codexSlot, verdicts, seatQuotaKey(slotOneRoute.group))')
    expect(SRC).toContain('crossModelQuotaExhausted(kimiSlot, verdicts, seatQuotaKey(slotTwoRoute.group))')
  })
})

describe('#542 a 429 mid-panel does not mark the panel as having reviewed', () => {
  test('HEADLINE: the gate forces REQUEST_CHANGES, the block is infra-only, no round is bought', () => {
    const { deferredCrossModelPeers, enforceCrossModelGate, classifyBlock } = loadReal()
    const peers = deferredCrossModelPeers({ codex: 'connected', kimi: 'deferred' }, {}, { kimi: true })
    // A quota-exhausted seat is still a seat that produced no review, so it still
    // VETOES an APPROVE. The honest row must not have relaxed the gate.
    const gated = enforceCrossModelGate({ verdict: 'APPROVE', findings: [] }, peers)
    expect(gated.verdict).toBe('REQUEST_CHANGES')
    // ...and the block says NO SEAT JUDGED THE CODE, so the fix loop exits rather than
    // re-Forging the diff to "fix" a billing fact.
    expect(classifyBlock(gated, peers)).toBe('infra-only')
  })

  test('the row is recorded as REVIEW_NOT_RUN, never as a rejection', () => {
    // `recordedTerminalVerdict` reserves REQUEST_CHANGES for a reviewer that judged
    // the code. An infra-only block is not one, whatever findings ride along.
    const { deferredCrossModelPeers } = loadReal()
    const peers = deferredCrossModelPeers({ codex: 'connected', kimi: 'deferred' }, {}, { kimi: true })
    expect(
      recordedTerminalVerdict(
        { verdict: 'REQUEST_CHANGES', block_kind: 'infra-only', checkpoint: 'argus-request-changes-round-1' },
        JSON.stringify(peers.map((p) => ({ severity: 'blocker', kind: 'lane', title: p.title }))),
      ),
    ).toBe('REVIEW_NOT_RUN')
  })

  test('the quota title is the measured terminal cause the run carries out', () => {
    const { deferredCrossModelPeers, enforceCrossModelGate, infraTerminalCause } = loadReal()
    const peers = deferredCrossModelPeers({ codex: 'connected', kimi: 'deferred' }, {}, { kimi: true })
    const gated = enforceCrossModelGate({ verdict: 'APPROVE', findings: [] }, peers)
    const cause = infraTerminalCause(gated)
    expect(cause).toBe(peers[0]!.title)
    expect(cause).toContain('QUOTA EXHAUSTED')
  })
})

describe('#542 the terminal reason says quota — not "deferred", not "exhausted N rounds"', () => {
  test('HEADLINE: the stored reason quotes the quota cause and licenses no review claim', () => {
    const { quotaExhaustedPeer } = loadReal()
    const cause = quotaExhaustedPeer('Kimi K3').title
    const reason = innerTerminalFailureReason(
      makeTridentRun({ round: 1, max_rounds: 10 }),
      { verdict: 'REQUEST_CHANGES', block_kind: 'infra-only', terminal_cause: cause, round: 1, checkpoint: null },
    )
    expect(reason).toContain('QUOTA EXHAUSTED')
    expect(reason).toContain('HTTP 429')
    // The generic round-budget sentence is what this replaces. It said ten rounds of
    // review had happened over a reviewer that was never reached.
    expect(reason).not.toContain('without Argus APPROVE')
    expect(reason).toContain('review never ran (infra-only)')
  })

  test('and it routes to the EXISTING infrastructure path, not to a genuine verdict', () => {
    const { quotaExhaustedPeer } = loadReal()
    // Quota exhaustion is an infrastructure cause, not a review opinion, so it spends
    // a bounded infra_retries unit against INFRA_RETRY_BACKOFF_MS rather than ending
    // the run. A per-minute rate limit clears inside that window for free; an empty
    // balance burns three bounded retries and then terminates naming quota.
    expect(
      classifyInnerFailure({
        verdict: 'REQUEST_CHANGES',
        block_kind: 'infra-only',
        terminal_cause: quotaExhaustedPeer('Kimi K3').title,
        checkpoint: 'argus-request-changes-round-1',
      }),
    ).toBe('infrastructure')
  })

  test('HEADLINE: the operator is told infrastructure, NOT that a reviewer had findings', () => {
    const { quotaExhaustedPeer } = loadReal()
    const cause = quotaExhaustedPeer('Kimi K3').title
    const interp = interpretFailure(infraRun(cause))
    // 🚧 not ❌: the code was never rejected, it was never read.
    expect(interp.klass).toBe('infra-blocked')
    // The measured cause rides the summary VERBATIM, so the fact is reportable.
    expect(interp.summary).toContain('QUOTA EXHAUSTED')
    expect(interp.summary).toContain('HTTP 429')
    expect(interp.summary).not.toContain('blocking findings')
  })

  test('THE ORDERING IS THE SAFETY: a title containing "exhausted" must not become a review outcome', () => {
    // `interpretFailure` narrates a reason containing the token 'exhausted' as "the
    // reviewer still had blocking findings" — the exact lie this card exists to
    // remove. It is unreachable from here only because the STRUCTURAL infra-block
    // derivation is checked FIRST. That is an ordering, and orderings get edited, so
    // it is pinned rather than trusted.
    const { quotaExhaustedPeer } = loadReal()
    const cause = quotaExhaustedPeer('Kimi K3').title
    expect(cause.toLowerCase()).toContain('exhausted')
    const interp = interpretFailure(infraRun(cause))
    expect(interp.klass).not.toBe('review-unresolved')
  })

  test('and the ADVICE names the two real remedies instead of "retry once healthy"', () => {
    // BOTH HALVES MOVE TOGETHER: the phrase delivery.ts keys on is authored by
    // `quotaExhaustedPeer` and nowhere else. A reworded title silently restores the
    // retry-forever line, which is advice known in advance to reach the same refusal.
    const { quotaExhaustedPeer } = loadReal()
    const interp = interpretFailure(infraRun(quotaExhaustedPeer('Kimi K3').title))
    expect(interp.input_needed).toContain('top the account up')
    expect(interp.input_needed).toContain('rate-limit window')
    expect(interp.input_needed).not.toContain('once the infrastructure is healthy')
    // Every OTHER infra cause keeps the generic line byte-for-byte.
    expect(interpretFailure(infraRun('the readiness probe could not be read')).input_needed).toContain(
      'once the infrastructure is healthy',
    )
  })
})

/**
 * THE HALF THAT STOPS THIS FIX FROM BECOMING A MERGE-ANYTHING HOLE.
 *
 * Every assertion above is about a reviewer that did not review. The boundary
 * `trident/orchestrator.ts` states explicitly — real review verdicts,
 * findings-carrying REQUEST_CHANGES, and compile/test failures remain `genuine` — must
 * be exactly where it was. If any of these go green the wrong way, the card has bought
 * its honesty by disarming the gate.
 */
describe('#542 a GENUINE findings-carrying REQUEST_CHANGES is untouched — still code, still genuine, still blocks', () => {
  const REAL_FINDING = {
    severity: 'blocker',
    title: 'null deref in parseThing',
    evidence: 'trident/thing.ts:42 dereferences `cfg` after the early return that can leave it null',
  }

  test('HEADLINE: a real rejection is CODE work and buys a fix round', () => {
    const { classifyBlock, deferredCrossModelPeers } = loadReal()
    // No seat is down: a healthy panel, judging the diff, with a reason.
    const peers = deferredCrossModelPeers({ codex: 'connected', kimi: 'connected' }, {}, { kimi: true })
    expect(peers).toEqual([])
    expect(classifyBlock({ verdict: 'REQUEST_CHANGES', findings: [REAL_FINDING] }, peers)).toBe('code')
  })

  test('and the orchestrator still calls it GENUINE — never retried as infrastructure', () => {
    expect(
      classifyInnerFailure({
        verdict: 'REQUEST_CHANGES',
        block_kind: 'code',
        terminal_cause: null,
        checkpoint: 'argus-request-changes-round-1',
      }),
    ).toBe('genuine')
    // ...and it stays genuine even when its own words happen to contain a transport
    // token. `block_kind: 'code'` is a review verdict, and the classifier fails closed.
    expect(
      classifyInnerFailure({
        verdict: 'REQUEST_CHANGES',
        block_kind: 'code',
        terminal_cause: 'the retry deferred a fetch that timed out',
        checkpoint: 'argus-request-changes-round-1',
      }),
    ).toBe('genuine')
  })

  test('and it is still RECORDED as a rejection, with its findings preserved', () => {
    expect(
      recordedTerminalVerdict(
        { verdict: 'REQUEST_CHANGES', block_kind: 'code', checkpoint: 'argus-request-changes-round-1' },
        JSON.stringify([REAL_FINDING]),
      ),
    ).toBe('REQUEST_CHANGES')
  })

  test('and a quota-exhausted seat ALONGSIDE a real finding still buys the round', () => {
    // The lane row must not swallow the code work. `classifyBlock` asks "is there code
    // work here?" first, and a real blocker outranks a dead seat.
    const { classifyBlock, deferredCrossModelPeers, enforceCrossModelGate } = loadReal()
    const peers = deferredCrossModelPeers({ codex: 'connected', kimi: 'deferred' }, {}, { kimi: true })
    const gated = enforceCrossModelGate({ verdict: 'REQUEST_CHANGES', findings: [REAL_FINDING] }, peers)
    expect(classifyBlock(gated, peers)).toBe('code')
    expect(JSON.stringify(gated.findings)).toContain('null deref in parseThing')
  })

  test('and NOTHING about a quota row can reach APPROVE', () => {
    const { deferredCrossModelPeers, enforceCrossModelGate } = loadReal()
    for (const synthesis of [
      { verdict: 'APPROVE', findings: [] },
      { verdict: 'COMMENT', findings: [] },
      null,
    ]) {
      const peers = deferredCrossModelPeers({ codex: 'deferred', kimi: 'deferred' }, {}, { codex: true, kimi: true })
      expect(enforceCrossModelGate(synthesis, peers).verdict).toBe('REQUEST_CHANGES')
    }
  })
})
