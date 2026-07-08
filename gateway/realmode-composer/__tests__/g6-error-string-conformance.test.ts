/**
 * G6 — Substrate error-string classifier CONFORMANCE tests (Phase-0 guardrail).
 *
 * The credential-pool health classifiers in the Open composer are regexes that
 * match adapter/substrate error-message PROSE:
 *
 *   - parseHttpStatusFromMessage   (build-llm-call-substrate.ts)
 *   - detectBinaryNotFound         (build-llm-call-substrate.ts)
 *   - detectChannelWedged          (build-llm-call-substrate.ts)
 *   - detectTurnTimeout            (build-llm-call-substrate.ts)
 *   - isFreezeTimeout              (build-live-agent-turn.ts)
 *   - is429ErrorMessage            (onboarding/history-import/rate-limit.ts)
 *
 * The EXISTING behaviour tests (build-llm-call-substrate.test.ts:492/523/562/585,
 * cli-auth-failure-classification.test.ts) feed the classifiers a HAND-COPIED
 * literal through a fake substrate — so if a PRODUCER is reworded
 * (`ChannelWedgedSpawnError`'s message, the gpt-5-5 adapter's `HTTP <status>:`
 * template, the substrate's `persistent-repl: turn timeout` literal…) the
 * behaviour test stays GREEN while production silently reclassifies the failure
 * into a false credential cooldown. That is the exact "mock past the seam"
 * failure class §2.8 of the refactor plan warns against.
 *
 * These tests close the gap: they GENERATE each error at its REAL producer
 * throw-site — by INVOKING the producer (`startResponsesStream`,
 * `new ChannelWedgedSpawnError(...)`, `assertReplAlive(...)`, `Bun.spawn(...)`),
 * or, for a bare string-literal / template producer that cannot be invoked in
 * isolation, by EXTRACTING the exact literal FROM the producer's own source
 * text — then assert the classifier verdict against that real string. A reword
 * on EITHER side (producer or classifier) fails LOUDLY instead of silently
 * flipping the health verdict.
 *
 * Where a producer is an EXTERNAL adapter/SDK/runtime (Bun's spawn, node's
 * child_process, the Anthropic Messages API error envelope) the exact current
 * wording is pinned with a comment naming the producer, per §G6.
 *
 * §2.4 ratchet: this is a Phase-0 characterization suite — change only with an
 * explicit PR-body note + Fable synthesis sign-off.
 *
 * O3 later migrates these classifiers to typed error codes AGAINST these tests.
 */

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  detectBinaryNotFound,
  detectChannelWedged,
  detectTurnTimeout,
  parseHttpStatusFromMessage,
  BINARY_NOT_FOUND_MESSAGE,
  CHANNEL_WEDGED_MESSAGE,
} from '../build-llm-call-substrate.ts'
import { isFreezeTimeout } from '../build-live-agent-turn.ts'
import { is429ErrorMessage } from '../../../onboarding/history-import/rate-limit.ts'
import { startResponsesStream } from '../../../runtime/adapters/gpt-5-5-api/responses-stream.ts'
import { ChannelWedgedSpawnError } from '../../../runtime/adapters/claude-code/persistent/channel-wedge-respawn.ts'
import {
  assertReplAlive,
  type SpawnAssertionDeps,
  type SpawnAssertionResult,
} from '../../../runtime/adapters/claude-code/persistent/post-spawn-assertion.ts'
import type { Event } from '../../../runtime/events.ts'

// Absolute paths to the producer SOURCE files, resolved from this test file so
// the source-text extraction below is worktree-independent.
const SUBSTRATE_SRC_PATH = fileURLToPath(
  new URL(
    '../../../runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts',
    import.meta.url,
  ),
)
// `collectTokensToString` (which throws the `cc-llm-call: aborted` producer)
// was relocated out of build-llm-call-substrate.ts into the runtime leaf in L3
// (the reminders→gateway DAG-edge cut). The literal is unchanged — only its home
// moved — so the extraction points at the new file.
const COLLECT_TOKENS_SRC_PATH = fileURLToPath(
  new URL('../../../runtime/collect-tokens.ts', import.meta.url),
)

/**
 * Pull an exact string literal out of a producer's OWN source text. This is the
 * no-mock-past-the-seam trick for producers that are bare string literals /
 * inline template prefixes we cannot invoke in isolation: we never hand-copy the
 * wording into the test — we read the producer's current source and fail loudly
 * (the match is `null`) the moment it is reworded, then assert the classifier
 * against the extracted-from-source string.
 */
function extractFromSource(srcPath: string, pattern: RegExp, label: string): string {
  const src = readFileSync(srcPath, 'utf8')
  const m = src.match(pattern)
  if (m === null || m[1] === undefined) {
    throw new Error(
      `G6 producer-conformance: could not extract ${label} from ${srcPath} — the producer ` +
        `wording was reworded (or moved). Update BOTH the producer and its classifier, then ` +
        `re-pin this test (§2.4 ratchet: PR-body note + Fable sign-off).`,
    )
  }
  return m[1]
}

/** Drive `startResponsesStream` against an injected fetch returning `status` — this
 *  executes the REAL `HTTP ${status}: <body>` producer template
 *  (runtime/adapters/gpt-5-5-api/responses-stream.ts:79-88) and returns the
 *  error event's `.message`. The fetch seam is the network boundary, NOT the
 *  classifier seam under test, so injecting it is not "mocking past the seam". */
async function realHttpStatusProducerMessage(status: number, body: string): Promise<string> {
  const stream = startResponsesStream({
    endpoint: 'http://127.0.0.1:0/v1/responses',
    authHeaders: {},
    body: {},
    signal: new AbortController().signal,
    substrate_instance_id: 'g6',
    // `typeof fetch` carries a `preconnect` member the injected stub omits; the
    // adapter only ever calls it as a function, so the cast is sound. The stub is
    // the NETWORK boundary, not the classifier seam under test.
    fetchImpl: (async () =>
      new Response(body, { status, statusText: 'from-test', headers: {} })) as unknown as typeof fetch,
  })
  for await (const ev of stream) {
    if (ev.kind === 'error') return ev.message
  }
  throw new Error('gpt-5-5 producer did not emit an error event for a non-ok response')
}

// ───────────────────────────────────────────────────────────────────────────
// parseHttpStatusFromMessage  ←  gpt-5-5 adapter `HTTP ${status}: <body>`
// ───────────────────────────────────────────────────────────────────────────

test('G6 · parseHttpStatusFromMessage pins the REAL `HTTP <status>:` producer (gpt-5-5 adapter), all cooldown-relevant statuses', async () => {
  // Producer: runtime/adapters/gpt-5-5-api/responses-stream.ts:83/87 —
  // `message: \`HTTP ${status}: ${truncate(text, 400)}\`` on any !response.ok.
  for (const status of [429, 402, 401, 500, 408]) {
    const producedMsg = await realHttpStatusProducerMessage(status, 'upstream body text')
    // Prove we drove the real template, not a hand-copied literal.
    expect(producedMsg.startsWith(`HTTP ${status}:`)).toBe(true)
    // Classifier verdict must recover the exact status from the real prose.
    expect(parseHttpStatusFromMessage(producedMsg)).toBe(status)
  }
})

test('G6 · parseHttpStatusFromMessage does NOT match a mid-string HTTP token (anchored `^HTTP`) — an auth tail like `claude exited 1: HTTP 401` must fall through to detectCliAuthFailure', () => {
  // Negative space guarded by cli-auth-failure-classification.test.ts case 3;
  // pinned here so the `^HTTP` anchor is not loosened without a red test.
  expect(parseHttpStatusFromMessage('claude exited 1: HTTP 401 Unauthorized')).toBeNull()
})

// ───────────────────────────────────────────────────────────────────────────
// is429ErrorMessage  ←  gpt-5-5 `HTTP 429:`  +  Anthropic API `rate_limit_error`
// ───────────────────────────────────────────────────────────────────────────

test('G6 · is429ErrorMessage (import Sonnet-fallback gate) matches the REAL `HTTP 429:` producer string', async () => {
  const producedMsg = await realHttpStatusProducerMessage(429, "You've hit your limit")
  expect(producedMsg.startsWith('HTTP 429:')).toBe(true)
  expect(is429ErrorMessage(producedMsg)).toBe(true)
})

test('G6 · is429ErrorMessage matches the Anthropic API rate-limit envelope wording', () => {
  // EXTERNAL producer: the Anthropic Messages API rate-limit error envelope
  // surfaces `{"type":"error","error":{"type":"rate_limit_error", ...}}` (HTTP
  // 429). The classifier's `/rate[_-]?limit/i` branch exists to catch this
  // upstream shape when it is surfaced without a leading `HTTP 429`. Pin the
  // exact current wording so a reword of the branch (or a drift away from the
  // SDK's `rate_limit_error` type) is caught.
  expect(is429ErrorMessage('rate_limit_error: number of request tokens has exceeded your rate limit')).toBe(true)
  expect(is429ErrorMessage('rate-limit exceeded')).toBe(true)
  // Negative: a non-429 upstream error must NOT trip the fallback gate (burning
  // a second model bucket on a permanently-broken request is pure waste).
  expect(is429ErrorMessage('HTTP 400: invalid_request_error')).toBe(false)
})

// ───────────────────────────────────────────────────────────────────────────
// detectBinaryNotFound  ←  Bun.spawn (live) + node/shell shapes (external, pinned)
// ───────────────────────────────────────────────────────────────────────────

test('G6 · detectBinaryNotFound pins the REAL Bun.spawn missing-binary producer (driven live)', async () => {
  // Producer: Bun's `spawn` throws when the executable is not on PATH. Drive it
  // for real with a `claude`-named missing binary so the classifier is pinned to
  // Bun's ACTUAL current wording rather than a hand-copied literal.
  let bunSpawnMessage = ''
  try {
    Bun.spawnSync(['claude-neutron-g6-missing-binary'])
  } catch (err) {
    bunSpawnMessage = (err as Error).message
  }
  // Bun today: `Executable not found in $PATH: "claude-neutron-g6-missing-binary"`.
  expect(/executable not found in \$?path/i.test(bunSpawnMessage)).toBe(true)
  expect(detectBinaryNotFound(bunSpawnMessage)).toBe(true)
})

test('G6 · detectBinaryNotFound pins the node/shell missing-binary shapes (external producers, exact wording)', () => {
  // node `child_process` posix spawn ENOENT (real node, not the Bun shim):
  //   producer: libuv/posix execvp → `Error: spawn claude ENOENT`.
  expect(detectBinaryNotFound('Error: spawn claude ENOENT')).toBe(true)
  // POSIX shell layer when `claude` is invoked through `sh -c`:
  //   producer: /bin/sh → `sh: claude: command not found`.
  expect(detectBinaryNotFound('sh: claude: command not found')).toBe(true)
  // execvp ENOENT rendered as errno text:
  //   producer: `spawn claude: no such file or directory` (errno 2).
  expect(detectBinaryNotFound('spawn claude: no such file or directory')).toBe(true)
})

test('G6 · detectBinaryNotFound requires a `claude` mention for the ENOENT / no-such-file shapes (an unrelated file ENOENT must NOT be misclassified)', () => {
  // Guards the `&& /claude/i` conjunctions — a config-file ENOENT during a turn
  // must not launder into "binary not found" and mask a real fault.
  expect(detectBinaryNotFound('Error: spawn ENOENT')).toBe(false)
  expect(detectBinaryNotFound('ENOENT: no such file or directory, open /tmp/settings.json')).toBe(false)
})

// ───────────────────────────────────────────────────────────────────────────
// detectChannelWedged  ←  ChannelWedgedSpawnError (live) + `spawn failed (<reason>)`
//                          template (source-extracted) driven by REAL reasons
// ───────────────────────────────────────────────────────────────────────────

test('G6 · detectChannelWedged pins the REAL ChannelWedgedSpawnError producer message (constructed live)', () => {
  // Producer: runtime/adapters/claude-code/persistent/channel-wedge-respawn.ts:87-94
  //   super(`persistent-repl: spawn failed (channel-wedged; ${detail ?? ''})`)
  const err = new ChannelWedgedSpawnError('sess-key', 'pid=4242 port=51999')
  expect(err.message).toBe('persistent-repl: spawn failed (channel-wedged; pid=4242 port=51999)')
  expect(detectChannelWedged(err.message)).toBe(true)
  // The composer classifies channel-wedged BEFORE the cooldown map, so it must
  // NOT ALSO read as an HTTP/429 credential condition.
  expect(parseHttpStatusFromMessage(err.message)).toBeNull()
  expect(is429ErrorMessage(err.message)).toBe(false)
})

test('G6 · detectChannelWedged pins the substrate `spawn failed (<reason>; ...)` producer for ALL post-spawn-assertion reasons, using REAL reason values + the source-extracted template', async () => {
  // The four failure reasons come from the REAL producer `assertReplAlive`
  // (post-spawn-assertion.ts), driven here with fake DI deps that fast-fail each
  // stage — so the reason TOKENS (`dead-child` / `no-channel-ready` /
  // `no-http-health` / `channel-wedged`) are never hand-typed.
  const reasons = await Promise.all([
    driveAssertionReason('dead-child'),
    driveAssertionReason('no-channel-ready'),
    driveAssertionReason('no-http-health'),
    driveAssertionReason('channel-wedged'),
  ])
  expect(reasons).toEqual(['dead-child', 'no-channel-ready', 'no-http-health', 'channel-wedged'])

  // The message FORMAT comes from the substrate's OWN source (line ~2013:
  // `throw new Error(\`persistent-repl: spawn failed (${assertion.reason}; ${assertion.detail ?? ''})\`)`).
  // Extract the exact template prefix from source so a reword of the producer
  // format fails loudly here (the extraction returns `null`).
  const templatePrefix = extractFromSource(
    SUBSTRATE_SRC_PATH,
    /throw new Error\(`(persistent-repl: spawn failed \()\$\{assertion\.reason\}/,
    'the `persistent-repl: spawn failed (<reason>` producer template',
  )
  expect(templatePrefix).toBe('persistent-repl: spawn failed (')

  for (const reason of reasons) {
    // Reconstruct the producer string from source-proven format + real reason.
    const produced = `${templatePrefix}${reason}; pid=1 port=2)`
    expect(detectChannelWedged(produced)).toBe(true)
    // None of these is a credential condition — must not read as HTTP/429.
    expect(parseHttpStatusFromMessage(produced)).toBeNull()
  }
})

test('G6 · detectChannelWedged also fires on a bare `channel-wedged` token (the substrate stderr tag)', () => {
  // Producer: persistent-repl-substrate.ts stderr tag `[channel-wedged] <text>`.
  expect(detectChannelWedged('[channel-wedged] REPL sess still unwired')).toBe(true)
  // Negative: an ordinary retryable error must not read as a wedge.
  expect(detectChannelWedged('HTTP 500: upstream error')).toBe(false)
})

/** Drive the REAL `assertReplAlive` producer with fake DI deps that fast-fail a
 *  chosen stage, and return the reason it yields. The DI seam (child-alive /
 *  channel-port / health / bound probes) is the substrate's own injection
 *  boundary — not the classifier seam — so this reads the producer's genuine
 *  reason token spelling. */
async function driveAssertionReason(
  want: 'dead-child' | 'no-channel-ready' | 'no-http-health' | 'channel-wedged',
): Promise<string> {
  const base: SpawnAssertionDeps = {
    isChildAlive: () => true,
    getChannelPort: () => 51999,
    hasHttpHealth: async () => true,
    isChannelBound: () => true,
    sleep: async () => undefined,
    now: (() => {
      // Monotonic clock that jumps past every budget on the 2nd read so the
      // "never arrived" branches trip immediately without real waiting.
      let t = 0
      return () => (t += 1_000_000)
    })(),
  }
  let deps: SpawnAssertionDeps
  if (want === 'dead-child') {
    deps = { ...base, isChildAlive: () => false }
  } else if (want === 'no-channel-ready') {
    deps = { ...base, getChannelPort: () => undefined }
  } else if (want === 'no-http-health') {
    deps = { ...base, hasHttpHealth: async () => false }
  } else {
    deps = { ...base, isChannelBound: () => false }
  }
  const result: SpawnAssertionResult = await assertReplAlive({ pid: 1 }, deps)
  if (result.ok) throw new Error(`assertReplAlive unexpectedly passed for want=${want}`)
  return result.reason
}

// ───────────────────────────────────────────────────────────────────────────
// detectTurnTimeout  ←  persistent-repl-substrate `persistent-repl: turn timeout`
// ───────────────────────────────────────────────────────────────────────────

test('G6 · detectTurnTimeout pins the REAL `persistent-repl: turn timeout` producer literal (extracted from substrate source)', () => {
  // Producer: persistent-repl-substrate.ts:~2974 —
  //   channel.push({ kind: 'error', message: 'persistent-repl: turn timeout', retryable: true })
  // This is a bare string literal that cannot be invoked without a full REPL, so
  // we extract the exact literal from the producer source (fails loudly on a
  // reword) and assert the classifier against it.
  const producedLiteral = extractFromSource(
    SUBSTRATE_SRC_PATH,
    /message: '(persistent-repl: turn timeout)', retryable: true/,
    'the `persistent-repl: turn timeout` producer literal',
  )
  expect(detectTurnTimeout(producedLiteral)).toBe(true)
  // A turn timeout is RETRYABLE on the same credential — must NOT read as an
  // HTTP/429/auth cooldown or a channel wedge.
  expect(parseHttpStatusFromMessage(producedLiteral)).toBeNull()
  expect(detectChannelWedged(producedLiteral)).toBe(false)
  expect(is429ErrorMessage(producedLiteral)).toBe(false)
})

// ───────────────────────────────────────────────────────────────────────────
// isFreezeTimeout  ←  substrate `turn timeout`  +  composer `cc-llm-call: aborted`
// ───────────────────────────────────────────────────────────────────────────

test('G6 · isFreezeTimeout matches the REAL turn-timeout AND composer-abort producers (both extracted from source)', () => {
  // Producer A: persistent-repl-substrate.ts `persistent-repl: turn timeout`.
  const turnTimeout = extractFromSource(
    SUBSTRATE_SRC_PATH,
    /message: '(persistent-repl: turn timeout)', retryable: true/,
    'the `persistent-repl: turn timeout` producer literal',
  )
  // Producer B: runtime/collect-tokens.ts abort-signal listener —
  //   throw new Error('cc-llm-call: aborted')
  const composerAbort = extractFromSource(
    COLLECT_TOKENS_SRC_PATH,
    /throw new Error\('(cc-llm-call: aborted)'\)/,
    'the `cc-llm-call: aborted` composer-abort producer literal',
  )
  expect(isFreezeTimeout(turnTimeout)).toBe(true)
  expect(isFreezeTimeout(composerAbort)).toBe(true)
})

test('G6 · isFreezeTimeout does NOT swallow real faults as timeouts (binary-not-found / channel-wedged / auth / all-cooldown)', () => {
  // The whole point of isFreezeTimeout is to STOP misdiagnosing a real fault as
  // a benign timeout. Pin the negative space against the REAL fault-message
  // constants + a live-constructed channel-wedge producer.
  expect(isFreezeTimeout(BINARY_NOT_FOUND_MESSAGE)).toBe(false)
  expect(isFreezeTimeout(CHANNEL_WEDGED_MESSAGE)).toBe(false)
  expect(isFreezeTimeout(new ChannelWedgedSpawnError('s', 'pid=1').message)).toBe(false)
  expect(isFreezeTimeout('HTTP 401: invalid api key')).toBe(false)
  expect(isFreezeTimeout('all Anthropic credentials are in cooldown (429/402/401)')).toBe(false)
})

// ───────────────────────────────────────────────────────────────────────────
// Cross-classifier invariant: the composer's classification LADDER order.
// ───────────────────────────────────────────────────────────────────────────

test('G6 · classification-ladder disjointness — each REAL producer string trips exactly ONE health class (no double-classification into a false cooldown)', async () => {
  const http429 = await realHttpStatusProducerMessage(429, 'limit')
  const wedge = new ChannelWedgedSpawnError('s', 'pid=1 port=2').message
  const timeout = extractFromSource(
    SUBSTRATE_SRC_PATH,
    /message: '(persistent-repl: turn timeout)', retryable: true/,
    'turn-timeout literal',
  )

  // channel-wedged: ONLY detectChannelWedged (checked first in the ladder).
  expect(detectChannelWedged(wedge)).toBe(true)
  expect(detectBinaryNotFound(wedge)).toBe(false)
  expect(detectTurnTimeout(wedge)).toBe(false)
  expect(parseHttpStatusFromMessage(wedge)).toBeNull()

  // turn-timeout: ONLY detectTurnTimeout.
  expect(detectTurnTimeout(timeout)).toBe(true)
  expect(detectChannelWedged(timeout)).toBe(false)
  expect(detectBinaryNotFound(timeout)).toBe(false)
  expect(parseHttpStatusFromMessage(timeout)).toBeNull()

  // HTTP 429: ONLY the HTTP-status path (a real credential cooldown).
  expect(parseHttpStatusFromMessage(http429)).toBe(429)
  expect(detectChannelWedged(http429)).toBe(false)
  expect(detectTurnTimeout(http429)).toBe(false)
  expect(detectBinaryNotFound(http429)).toBe(false)

  // Sanity: none of the three benign/real-fault strings satisfies more than one
  // fast-path classifier — the ladder's `continue` guarantees single-dispatch.
  const classes = (m: string): number =>
    (detectBinaryNotFound(m) ? 1 : 0) +
    (detectChannelWedged(m) ? 1 : 0) +
    (detectTurnTimeout(m) ? 1 : 0) +
    (parseHttpStatusFromMessage(m) !== null ? 1 : 0)
  for (const m of [http429, wedge, timeout]) expect(classes(m)).toBe(1)
})

// Touch the Event type import so an accidental drift in the producer's event
// shape (kind: 'error') is caught at compile time, not just runtime.
const _eventShapeGuard: Event = { kind: 'error', message: 'x', retryable: false }
void _eventShapeGuard
