/**
 * #542 — A PROVIDER THAT REFUSED WITH HTTP 429 MUST BE REPORTABLE AS ITSELF.
 *
 * The defect: `trident/kimi-review.ts` folded HTTP 429 into `deferred`, and the
 * verdict schemas in `trident/inner-workflow.mjs` have no way to say anything else.
 * A deferred cross-model seat becomes a LANE finding whose TITLE is the run's ENTIRE
 * terminal cause (`infraTerminalCause` → `terminal_cause` → `failure_reason` → the
 * operator's summary), and that title said "DEFERRED — refusing to silently APPROVE"
 * over evidence offering "the review call failed, timed out, or returned no answer
 * text". None of it was true. The panel ran in full, paid for itself, refused the
 * merge, and then sent the operator to look at the network.
 *
 * THE FIX IS NOT A NEW ENUM MEMBER. `deferred` already carries the only thing the
 * gate asks — "a configured reviewer produced no review" — which is exactly as true
 * of a 429 as of a timeout. A fourth status member would have to be threaded through
 * every `=== 'deferred'` comparison in the workflow, and each one missed is a gate
 * that silently stops blocking: the fail-OPEN direction. So the STATUS BLOCKS and a
 * FACT FIELD NAMES, the division `codexTruncated` already uses.
 *
 * AND THE ROW NAMES THE OBSERVATION, NOT AN INFERRED CAUSE. An earlier draft called
 * the field `quotaExhausted` and asserted "the account has no allowance left". A
 * status code does not carry that: 429 covers a per-minute rate limit and an empty
 * balance alike, and `trident/kimi-usage-probe.ts` had ALREADY settled the reading
 * for this provider by excluding 429 from `isPermanentRejection` — "a timeout and a
 * rate limit are the two 4xx codes that mean 'ask again later'". Two parts of trident
 * drawing opposite conclusions from one observation is worse than either conclusion.
 * Several tests here exist to keep the row on the honest side of that line.
 *
 * WHAT THESE TESTS PIN, and both halves matter:
 *
 *   1. A 429 produces the honest row — a title that names HTTP 429, does NOT say
 *      "deferred", does NOT assert depletion, and reaches the operator as
 *      infrastructure.
 *   2. A GENUINE findings-carrying REQUEST_CHANGES is STILL 'code', STILL `genuine`,
 *      and STILL blocks. Without this half the fix is a merge-anything hole.
 *   3. A 429 mid-panel does not mark the panel as having reviewed, and is not
 *      re-called instantly by the lane retry.
 *   4. The two halves of every cross-file contract here actually match: the stderr
 *      token, and the token `delivery.ts` keys its advice on.
 *
 * THE CLI IS EXERCISED AS A SUBPROCESS, not asserted against its own source. Two
 * tests here used to check that a substring existed in the file and executed nothing,
 * which left a real mutation alive: an UNCONDITIONAL `process.stderr.write(TOKEN)`
 * anywhere in `main` keeps a source-substring test green while making every rejected
 * key and every dropped socket report as a rate limit, because the workflow greps the
 * whole stderr stream. So the CLI now runs against a local server that returns the
 * status under test, and the marker is asserted present for 429 and ABSENT for
 * everything else.
 *
 * The workflow functions are extracted from the `.mjs` and evaluated — the technique
 * the cross-model gate and CI gate tests already use, for the reason they document:
 * the workflow body cannot be imported (its top-level `return` is the Workflow
 * runtime's result API), and a hand-copied TypeScript duplicate is a test that cannot
 * fail for the reason it claims to check.
 */

import { describe, expect, test } from 'bun:test'

import { interpretFailure } from '../delivery.ts'
import {
  KIMI_RATE_LIMIT_TOKEN,
  RATE_LIMIT_HTTP,
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
/** `delivery.ts`'s own source — the seat-label set is read out of it rather than retyped,
 *  so the drift guard below compares the SHIPPED list against the SHIPPED emitter. */
const DELIVERY_SRC = await Bun.file(new URL('../delivery.ts', import.meta.url)).text()
/** Six today: two same-family seats plus two off-family choices for each of the two slots.
 *  Pinned as a NUMBER as well as a set, so a slice bug that reads zero labels cannot make
 *  the drift guard pass by comparing two empty sets — which is exactly what it first did. */
const CROSS_MODEL_SEAT_LABEL_COUNT = 6

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
  // TWO PARAMETERS, and the drift between this and the implementation is why CI went
  // red: the stutter fix added `label` to `rateLimitedPeer` and this declaration was
  // left at one argument, so every call site here was a TS2554. The root `tsconfig.json`
  // does not include `trident/**`, so `bunx tsc --noEmit` never looked at this file —
  // `bunx tsc -p trident/tsconfig.json --noEmit` is the command that matches CI.
  rateLimitedPeer: (name: string, label: string) => Peer
  crossModelRateLimited: (slot: number | null, verdicts: unknown[], key: string | null) => boolean
  seatRateLimitKey: (group: string) => string | null
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
      grab('rateLimitedPeer'),
      grab('deferredCrossModelPeers'),
      grab('crossModelRateLimited'),
      grab('seatRateLimitKey'),
      grab('crossModelPeerStatus'),
      grab('enforceCrossModelGate'),
      grab('classifyBlock'),
      grab('infraTerminalCause'),
      'return { deferredCrossModelPeers, rateLimitedPeer, crossModelRateLimited,' +
        ' seatRateLimitKey, crossModelPeerStatus, enforceCrossModelGate, classifyBlock, infraTerminalCause }',
    ].join('\n'),
  ) as () => Real
  return factory()
}

const DIFF = '--- a/x.ts\n+++ b/x.ts\n@@\n-const a = 1\n+const a = 2\n'
const KEY = 'sk-kimi-synthetic'

function fetchStatus(status: number, body: unknown = { error: 'rate limited' }): KimiFetch {
  return async () => ({ ok: false, status, text: async () => JSON.stringify(body) })
}

/**
 * A harvested, failed row carrying the workflow's own infra-only terminal result —
 * with the columns the WRITE SITE actually produces for one.
 *
 * `inner_verdict: 'REVIEW_NOT_RUN'` is not decoration: `recordedTerminalVerdict`
 * refuses REQUEST_CHANGES for an 'infra-only' block, so that is what the row carries
 * in production, and with a review-capable checkpoint the disposition is
 * `built-never-reviewed`. Getting this wrong is what made the first version of the
 * ordering test unfalsifiable — see the note on that test.
 */
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
    inner_verdict: 'REVIEW_NOT_RUN',
    inner_checkpoint: 'argus-request-changes-round-1',
    inner_result: JSON.stringify({
      ok: false,
      verdict: 'REQUEST_CHANGES',
      round: 1,
      checkpoint: 'argus-request-changes-round-1',
      blockKind: 'infra-only',
      terminalCause: cause,
    }),
    failure_reason: `review never ran (infra-only) at round 1 of 10: ${cause}`,
    ...overrides,
  })
}

/**
 * THE SAME REASON ON A ROW THE COLUMNS CANNOT JUDGE (`not-terminal` — no terminal
 * phase recorded, so `deriveInfraBlock` returns null by its `phase === 'failed'`
 * gate). This is the ONLY fixture on which `delivery.ts`'s bare-token arm is
 * reachable at all, which makes it the only one where asserting "not a review
 * outcome" can fail. See the ordering tests.
 *
 * THE PHASE IS `'argus'`, NOT `'running'`. The first draft wrote `'running'`, which is
 * not a member of `TridentPhase` at all (`trident/store.ts:33` — the vocabulary is
 * forge-init / ralph-plan / ralph-task / argus / forge-fix / done / failed / stopped,
 * and the table's CHECK constraint is built from exactly that list). A fixture
 * describing a state the schema forbids cannot stand in for a real row, and the type
 * error was the schema saying so. `'argus'` is both legal and the honest choice: it is
 * the review phase, which is precisely when a cross-model seat gets refused. It is
 * non-terminal (`TERMINAL_PHASES` is `['done','failed','stopped']`), which is the
 * property this fixture needs.
 */
function inFlightRun(cause: string): TridentRun {
  return makeTridentRun({
    id: 'run-2',
    slug: 'add-flag',
    project_slug: 'proj-1',
    phase: 'argus',
    branch: 'trident/add-flag',
    repo_path: '/repo',
    task: 'add a feature flag',
    failure_reason: `review never ran (infra-only) at round 1 of 10: ${cause}`,
  })
}

describe('#542 the producer — a 429 is measured as itself, without leaving `deferred`', () => {
  test('HEADLINE: a 429 sets rateLimited and names the status; the status still BLOCKS', async () => {
    const r = await reviewWithKimi({
      diff: DIFF,
      task: 'bump a',
      apiKey: KEY,
      fetchImpl: fetchStatus(RATE_LIMIT_HTTP),
    })
    // The status is unchanged on purpose — this is what every gate in the workflow
    // reads, and 'deferred' is the true answer to the only question it asks.
    expect(r.status).toBe('deferred')
    expect(r.text).toBe('')
    // ...and the NEW fact, which is what makes the failure reportable.
    expect(r.rateLimited).toBe(true)
    expect(r.reason).toContain('429')
    expect(r.reason).toContain('NO REVIEW WAS PERFORMED')
  })

  test('HEADLINE: and it asserts NOTHING about the account — 429 cannot carry that', () => {
    // THE CONTRADICTION THIS PINS. `trident/kimi-usage-probe.ts` excludes 429 from
    // `isPermanentRejection` with its reason written out: a rate limit means "ask
    // again later", not "this request is wrong". An earlier draft of this lane said
    // the opposite — "the account has no allowance left to spend" — from the SAME
    // status code, so trident asserted transience in one module and depletion in
    // another over one observation. The reason must offer both and conclude neither.
    return reviewWithKimi({
      diff: DIFF,
      task: 'bump a',
      apiKey: KEY,
      fetchImpl: fetchStatus(RATE_LIMIT_HTTP),
    }).then((r) => {
      const reason = r.reason ?? ''
      expect(reason).toContain('does not say whether')
      expect(reason).toContain('rate limit')
      expect(reason).toContain('no allowance left')
      // It may NAME depletion as one possibility; it may not ASSERT it. The
      // difference is the hedge, so the hedge is what is asserted.
      expect(/\bthe account has no allowance left\b/.test(reason)).toBe(false)
      // And it points at the module that already settled the reading, so the next
      // reader finds the doctrine rather than re-deciding it.
      expect(reason).toContain('kimi-usage-probe')
    })
  })

  test('EVERY OTHER non-ok status is unflagged — a rejected key is not a rate limit', async () => {
    for (const status of [401, 403, 500, 502, 529]) {
      const r = await reviewWithKimi({
        diff: DIFF,
        task: 'bump a',
        apiKey: KEY,
        fetchImpl: fetchStatus(status),
      })
      expect(r.status).toBe('deferred')
      expect(r.rateLimited).toBeUndefined()
      expect(r.reason).toContain(String(status))
    }
  })

  test('NO OTHER reason string mentions 429 — the precondition the CLI marker relies on', async () => {
    // WHY THIS EXISTS, stated plainly. The CLI emits its marker from the FACT FIELD
    // rather than from `reason`, and that is the more robust of the two — but MEASURED
    // (mutation N16): keying it on `reason.includes('429')` instead is behaviourally
    // IDENTICAL today, because every other reason is built from a status code that is
    // not 429 and no reason quotes a response body. No behavioural test can separate
    // them while that holds. So the invariant it silently depends on is checked HERE
    // instead of assumed: the moment any other failure's reason starts carrying a
    // number or a body that could contain "429", this test reds and names the risk.
    const cases = await Promise.all(
      [401, 403, 404, 500, 502, 529].map((status) =>
        reviewWithKimi({ diff: DIFF, task: 'bump a', apiKey: KEY, fetchImpl: fetchStatus(status) }),
      ),
    )
    for (const r of cases) {
      expect(r.reason ?? '').not.toContain('429')
      expect(r.rateLimited).toBeUndefined()
    }
    // The answerless-200 trap and the empty diff, same rule.
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
    expect(answerless.reason ?? '').not.toContain('429')
    const empty = await reviewWithKimi({ diff: '', task: 'bump a', apiKey: KEY, fetchImpl: fetchStatus(200) })
    expect(empty.reason ?? '').not.toContain('429')
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
    expect(thrown.rateLimited).toBeUndefined()

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
    expect(answerless.rateLimited).toBeUndefined()
  })
})

describe('#542 the CLI — RUN as a subprocess: the marker means 429 and nothing else', () => {
  /**
   * Run the REAL CLI against a local server that answers with `status`.
   *
   * `KIMI_BASE_URL` is read from the environment by `kimi-review.ts`, so no stubbing
   * is needed and nothing about the production path is bypassed: a real process, a
   * real fetch, the real exit code, the real stderr. This is what the two tests it
   * replaces could not do — they asserted a substring existed in the source file and
   * executed nothing, which left the dangerous mutation alive.
   */
  /**
   * The child's environment, with `KIMI_API_KEY` PRESENT or PROVABLY ABSENT.
   *
   * `delete`ing the key off a copy is what makes "absent" mean absent regardless of what
   * the parent carries, so the not_connected boundary is a property of this function
   * rather than of the machine the suite happens to run on.
   */
  function childEnv(apiKey: string | null, port: number): Record<string, string> {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    env['KIMI_BASE_URL'] = `http://127.0.0.1:${port}`
    if (apiKey === null) delete env['KIMI_API_KEY']
    else env['KIMI_API_KEY'] = apiKey
    return env
  }

  async function runCli(opts: {
    status?: number
    body?: string
    apiKey?: string | null
    /** Stop the server before spawning, so the connection is REFUSED — a genuine
     *  transport failure rather than a 5xx, which is a different arm of the CLI. */
    refuseConnection?: boolean
  }): Promise<{ exitCode: number; stderr: string; stdout: string }> {
    const server = Bun.serve({
      port: 0,
      fetch(): Response {
        return new Response(opts.body ?? JSON.stringify({ error: 'nope' }), {
          status: opts.status ?? 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    // `server.port` is `number | undefined` in Bun's types, and a bound port we cannot
    // read is a test that cannot address its own server — so it fails here, loudly,
    // rather than interpolating `undefined` into the URL and timing out mysteriously.
    const { port } = server
    if (port === undefined) {
      server.stop(true)
      throw new Error('the local review server reported no port')
    }
    if (opts.refuseConnection === true) server.stop(true)
    const diff = `${Bun.env['TMPDIR'] ?? '/tmp'}/kimi-cli-${Bun.nanoseconds()}.diff`
    await Bun.write(diff, DIFF)
    try {
      const proc = Bun.spawn(
        ['bun', 'run', new URL('../kimi-review-cli.ts', import.meta.url).pathname, diff, 'bump a'],
        {
          cwd: new URL('../..', import.meta.url).pathname,
          // BUILT BY EXCLUSION, NOT BY OMISSION — and that distinction is the whole
          // correctness of the exit-10 case. Spreading `process.env` and then simply not
          // ADDING `KIMI_API_KEY` leaves the parent's value in place if the parent has
          // one: the child would then find a credential, reach the local server, and
          // exit 3 instead of 10. The test would still pass on a box with no
          // `KIMI_API_KEY` — passing for the wrong reason, which is the exact defect
          // shape this file exists to catch twice over. Reproducible with
          // `KIMI_API_KEY=parent-secret bun test …`, which is now a case below.
          env: childEnv(opts.apiKey === null ? null : (opts.apiKey ?? KEY), port),
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { exitCode, stderr, stdout }
    } finally {
      // Idempotent — already stopped on the refuseConnection path.
      server.stop(true)
    }
  }

  const MARKER = KIMI_RATE_LIMIT_TOKEN

  test('HEADLINE: a real 429 exits DEFERRED and emits the marker on its own line', async () => {
    const r = await runCli({ status: 429, body: JSON.stringify({ error: 'rate limited' }) })
    // Exit 3 is the shared deferred code — deliberately NOT a fourth code, because the
    // vocabulary is shared with `codex-review.sh`.
    expect(r.exitCode).toBe(3)
    expect(r.stderr).toContain(MARKER)
    // Its OWN line, so the workflow's `grep -q` cannot be defeated by where the
    // human sentence happens to wrap.
    expect(r.stderr.split('\n')).toContain(MARKER)
    // No review text on stdout — a refused call produced no review.
    expect(r.stdout).toBe('')
  }, 20_000)

  test('HEADLINE: 401, 403, 500, 502 and an answerless 200 are DEFERRED with NO marker', async () => {
    // THE MUTATION THIS KILLS. An unconditional `process.stderr.write(TOKEN)` anywhere
    // in `main` keeps a source-substring test green, and the workflow greps the WHOLE
    // stderr stream — so every rejected key and every 5xx would report as a rate limit
    // and send the operator to the provider's billing page over a bad credential.
    for (const status of [401, 403, 500, 502]) {
      const r = await runCli({ status })
      expect(r.exitCode).toBe(3)
      expect(r.stderr).toContain(String(status))
      expect(r.stderr).not.toContain(MARKER)
    }
    // The answerless-200 thinking-budget trap: deferred, and not a rate limit.
    const answerless = await runCli({
      status: 200,
      body: JSON.stringify({ content: [{ type: 'thinking', thinking: '...' }] }),
    })
    expect(answerless.exitCode).toBe(3)
    expect(answerless.stderr).not.toContain(MARKER)
  }, 40_000)

  test('a transport failure is DEFERRED with no marker, and a missing key is GRACEFUL', async () => {
    const dropped = await runCli({ refuseConnection: true })
    expect(dropped.exitCode).toBe(3)
    expect(dropped.stderr).not.toContain(MARKER)

    // No credential is exit 10, the graceful reduced-panel path, and never a rate limit.
    // The server would answer 429 if it were ever reached, so this ALSO proves the child
    // never called out: a leaked credential would exit 3 with the marker.
    const noKey = await runCli({ apiKey: null, status: 429 })
    expect(noKey.exitCode).toBe(10)
    expect(noKey.stderr).not.toContain(MARKER)
  }, 20_000)

  test('HEADLINE: the missing-credential case holds even when the PARENT has a key set', async () => {
    // THE DEFECT THIS PINS, and it is the third instance in this PR of one shape: a test
    // that passes for the wrong reason. The child env was built by spreading
    // `process.env` and then simply NOT ADDING `KIMI_API_KEY` — so on a box where the
    // parent HAS one, the child inherits it, reaches the server, and exits 3. The
    // exit-10 boundary above was a property of this machine rather than of the code.
    //
    // `childEnv` now DELETES the key instead of declining to set it, and this test
    // proves the difference by putting a value in the parent's own environment first.
    const saved = process.env['KIMI_API_KEY']
    process.env['KIMI_API_KEY'] = 'parent-secret-must-not-be-inherited'
    try {
      const noKey = await runCli({ apiKey: null, status: 429 })
      expect(noKey.exitCode).toBe(10)
      expect(noKey.stderr).not.toContain(MARKER)
      // ...and the parent's value never reached the child in any form.
      expect(noKey.stderr).not.toContain('parent-secret')
      expect(noKey.stdout).not.toContain('parent-secret')
      // The same run WITH a key explicitly supplied does reach the 429 server, so the
      // assertion above is measuring the deletion rather than a server that never answers.
      const withKey = await runCli({ apiKey: KEY, status: 429 })
      expect(withKey.exitCode).toBe(3)
      expect(withKey.stderr).toContain(MARKER)
    } finally {
      if (saved === undefined) delete process.env['KIMI_API_KEY']
      else process.env['KIMI_API_KEY'] = saved
    }
  }, 30_000)

  test('a real 200 review exits CONNECTED with the review on stdout and no marker', async () => {
    const r = await runCli({
      status: 200,
      body: JSON.stringify({ content: [{ type: 'text', text: 'fine\nVERDICT: APPROVE' }] }),
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('VERDICT: APPROVE')
    expect(r.stderr).not.toContain(MARKER)
  }, 20_000)

  test('BOTH HALVES MOVE TOGETHER: the token in the .mjs equals the exported one', () => {
    // The workflow body has no module resolution, so the token is a literal in two
    // files. A silent divergence makes every 429 decay into the generic deferral
    // row — safe, and exactly the bug.
    expect(grabConst('KIMI_RATE_LIMIT_TOKEN')).toContain(`'${KIMI_RATE_LIMIT_TOKEN}'`)
  })

  test('the review bridge actually GREPS for it and tells the model to copy the result verbatim', () => {
    // A fact only the model reads is a fact the workflow cannot act on — the reason
    // the codex bridge greps CODEX_REVIEW_DIFF_TRUNCATED rather than asking GPT-5.
    const prompt = grab('kimiReviewerPrompt')
    expect(prompt).toContain('grep -q ${shSingleQuote(KIMI_RATE_LIMIT_TOKEN)}')
    expect(prompt).toContain('KIMI_RATE_LIMITED=1')
    expect(prompt).toContain('KIMI_RATE_LIMITED=0')
    expect(prompt).toContain('kimiRateLimited: copy the KIMI_RATE_LIMITED line VERBATIM')
    // AND THE BRIDGE IS TOLD TO TITLE ITS FINDING BY THE MEASURED LINE. The prompt used
    // to hard-code `title:'Kimi review deferred'` for every exit 2/3 — one of the three
    // sentences this card removed from the operator's row for being false over a 429,
    // left standing at the surface the run's own reviewer reads.
    expect(prompt).toContain('Kimi review NOT PERFORMED — provider refused with HTTP 429')
    expect(prompt).toContain("do NOT write 'deferred' or 'failed'")
    expect(prompt).toContain('do NOT claim the account is out of credit')
    // THE DIRECTIVE ITSELF, not just the words it governs. Asserting only that the
    // honest title appears somewhere left a live mutation: re-adding an unconditional
    // "Title it 'Kimi review deferred'" ahead of it kept every one of the assertions
    // above true while restoring exactly the sentence this removed.
    expect(prompt).toContain('TITLE IT BY WHAT THE KIMI_RATE_LIMITED LINE SAYS')
    expect(prompt).not.toContain("Title it 'Kimi review deferred'")
    expect(prompt).not.toContain("title:'Kimi review deferred'")
    // ...and the schema must be able to carry it, or the bridge has nowhere to put it.
    expect(SRC).toContain('kimiRateLimited: {')
  })

  test('HEADLINE: the SYNTHESIS is told the truth too, not just the operator', () => {
    // The flag was read on the operator surface only, so over a 429 the synthesis model
    // was still handed "DEFERRED — configured but the review failed or returned no usable
    // verdict". The direction was safe — `enforceCrossModelGate` blocks deterministically,
    // never on this prose — but the run's own reviewer composing findings from a transport
    // fault that did not happen is how a wrong remedy gets written down.
    const body = SRC.slice(SRC.indexOf('const peerPanelLine ='), SRC.indexOf('const codexPanel ='))
    expect(body).toContain('rateLimited === true')
    expect(body).toContain('RATE LIMITED — the provider REFUSED the call with HTTP 429')
    expect(body).toContain('Nothing failed and nothing timed out')
    // It must still refuse an APPROVE, and still not assert a cause.
    expect(body).toContain('Do NOT return APPROVE')
    expect(body).toContain('do NOT assert either')
    // ...and both seats must actually pass the flag in, derived from their own route.
    expect(SRC).toContain('crossModelRateLimited(codexSlot, verdicts, seatRateLimitKey(slotOneRoute.group)))')
    expect(SRC).toContain('crossModelRateLimited(kimiSlot, verdicts, seatRateLimitKey(slotTwoRoute.group)))')
  })

  test('the CODEX schema still CANNOT carry the flag — the follow-up is three steps, not zero', () => {
    // The docblock used to claim "no second code path to add". It is not true yet, and
    // the failure mode of believing it is bad: `CODEX_VERDICT_SCHEMA` is
    // `additionalProperties: false`, so a bridge that sets `codexRateLimited` BEFORE
    // the schema is widened has its WHOLE verdict rejected — the seat degrades from
    // "429, honest row" to "dead seat, generic row", strictly worse than today. This
    // test is the tripwire: widen the schema and it reds, telling whoever does it to
    // correct the note that describes the order.
    const codexSchema = SRC.slice(
      SRC.indexOf('const CODEX_VERDICT_SCHEMA = {'),
      SRC.indexOf('const KIMI_VERDICT_SCHEMA = {'),
    )
    expect(codexSchema).toContain('additionalProperties: false')
    expect(codexSchema).not.toContain('codexRateLimited')
    expect(grab('codexReviewerPrompt')).not.toContain('codexRateLimited')
    // ...and the note says so, in order, rather than claiming nothing is missing.
    const note = grab('deferredCrossModelPeers')
    expect(SRC.slice(SRC.indexOf('// BOTH SEATS ARE SPELLED, ONE PATH'), SRC.indexOf(note))).toContain(
      'THE ORDER IS NOT OPTIONAL',
    )
  })
})

describe('#542 the honest row — a 429 refusal is reportable as itself', () => {
  test('HEADLINE: the title names HTTP 429, never says "deferred", and asserts no cause', () => {
    const { deferredCrossModelPeers } = loadReal()
    const [peer] = deferredCrossModelPeers({ codex: 'connected', kimi: 'deferred' }, {}, { kimi: true })
    expect(peer).toBeDefined()
    // The title IS the run's whole terminal cause, so this is the sentence the
    // operator ends up reading.
    expect(peer!.title).toContain('HTTP 429')
    expect(peer!.title).toContain('no review was performed')
    // A deferral is a review that declined to be given. This is a reviewer that was
    // refused, and the two have different remedies.
    expect(peer!.title.toLowerCase()).not.toContain('deferred')
    // AND IT DOES NOT ASSERT DEPLETION. `kimi-usage-probe.ts` treats 429 as transient;
    // a title claiming an empty account would make trident contradict itself over one
    // status code. The word may appear as a POSSIBILITY in the evidence, never as the
    // terminal cause the operator is handed.
    expect(peer!.title.toLowerCase()).not.toContain('quota exhausted')
    expect(peer!.title.toLowerCase()).not.toContain('no allowance left')
    expect(peer!.name).toBe('Kimi K3')
  })

  test('HEADLINE: the title never stutters "review", on any of the SIX composable routes', () => {
    // SIX routes are walked and only TWO are reachable in production today — a codex-family
    // slot one and a kimi-family slot two. The other four need a cross-model slot to hold
    // the other family, or a producer that sets the flag, which the three-step note on
    // `deferredCrossModelPeers` says does not exist yet for codex. Walking all six is
    // deliberate (the composition is what is under test, and the unreachable arms are
    // exactly where a stutter would sit unnoticed) but the count is stated honestly.
    // MEASURED REGRESSION. The row first composed its title as `${name} cross-model
    // review …`, which is right for a bare vendor name and wrong for the off-family
    // seats whose names ALREADY end in "review": slot one holding a kimi tier — the
    // exact configuration `seatRateLimitKey` exists for, reachable today — produced
    // "Cross-model review 1 (Kimi K3) cross-model review RATE LIMITED …". That string
    // is the terminal cause and reaches the operator verbatim.
    const { deferredCrossModelPeers } = loadReal()
    const routes: Array<[Record<string, unknown>, Record<string, boolean>]> = [
      [{}, { codex: true }],
      [{}, { kimi: true }],
      [{ codex: { group: 'kimi' } }, { codex: true }],
      [{ kimi: { group: 'codex' } }, { kimi: true }],
      [{ codex: { group: 'claude' } }, { codex: true }],
      [{ kimi: { group: 'claude' } }, { kimi: true }],
    ]
    for (const [route, flags] of routes) {
      const peers = deferredCrossModelPeers({ codex: 'deferred', kimi: 'deferred' }, route, flags)
      for (const peer of peers) {
        // The stutter is the SEAT PHRASE appearing twice, so that is what is counted —
        // not the bare word "review", which the honest suffix "no review was performed"
        // legitimately contains a second time.
        const hits = peer.title.toLowerCase().split('cross-model review').length - 1
        expect({ title: peer.title, seatPhraseOccurrences: hits }).toEqual({
          title: peer.title,
          seatPhraseOccurrences: 1,
        })
        // A label that never arrived would read as the word "undefined" in the sentence
        // the operator is handed — the first symptom of passing the wrong argument.
        expect(peer.title).not.toContain('undefined')
      }
    }
  })

  test('the evidence offers BOTH remedies and concludes NEITHER', () => {
    const { deferredCrossModelPeers } = loadReal()
    const [peer] = deferredCrossModelPeers({ codex: 'connected', kimi: 'deferred' }, {}, { kimi: true })
    expect(peer!.evidence).toContain('WHAT 429 DOES NOT SAY')
    // BOTH POSSIBILITIES, EACH SPELLED OUT IN FULL. Matching the bare words 'rate limit'
    // and 'no allowance left' was not enough: the closing advice line contains "rate
    // limits AND its balance", so deleting the entire hedge clause left the test green
    // (measured — mutation N8). The two clauses are asserted verbatim instead.
    expect(peer!.evidence).toContain('a per-minute rate limit that clears on its own')
    expect(peer!.evidence).toContain('an account with no allowance left')
    // ...and the sentence that refuses to choose between them.
    expect(peer!.evidence).toContain('The provider does not distinguish them and neither')
    expect(peer!.evidence).toContain('rather than assuming either')
    // It points at the module that already settled the reading, so the next reader
    // finds the doctrine instead of re-deciding it.
    expect(peer!.evidence).toContain('kimi-usage-probe')
    // The old row's three claims, all false over a 429, stay retracted.
    expect(peer!.evidence).toContain('NOTHING failed and nothing timed')
  })

  test('and it is NOT the row a real transport failure gets — the flag is what switches', () => {
    const { deferredCrossModelPeers } = loadReal()
    const [plain] = deferredCrossModelPeers({ codex: 'connected', kimi: 'deferred' }, {})
    expect(plain!.title).toContain('DEFERRED')
    expect(plain!.title).not.toContain('429')
  })

  test('the row is ONE function serving every slot and family — no fourth sentence', () => {
    const { deferredCrossModelPeers, rateLimitedPeer } = loadReal()
    const [slotOne] = deferredCrossModelPeers({ codex: 'deferred', kimi: 'connected' }, {}, { codex: true })
    expect(slotOne).toEqual(rateLimitedPeer('Codex', 'Codex cross-model review'))
    // Slot two carrying a codex tier instead of kimi — the seats are slots, not vendors.
    const [slotTwo] = deferredCrossModelPeers(
      { codex: 'connected', kimi: 'deferred' },
      { kimi: { group: 'codex' } },
      { kimi: true },
    )
    expect(slotTwo).toEqual(
      rateLimitedPeer('Cross-model review 2 (Codex)', 'Cross-model review 2 (Codex)'),
    )
    // Both seats refused at once is two rows, not one.
    expect(
      deferredCrossModelPeers({ codex: 'deferred', kimi: 'deferred' }, {}, { codex: true, kimi: true }),
    ).toHaveLength(2)
  })

  test('HEADLINE: the generic row and the 429 row share ONE label expression', () => {
    // THE COMMENT CLAIMED THIS AND THE CODE DID NOT DO IT. `offFamily` was hoisted and
    // described as anti-drift protection while the generic rows went on recomposing the
    // same expression inline — a comment asserting a guarantee that did not exist, which
    // is the third time this card has had to retract one. It is real now, and this is the
    // assertion that keeps it real: both rows for the same seat must carry the identical
    // label, so recomposing either inline (and drifting a space, a word, a family name)
    // reds here instead of reaching an operator.
    const { deferredCrossModelPeers } = loadReal()
    for (const route of [
      { codex: { group: 'kimi' } },
      { codex: { group: 'claude' } },
    ]) {
      const generic = deferredCrossModelPeers({ codex: 'deferred', kimi: 'connected' }, route, {})[0]
      const limited = deferredCrossModelPeers({ codex: 'deferred', kimi: 'connected' }, route, { codex: true })[0]
      expect(generic).toBeDefined()
      expect(limited).toBeDefined()
      expect(generic!.name).toBe(limited!.name)
      expect(generic!.title.startsWith(`${generic!.name} `)).toBe(true)
      expect(limited!.title.startsWith(`${generic!.name} `)).toBe(true)
    }
    for (const route of [
      { kimi: { group: 'codex' } },
      { kimi: { group: 'claude' } },
    ]) {
      const generic = deferredCrossModelPeers({ codex: 'connected', kimi: 'deferred' }, route, {})[0]
      const limited = deferredCrossModelPeers({ codex: 'connected', kimi: 'deferred' }, route, { kimi: true })[0]
      expect(generic!.name).toBe(limited!.name)
      expect(limited!.title.startsWith(`${generic!.name} `)).toBe(true)
    }
  })

  test('a CONNECTED or NOT_CONNECTED seat writes no row at all, flag or no flag', () => {
    const { deferredCrossModelPeers } = loadReal()
    // The flag only ever refines a row that already exists. A flag on a seat that
    // ANSWERED must not manufacture a block out of nothing.
    expect(deferredCrossModelPeers({ codex: 'connected', kimi: 'connected' }, {}, { kimi: true })).toEqual([])
    expect(
      deferredCrossModelPeers({ codex: 'not_connected', kimi: 'not_connected' }, {}, { codex: true, kimi: true }),
    ).toEqual([])
  })
})

describe('#542 unknown authorises nothing — every non-`true` flag falls back to the deferral row', () => {
  test('absent, undefined, null, a string, 1, and a dead seat all read as NOT rate-limited', () => {
    const { crossModelRateLimited, deferredCrossModelPeers } = loadReal()
    // The flag travels through a bridge agent copying a grepped line into a schema
    // field. A missing field, a stringified 'true', a null: every one of those is a
    // flag that did not arrive, and an unknown cause must fall back to the row that
    // assumes LESS. That row blocks identically — only the reporting differs, and
    // asserting a billing fact nobody measured is the same defect wearing the other hat.
    for (const v of [undefined, null, 'true', 1, {}, 0, false]) {
      expect(crossModelRateLimited(1, [null, { kimiRateLimited: v }], 'kimiRateLimited')).toBe(false)
    }
    expect(crossModelRateLimited(1, [null, { kimiRateLimited: true }], 'kimiRateLimited')).toBe(true)
    // A seat that produced NO verdict at all is 'deferred' (crossModelPeerStatus) and
    // unflagged: it is a dead lane, not a billing fact.
    expect(crossModelRateLimited(1, [null, null], 'kimiRateLimited')).toBe(false)
    expect(crossModelRateLimited(1, [], 'kimiRateLimited')).toBe(false)
    // An unconfigured seat has no failure to explain.
    expect(crossModelRateLimited(null, [{ kimiRateLimited: true }], 'kimiRateLimited')).toBe(false)
    // ...and the row that results from an unflagged deferral is the generic one.
    const [peer] = deferredCrossModelPeers({ codex: 'connected', kimi: 'deferred' }, {}, { kimi: false })
    expect(peer!.title).toContain('DEFERRED')
  })

  test('the rate-limit key comes from the ROUTE, never from the slot name', () => {
    const { seatRateLimitKey, crossModelRateLimited } = loadReal()
    // Either slot can hold either family, so `codexSlot` holding a kimi tier is an
    // ordinary configuration. Hard-coding 'codexRateLimited' for slot one would
    // read a field that verdict never carries and restore the bug on that route.
    expect(seatRateLimitKey('kimi')).toBe('kimiRateLimited')
    expect(seatRateLimitKey('codex')).toBe('codexRateLimited')
    // A claude seat fills VERDICT_SCHEMA, which has no such field and no provider to
    // be refused by — its credential is the session's own. `null` says so.
    expect(seatRateLimitKey('claude')).toBe(null)
    expect(crossModelRateLimited(0, [{ kimiRateLimited: true }], seatRateLimitKey('claude'))).toBe(false)
    // ...and the derivation is what the call site actually uses, for BOTH slots.
    expect(SRC).toContain('crossModelRateLimited(codexSlot, verdicts, seatRateLimitKey(slotOneRoute.group))')
    expect(SRC).toContain('crossModelRateLimited(kimiSlot, verdicts, seatRateLimitKey(slotTwoRoute.group))')
    // AND THE LANE RETRY'S SLOT DESCRIPTORS MUST CARRY IT TOO. The retry reads
    // `rateLimitKey` off the slot it is given, so a descriptor built with a literal
    // `null` silently restores the immediate re-call of a rate-limited provider while
    // every behavioural retry test — which passes its own slots — stays green
    // (measured: mutation N12). This is the only observable for that wiring.
    for (const [slot, route] of [
      ['codexSlot', 'slotOneRoute'],
      ['kimiSlot', 'slotTwoRoute'],
    ] as Array<[string, string]>) {
      const descriptor = SRC.split('\n').find(
        (l) => l.includes(`slot: ${slot},`) && l.includes('statusKey:'),
      )
      expect(descriptor).toBeDefined()
      expect(descriptor).toContain(`rateLimitKey: seatRateLimitKey(${route}.group)`)
    }
  })
})

describe('#542 a 429 mid-panel does not mark the panel as having reviewed', () => {
  test('HEADLINE: the gate forces REQUEST_CHANGES, the block is infra-only, no round is bought', () => {
    const { deferredCrossModelPeers, enforceCrossModelGate, classifyBlock } = loadReal()
    const peers = deferredCrossModelPeers({ codex: 'connected', kimi: 'deferred' }, {}, { kimi: true })
    // A rate-limited seat is still a seat that produced no review, so it still
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
        { verdict: 'REQUEST_CHANGES', block_kind: 'infra-only', checkpoint: 'argus-request-changes-round-1', escalation: null },
        JSON.stringify(peers.map((p) => ({ severity: 'blocker', kind: 'lane', title: p.title }))),
      ),
    ).toBe('REVIEW_NOT_RUN')
  })

  test('the 429 title is the measured terminal cause the run carries out', () => {
    const { deferredCrossModelPeers, enforceCrossModelGate, infraTerminalCause } = loadReal()
    const peers = deferredCrossModelPeers({ codex: 'connected', kimi: 'deferred' }, {}, { kimi: true })
    const gated = enforceCrossModelGate({ verdict: 'APPROVE', findings: [] }, peers)
    const cause = infraTerminalCause(gated)
    expect(cause).toBe(peers[0]!.title)
    expect(cause).toContain('HTTP 429')
  })

})

describe('#542 the terminal reason names the refusal — not "deferred", not "exhausted N rounds"', () => {
  const title = (): string => loadReal().rateLimitedPeer('Kimi K3', 'Kimi K3 cross-model review').title

  test('HEADLINE: the stored reason quotes the 429 cause and licenses no review claim', () => {
    const reason = innerTerminalFailureReason(
      makeTridentRun({ round: 1, max_rounds: 10 }),
      // The parameter is a `Pick<InnerResult, …>` that includes `ok` and
      // `findings_present`; omitting them was a TS2345, and supplying them is also the
      // honest shape — an infra-only stop is not `ok` and carries no findings of its own.
      {
        ok: false,
        verdict: 'REQUEST_CHANGES',
        block_kind: 'infra-only',
        // NOT ESCALATING — a rate-limited provider is an infrastructure stop, and the
        // escalation branch must not fire on it.
        escalation: null,
        terminal_cause: title(),
        round: 1,
        checkpoint: null,
        findings_present: false,
      },
    )
    expect(reason).toContain('HTTP 429')
    expect(reason).toContain('no review was performed')
    // The generic round-budget sentence is what this replaces. It said ten rounds of
    // review had happened over a reviewer that was never reached.
    expect(reason).not.toContain('without Argus APPROVE')
    expect(reason).toContain('review never ran (infra-only)')
  })

  test('and it routes to the EXISTING infrastructure path, not to a genuine verdict', () => {
    // A 429 is an infrastructure cause, not a review opinion, so it spends a bounded
    // infra_retries unit against INFRA_RETRY_BACKOFF_MS rather than ending the run. A
    // per-minute rate limit clears inside that window for free; an exhausted allowance
    // burns three bounded retries and then terminates naming the refusal.
    expect(
      classifyInnerFailure({
        verdict: 'REQUEST_CHANGES',
        block_kind: 'infra-only',
        terminal_cause: title(),
        checkpoint: 'argus-request-changes-round-1',
      }),
    ).toBe('infrastructure')
  })

  test('HEADLINE: the operator is told infrastructure, NOT that a reviewer had findings', () => {
    const interp = interpretFailure(infraRun(title()))
    // 🚧 not ❌: the code was never rejected, it was never read.
    expect(interp.klass).toBe('infra-blocked')
    // The measured cause rides the summary VERBATIM, so the fact is reportable.
    expect(interp.summary).toContain('HTTP 429')
    expect(interp.summary).not.toContain('blocking findings')
  })

  /**
   * LAYER 1 OF THE ORDERING, ASSERTED POSITIVELY — and the positive form is the whole
   * point of this test.
   *
   * IT WAS WRITTEN AS A NEGATIVE FIRST AND IT COULD NOT FAIL. The original was
   * `expect(interp.klass).not.toBe('review-unresolved')` on this fixture, justified by
   * `delivery.ts` narrating a reason containing the token 'exhausted' as "the reviewer
   * still had blocking findings". MEASURED: replacing `deriveInfraBlock(run)` with
   * `null` — the maximal reversal of the ordering the test claimed to guard — left it
   * GREEN, because a terminal infra-only row's disposition is never
   * `reviewed-rejected` or `not-terminal`, so that arm is unreachable here under EVERY
   * ordering. The assertion was unsatisfiable, and it was cited as a guarantee in four
   * places. It is the same rule this change invoked to DELETE two guards, so it is
   * applied in this direction too.
   *
   * Asserting the class POSITIVELY is falsifiable: neuter `deriveInfraBlock` and the
   * row falls through to the `review never ran (infra-only)` string branch, which
   * answers `klass: 'infra'` — a different class, so this reds.
   */
  test('HEADLINE: the STRUCTURAL derivation is what classifies it, and neutering it reds this', () => {
    const interp = interpretFailure(infraRun(title()))
    expect(interp.klass).toBe('infra-blocked')
    // Pin the mechanism too: the class comes from the harvested columns, so a row with
    // the same reason but NOT harvested cannot reach it.
    expect(interpretFailure(infraRun(title(), { harvested_at: null })).klass).not.toBe('infra-blocked')
  })

  /**
   * LAYER 2 OF THE ORDERING, on the ONLY fixture where the dangerous arm is reachable.
   *
   * `delivery.ts` fires `review-unresolved` for a `not-terminal` row whose reason
   * contains a bare 'exhausted' / 'request_changes' / 'without argus approve' token.
   * The 429 title does not carry those words — which is itself deliberate — but the
   * reason it is embedded in is composed by the orchestrator, and the branch that
   * intercepts a `review never ran (infra-only)` reason sits ABOVE that arm. This is
   * what keeps such a row honest when the columns cannot judge it, and removing that
   * clause really does hand the row to `review-unresolved`, so this test can fail.
   */
  test('HEADLINE: a row the columns cannot judge is still infrastructure, not a review outcome', () => {
    const interp = interpretFailure(inFlightRun(title()))
    expect(interp.klass).toBe('infra')
    expect(interp.klass).not.toBe('review-unresolved')
    expect(interp.summary).not.toContain('blocking findings')
    // And the token that makes the arm dangerous really is live on this fixture — so
    // the assertion above is measuring the interception, not a fixture that misses.
    const withToken = interpretFailure(
      makeTridentRun({
        id: 'r3',
        slug: 's',
        project_slug: 'p',
        // Non-terminal and legal, for the same reason as `inFlightRun` above.
        phase: 'argus',
        repo_path: '/repo',
        task: 't',
        failure_reason: 'retries exhausted while doing something unrelated',
      }),
    )
    expect(withToken.klass).toBe('review-unresolved')
  })

  test('and the ADVICE names both possibilities instead of "retry once healthy"', () => {
    // BOTH HALVES MOVE TOGETHER: the shape delivery.ts matches is `rateLimitedPeer`'s
    // whole authored title, anchored at both ends — see the negative cases below for why
    // it is not the bare status code.
    const interp = interpretFailure(infraRun(title()))
    expect(interp.input_needed).toContain('HTTP 429')
    expect(interp.input_needed).toContain('rate limits')
    expect(interp.input_needed).toContain('balance')
    expect(interp.input_needed).toContain('rather than assuming either')
    expect(interp.input_needed).not.toContain('once the infrastructure is healthy')
    // Every OTHER infra cause keeps the generic line byte-for-byte.
    expect(interpretFailure(infraRun('the readiness probe could not be read')).input_needed).toContain(
      'once the infrastructure is healthy',
    )
  })

  /**
   * HEADLINE — THE ADVICE MAY NOT BE REACHED BY A CAUSE NO MODEL PROVIDER PRODUCED.
   *
   * This is the defect this whole card exists to remove, and an earlier revision
   * reintroduced it. The branch keyed on `c.includes('http 429')` under an absence claim
   * — "the token is authored by `rateLimitedPeer` and nowhere else" — that was FALSE.
   *
   * `infraTerminalCause` takes the first LANE finding's TITLE, and
   * `reviewPreconditionDeferred` composes its title as `REVIEW DEFERRED — PR readiness
   * could not be read: <probeCause(raw)>`, where `probeCause` quotes the first two lines
   * of `gh pr view` stdout+stderr VERBATIM and `raw` is agent-transcribed. GitHub's
   * secondary rate limit answers 403 OR 429 — which this repo already knows, since
   * `trident/git-mode.ts` matches `/\bhttp 429\b/` on `gh` output for exactly that
   * reason. So a GitHub refusal sent the operator to check a Kimi or Codex account's
   * balance, and `main` handled that same cause BETTER with its generic line.
   *
   * Three vectors, all three measured, all three must keep the generic advice.
   */
  test('HEADLINE: a GITHUB secondary rate limit keeps the generic line — no provider was involved', () => {
    // The exact shape `reviewPreconditionDeferred` composes from a `gh` refusal.
    const ghCause =
      'REVIEW DEFERRED — PR readiness could not be read: HTTP 429: You have exceeded a secondary ' +
      'rate limit and have been temporarily blocked from content creation. (https://api.github.com/graphql)'
    const interp = interpretFailure(infraRun(ghCause))
    // Still infrastructure — that part was always right, and comes from the columns.
    expect(interp.klass).toBe('infra-blocked')
    // ...but NOT the cross-model-provider advice.
    expect(interp.input_needed).toContain('once the infrastructure is healthy')
    expect(interp.input_needed).not.toContain('balance')
    expect(interp.input_needed).not.toContain('rate limits')
  })

  test('HEADLINE: a probe that ECHOES a prior run\'s title keeps the generic line', () => {
    // The anchor is what buys this one, and a bare `includes` of the authored PHRASE
    // would still fail it: `gh pr view` output can contain a previous run's terminal
    // cause verbatim, and `probeCause` quotes it into a new title. The quoting always
    // introduces a colon and an em dash before the phrase, neither of which the seat
    // label may contain — so the both-ends anchor rejects it.
    const echoed =
      'REVIEW DEFERRED — PR readiness could not be read: Kimi K3 cross-model review RATE LIMITED ' +
      '(HTTP 429) — no review was performed'
    expect(interpretFailure(infraRun(echoed)).input_needed).toContain('once the infrastructure is healthy')
  })

  test('HEADLINE: a THROWN workflow message quoting 429 keeps the generic line', () => {
    // `terminalCause: infraCause(thrownMessage)` is the third vector — arbitrary
    // workflow error text, quoted.
    for (const cause of [
      'forge:build failed: upstream said HTTP 429',
      'PR readiness could not be read: http 429',
      'rate limited (http 429) — no review was performed by something else entirely',
      'HTTP 429',
      // THE TAIL ANCHOR IS WHAT REJECTS THIS ONE, and it is not hypothetical:
      // `probeCause` joins the first TWO lines of `gh pr view` output with a SPACE, so a
      // quoted title on line 1 followed by anything at all on line 2 produces exactly
      // this shape. Without the `$` the authored sentence would match as a prefix of
      // arbitrary probe prose.
      'Kimi K3 cross-model review RATE LIMITED (HTTP 429) — no review was performed and then the probe said something else',
    ]) {
      expect(interpretFailure(infraRun(cause)).input_needed).toContain('once the infrastructure is healthy')
    }
  })

  test('HEADLINE: an EXACT-SHAPE IMPOSTOR with a label no seat owns keeps the generic line', () => {
    // THE SUBSTITUTION VECTOR, which the anchors alone did not close. `infraCause` hands a
    // THROWN workflow message through verbatim as a terminal cause, so a sentence in
    // exactly the authored shape but carrying a label no seat can produce used to match —
    // and the operator was again sent to check a model provider's balance for something no
    // seat authored. The previous fixtures covered a prefix and a suffix; this is the one
    // they omitted, and it is why the label is now a CLOSED SET rather than a shape.
    for (const cause of [
      'GitHub cross-model review RATE LIMITED (HTTP 429) — no review was performed',
      'The registry RATE LIMITED (HTTP 429) — no review was performed',
      'gh RATE LIMITED (HTTP 429) — no review was performed',
      // Near-misses on a REAL label: a seat number that does not exist, a family that is
      // not offered, a pluralised word. Each is one character-class hop from a real label.
      'Cross-model review 3 (Kimi K3) RATE LIMITED (HTTP 429) — no review was performed',
      'Cross-model review 1 (GPT) RATE LIMITED (HTTP 429) — no review was performed',
      'Codex cross-model reviews RATE LIMITED (HTTP 429) — no review was performed',
    ]) {
      expect({ cause, advice: interpretFailure(infraRun(cause)).input_needed }).toEqual({
        cause,
        advice: interpretFailure(infraRun('an unrecognised infrastructure cause')).input_needed,
      })
    }
  })

  test('HEADLINE: the matcher\'s label set is EXACTLY what the emitter can produce', () => {
    // BOTH HALVES MOVE TOGETHER, and this is what makes that true rather than asserted.
    // The labels are composed in `deferredCrossModelPeers`, a Workflow body with no module
    // resolution, so `delivery.ts` necessarily restates them. Drift is removed by deriving
    // the truth HERE — running the real emitter across every route, including groups it
    // does not recognise — and requiring the two sets to be identical. Add or rename a
    // seat and this reds, instead of that seat silently losing its advice.
    const { deferredCrossModelPeers } = loadReal()
    const emitted = new Set<string>()
    const groups = ['codex', 'kimi', 'claude', undefined, 'an-unknown-family']
    for (const g1 of groups) {
      for (const g2 of groups) {
        const route = {
          ...(g1 === undefined ? {} : { codex: { group: g1 } }),
          ...(g2 === undefined ? {} : { kimi: { group: g2 } }),
        }
        for (const peer of deferredCrossModelPeers(
          { codex: 'deferred', kimi: 'deferred' },
          route,
          { codex: true, kimi: true },
        )) {
          emitted.add(peer.title.replace(/ RATE LIMITED \(HTTP 429\) — no review was performed$/, ''))
        }
      }
    }
    // The set delivery.ts matches on, read out of its source so the test cannot drift from
    // it either.
    // Sliced from the `= [` rather than from the declaration, because the TYPE ANNOTATION
    // (`readonly string[]`) contains a `]` of its own — the first version of this test
    // stopped there and compared an empty set, which is a guard that cannot fail.
    const declAt = DELIVERY_SRC.indexOf('const CROSS_MODEL_SEAT_LABELS')
    expect(declAt).toBeGreaterThan(-1)
    const openAt = DELIVERY_SRC.indexOf('= [', declAt)
    const block = DELIVERY_SRC.slice(openAt, DELIVERY_SRC.indexOf(']', openAt))
    const matched = new Set([...block.matchAll(/'([^']+)'/g)].map((m) => m[1] as string))
    // Non-empty on both sides, or the comparison above proves nothing.
    expect(matched.size).toBe(CROSS_MODEL_SEAT_LABEL_COUNT)
    expect(emitted.size).toBe(CROSS_MODEL_SEAT_LABEL_COUNT)
    expect([...matched].sort()).toEqual([...emitted].sort())
    // And every one of them really does reach the specific advice.
    for (const label of emitted) {
      expect(
        interpretFailure(infraRun(`${label} RATE LIMITED (HTTP 429) — no review was performed`)).input_needed,
      ).toContain('rather than assuming either')
    }
  })

  test('...and the REAL title from every live seat label still reaches the specific advice', () => {
    // The anchor must not be so tight that it stops matching what it is for. Walked over
    // the labels `deferredCrossModelPeers` actually composes, so a label the anchor's
    // charset cannot express shows up here rather than as a silent fallback in production.
    const { deferredCrossModelPeers } = loadReal()
    const routes: Array<[Record<string, unknown>, Record<string, boolean>]> = [
      [{}, { codex: true }],
      [{}, { kimi: true }],
      [{ codex: { group: 'kimi' } }, { codex: true }],
      [{ kimi: { group: 'codex' } }, { kimi: true }],
      [{ codex: { group: 'claude' } }, { codex: true }],
      [{ kimi: { group: 'claude' } }, { kimi: true }],
    ]
    for (const [route, flags] of routes) {
      for (const peer of deferredCrossModelPeers({ codex: 'deferred', kimi: 'deferred' }, route, flags)) {
        if (!peer.title.includes('RATE LIMITED')) continue
        expect({ title: peer.title, advice: interpretFailure(infraRun(peer.title)).input_needed }).toEqual({
          title: peer.title,
          advice: interpretFailure(infraRun(title())).input_needed,
        })
      }
    }
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
        { verdict: 'REQUEST_CHANGES', block_kind: 'code', checkpoint: 'argus-request-changes-round-1', escalation: null },
        JSON.stringify([REAL_FINDING]),
      ),
    ).toBe('REQUEST_CHANGES')
  })

  test('and a rate-limited seat ALONGSIDE a real finding still buys the round', () => {
    // The lane row must not swallow the code work. `classifyBlock` asks "is there code
    // work here?" first, and a real blocker outranks a dead seat.
    const { classifyBlock, deferredCrossModelPeers, enforceCrossModelGate } = loadReal()
    const peers = deferredCrossModelPeers({ codex: 'connected', kimi: 'deferred' }, {}, { kimi: true })
    const gated = enforceCrossModelGate({ verdict: 'REQUEST_CHANGES', findings: [REAL_FINDING] }, peers)
    expect(classifyBlock(gated, peers)).toBe('code')
    expect(JSON.stringify(gated.findings)).toContain('null deref in parseThing')
  })

  test('and NOTHING about a rate-limited row can reach APPROVE', () => {
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
