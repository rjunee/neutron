/**
 * Per-lane retry + infra-only block classification (owner-reported, 2026-08-09).
 *
 * WHY THESE TESTS EVALUATE THE REAL FUNCTION BODIES RATHER THAN ASSERTING ON
 * SOURCE STRINGS. `inner-workflow.mjs` is a Workflow script and is deliberately
 * SELF-CONTAINED — zero imports — so these helpers cannot be extracted into a
 * module and imported here. The existing `inner-workflow.test.ts` copes by
 * grepping the source for required substrings, which is fine for "is this wired"
 * and useless for "does this behave". Retry logic is exactly the kind of thing a
 * substring check cannot verify: `attempts = 1` and `attempts = 0` both contain
 * the word `attempts`.
 *
 * So this pulls the two PURE function bodies out of the shipped file and runs
 * them. What is under test is the real code, not a copy that can drift.
 *
 * THE DEFECT THEY GUARD, measured on six runs on 2026-08-08 (~3.8M subagent
 * tokens, zero merges): a `deferred` cross-model lane means the CALL failed — a
 * timeout, an exit 3/5, a stale worktree path. There was NO retry anywhere in the
 * workflow, and the deferral was converted straight into a `blocker` FINDING about
 * the code. So one HTTP timeout ended a lane for the round, and the resulting
 * REQUEST_CHANGES sent the fix loop back to re-Forge and re-run ALL FOUR reviewers
 * — editing code to "fix" a network failure.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url)), 'utf8')

/**
 * Slice one top-level `function name(...) { … }` out of the script, brace-balanced.
 *
 * The body scan must start AFTER the parameter list closes. `retryDeferredPeers`
 * takes a DESTRUCTURED parameter — `({ verdicts, slots, … })` — so a naive "first
 * `{` after the name" balances on the parameter braces and slices the function in
 * half. That produced `SyntaxError: Unexpected token ';'` rather than anything that
 * pointed at the real cause.
 */
function extractFn(name: string): string {
  const start = SRC.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found in inner-workflow.mjs`)
  // Walk the parameter list to its matching close paren first.
  let paren = 0
  let i = SRC.indexOf('(', start)
  for (; i < SRC.length; i += 1) {
    if (SRC[i] === '(') paren += 1
    else if (SRC[i] === ')') {
      paren -= 1
      if (paren === 0) break
    }
  }
  let depth = 0
  for (let j = SRC.indexOf('{', i); j < SRC.length; j += 1) {
    if (SRC[j] === '{') depth += 1
    else if (SRC[j] === '}') {
      depth -= 1
      if (depth === 0) return SRC.slice(start, j + 1)
    }
  }
  throw new Error(`unbalanced braces for ${name}`)
}

// `async function` keeps its modifier because the slice starts at `function`; grab
// the preceding keyword when present so the retry helper stays awaitable.
function extractMaybeAsync(name: string): string {
  const body = extractFn(name)
  return SRC.includes(`async function ${name}(`) ? `async ${body}` : body
}

/**
 * Lift a top-level `const NAME = …` one-liner out of the source.
 *
 * `classifyBlock` closes over `LANE_FINDING_KIND` — the field name the gate STAMPS on a
 * lane blocker and the classifier READS. Re-declaring 'lane' here instead would let the
 * two drift apart with this file still green, which is the exact cannot-fail shape the
 * header above is about.
 */
function extractConst(name: string): string {
  const line = SRC.split('\n').find((l) => l.startsWith(`const ${name} =`))
  if (line === undefined) throw new Error(`const ${name} not found in inner-workflow.mjs`)
  return line
}

const PRELUDE = extractConst('LANE_FINDING_KIND')

const load = <T>(name: string, isAsync = false): T =>
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function(
    `${PRELUDE}\n${isAsync ? extractMaybeAsync(name) : extractFn(name)}; return ${name}`,
  )() as T

type Verdict = Record<string, unknown>
type RetryFn = (input: {
  verdicts: Verdict[]
  slots: Array<{ name: string; slot: number | null; statusKey: string }>
  invoke: (name: string) => Promise<Verdict | null>
  attempts?: number
  log?: (m: string) => void
}) => Promise<Verdict[]>
type ClassifyFn = (
  synthesis: { findings?: Array<{ title?: string; kind?: string }> } | null,
  deferred: Array<{ name: string }>,
) => string
type GateFn = (
  synthesis: unknown,
  peers: Array<{ name: string; title: string; evidence: string }>,
) => { verdict: string; findings: Array<{ kind?: string; title?: string }> } | null

const retryDeferredPeers = load<RetryFn>('retryDeferredPeers', true)
const classifyBlock = load<ClassifyFn>('classifyBlock')
const enforceCrossModelGate = load<GateFn>('enforceCrossModelGate')

const SLOTS = [
  { name: 'codex', slot: 0, statusKey: 'codexStatus' },
  { name: 'kimi', slot: 1, statusKey: 'kimiStatus' },
]

describe('retryDeferredPeers — retry the lane, not the round', () => {
  test('a DEFERRED lane is retried and its verdict replaced on success', async () => {
    const calls: string[] = []
    const out = await retryDeferredPeers({
      verdicts: [{ codexStatus: 'deferred' }, { kimiStatus: 'connected' }],
      slots: SLOTS,
      invoke: async (n) => {
        calls.push(n)
        return { codexStatus: 'connected', verdict: 'APPROVE' }
      },
    })
    expect(calls).toEqual(['codex'])
    expect(out[0]?.['codexStatus']).toBe('connected')
    // The healthy lane is untouched — not re-read, not replaced.
    expect(out[1]?.['kimiStatus']).toBe('connected')
  })

  test('a CONNECTED lane is never retried — that would spend a call to learn a known answer', async () => {
    const calls: string[] = []
    await retryDeferredPeers({
      verdicts: [{ codexStatus: 'connected' }, { kimiStatus: 'connected' }],
      slots: SLOTS,
      invoke: async (n) => {
        calls.push(n)
        return null
      },
    })
    expect(calls).toEqual([])
  })

  test('a NOT_CONNECTED lane is never retried — it is the deliberate graceful path', async () => {
    // Retrying this would turn "you never configured codex" into repeated failures.
    const calls: string[] = []
    await retryDeferredPeers({
      verdicts: [{ codexStatus: 'not_connected' }, { kimiStatus: 'not_connected' }],
      slots: SLOTS,
      invoke: async (n) => {
        calls.push(n)
        return null
      },
    })
    expect(calls).toEqual([])
  })

  test('a lane still deferred after its retries KEEPS the original verdict, so the gate still blocks', async () => {
    const out = await retryDeferredPeers({
      verdicts: [{ codexStatus: 'deferred', marker: 'first-failure' }],
      slots: [SLOTS[0]!],
      invoke: async () => ({ codexStatus: 'deferred', marker: 'second-failure' }),
    })
    // Still deferred ⇒ the gate refuses APPROVE. That is the point: retrying must
    // not become a way to launder a dead lane into a pass.
    expect(out[0]?.['codexStatus']).toBe('deferred')
  })

  test('an agent that THROWS does not crash the round, and the original is kept', async () => {
    const out = await retryDeferredPeers({
      verdicts: [{ codexStatus: 'deferred', marker: 'original' }],
      slots: [SLOTS[0]!],
      invoke: async () => {
        throw new Error('agent died')
      },
    })
    expect(out[0]?.['marker']).toBe('original')
    expect(out[0]?.['codexStatus']).toBe('deferred')
  })

  test('a retry returning null or a status-less object is discarded, not written through', async () => {
    // A dead agent resolves to null in this workflow's `parallel`; writing that in
    // would erase the evidence naming the first failure.
    const nulled = await retryDeferredPeers({
      verdicts: [{ codexStatus: 'deferred', marker: 'original' }],
      slots: [SLOTS[0]!],
      invoke: async () => null,
    })
    expect(nulled[0]?.['marker']).toBe('original')
    const shapeless = await retryDeferredPeers({
      verdicts: [{ codexStatus: 'deferred', marker: 'original' }],
      slots: [SLOTS[0]!],
      invoke: async () => ({ verdict: 'APPROVE' }),
    })
    expect(shapeless[0]?.['marker']).toBe('original')
  })

  test('attempts is BOUNDED — a permanently dead lane fails fast rather than stalling the round', async () => {
    let n = 0
    await retryDeferredPeers({
      verdicts: [{ codexStatus: 'deferred' }],
      slots: [SLOTS[0]!],
      attempts: 2,
      invoke: async () => {
        n += 1
        return { codexStatus: 'deferred' }
      },
    })
    expect(n).toBe(2)
  })

  test('a null slot (peer not configured this run) is skipped without a call', async () => {
    const calls: string[] = []
    await retryDeferredPeers({
      verdicts: [{ codexStatus: 'deferred' }],
      slots: [{ name: 'kimi', slot: null, statusKey: 'kimiStatus' }],
      invoke: async (n) => {
        calls.push(n)
        return null
      },
    })
    expect(calls).toEqual([])
  })
})

describe('classifyBlock — is this about the code, or about a lane that could not run?', () => {
  // BUILT BY THE REAL GATE, not hand-written. A lane blocker is now identified by the
  // `kind` FIELD the gate stamps rather than by re-deriving its title template and
  // string-matching it — two sites agreeing on a message format is a contract nothing
  // enforces, and a reworded title would have silently reclassified every lane failure
  // as a code finding. Constructing the fixture with `enforceCrossModelGate` means this
  // suite fails the moment the producer and the reader disagree.
  const deferral = (name: string) =>
    enforceCrossModelGate({ verdict: 'APPROVE', findings: [] }, [
      { name, title: `${name} cross-model review DEFERRED — refusing to silently APPROVE`, evidence: 'x' },
    ])!.findings[0]!

  test('deferral findings ONLY ⇒ infra-only', () => {
    expect(
      classifyBlock({ findings: [deferral('Kimi K3')] }, [{ name: 'Kimi K3' }]),
    ).toBe('infra-only')
  })

  test('a deferral PLUS a real code finding ⇒ code — the loop must still re-Forge', () => {
    // The dangerous misclassification: treating this as infra-only would silently
    // drop a genuine blocker and stop the fix loop with the bug still in the diff.
    expect(
      classifyBlock(
        { findings: [deferral('Codex'), { title: 'Null deref in the reap path' }] },
        [{ name: 'Codex' }],
      ),
    ).toBe('code')
  })

  test('no deferrals at all ⇒ code, whatever the findings are', () => {
    expect(classifyBlock({ findings: [{ title: 'Missing test' }] }, [])).toBe('code')
    expect(classifyBlock({ findings: [] }, [])).toBe('code')
  })

  test('two deferrals and nothing else ⇒ still infra-only', () => {
    expect(
      classifyBlock({ findings: [deferral('Codex'), deferral('Kimi K3')] }, [
        { name: 'Codex' },
        { name: 'Kimi K3' },
      ]),
    ).toBe('infra-only')
  })

  test('a findings-less synthesis with a deferral is infra-only, not a crash', () => {
    expect(classifyBlock(null, [{ name: 'Codex' }])).toBe('infra-only')
    expect(classifyBlock({}, [{ name: 'Codex' }])).toBe('infra-only')
  })
})

describe('the fix loop honours the classification', () => {
  test('the loop condition excludes an infra-only block', () => {
    // WEAKER THAN THE ABOVE, and labelled so: this is a source check, because the
    // loop is inside the script's top-level body and cannot be invoked in
    // isolation. It asserts the wiring only — the behaviour of the classifier
    // itself is covered above.
    expect(SRC).toContain("synthesis.blockKind !== 'infra-only'")
    // And the terminal result must SURFACE it, or an operator reads a lane failure
    // as a code rejection — which is exactly what made the 2026-08-08 run
    // summaries misleading.
    expect(SRC).toContain('blockKind:')
  })

  test('the retry runs BEFORE the verdicts are read', () => {
    // Anchored on the FIRST read of the verdict array in the completeness derivation.
    // It used to anchor on `const claudeVerdicts =`, which was a DEAD binding — declared
    // and never used — so this assertion was pinned to a line that could be deleted
    // without changing any behaviour.
    const retryAt = SRC.indexOf('retryDeferredPeers({')
    const readAt = SRC.indexOf('const missingCore = missingCoreReviewers(')
    expect(retryAt).toBeGreaterThan(-1)
    expect(readAt).toBeGreaterThan(retryAt)
  })
})

/**
 * A CONFIGURED SEAT THAT PRODUCED NOTHING IS A DEFERRED LANE — so it is RETRYABLE.
 *
 * The loop used to `break` on `!current`, so a peer whose agent DIED (slot assigned,
 * `verdicts[slot]` null) was neither retried nor gated: the caller then read the same
 * null as 'not_connected' and the panel could APPROVE with an empty seat. Retrying is
 * the cheapest possible remedy — one call, versus a whole round of four reviewers.
 *
 * The `slot === null` skip above is what keeps the ABSENT case free: a peer with no
 * credential never enters `slots`, so nothing here can spend a call on it.
 */
describe('retryDeferredPeers — a DEAD lane (null verdict on a configured slot) is retryable', () => {
  test('a null verdict on a configured slot IS retried, and a good retry replaces it', async () => {
    const calls: string[] = []
    const out = await retryDeferredPeers({
      verdicts: [null as unknown as Verdict, { kimiStatus: 'connected' }],
      slots: SLOTS,
      invoke: async (n) => {
        calls.push(n)
        return { codexStatus: 'connected', verdict: 'APPROVE' }
      },
    })
    expect(calls).toEqual(['codex'])
    expect(out[0]?.['codexStatus']).toBe('connected')
  })

  test('an UNDEFINED verdict (the slot never got written) is retried too', async () => {
    const calls: string[] = []
    await retryDeferredPeers({
      verdicts: [{ codexStatus: 'connected' }],
      slots: SLOTS,
      invoke: async (n) => {
        calls.push(n)
        return null
      },
    })
    expect(calls).toEqual(['kimi'])
  })

  test('a verdict object MISSING its status field is retried — a malformed reply is not an answer', async () => {
    const calls: string[] = []
    await retryDeferredPeers({
      verdicts: [{ verdict: 'APPROVE', findings: [] }, { kimiStatus: 'connected' }],
      slots: SLOTS,
      invoke: async (n) => {
        calls.push(n)
        return null
      },
    })
    expect(calls).toEqual(['codex'])
  })

  test('a dead lane whose retry ALSO dies stays dead — the round is not silently healed', async () => {
    const out = await retryDeferredPeers({
      verdicts: [null as unknown as Verdict],
      slots: [SLOTS[0]!],
      attempts: 2,
      invoke: async () => null,
    })
    // Still nothing at the slot, so `crossModelPeerStatus` reports 'deferred' and the
    // gate blocks. The remedy for an unrecoverable lane is a block, never a default.
    expect(out[0]).toBeNull()
  })

  test('a dead lane is retried at most `attempts` times', async () => {
    let n = 0
    await retryDeferredPeers({
      verdicts: [null as unknown as Verdict],
      slots: [SLOTS[0]!],
      attempts: 3,
      invoke: async () => {
        n += 1
        return null
      },
    })
    expect(n).toBe(3)
  })

  test('an ABSENT peer (no slot) is still never retried — the reduced panel costs nothing', async () => {
    const calls: string[] = []
    await retryDeferredPeers({
      verdicts: [{ codexStatus: 'connected' }],
      slots: [{ name: 'kimi', slot: null, statusKey: 'kimiStatus' }],
      invoke: async (n) => {
        calls.push(n)
        return null
      },
    })
    expect(calls).toEqual([])
  })
})
