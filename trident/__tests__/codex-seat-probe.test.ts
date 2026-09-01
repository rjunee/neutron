/**
 * THE CODEX SEAT IS DEAD AND EVERY LOCAL FIELD SAYS IT IS FINE.
 *
 * Measured 2026-08-20 on this box: `codex_status` returned `status: connected`,
 * `materialized: true`, `expires_at: 2026-08-28` — eight days out — while every
 * build died on `refresh_token_invalidated`. The token had been revoked
 * server-side, which no stored byte can show. `codex login status` (the wrapper's
 * own precheck) passed in the same second the models endpoint returned 401.
 *
 * ── HOW THIS FILE IS BUILT ──────────────────────────────────────────────────
 * Every detection here has BOTH halves, because either alone is a false green:
 *
 *   POSITIVE — the revoked case is caught. Delete the probe call and these go red.
 *   NEGATIVE — the healthy case, the unreachable case, the 5xx case, the 429 case
 *              and the already-expired case are NOT caught. A patch that
 *              hardcoded `revoked` to satisfy the positive half turns these red,
 *              which is what makes the positive half mean anything.
 *
 * The negative half is the more important one. `revoked` is written into the
 * `unauthorized` cooldown, which never expires on a timer and is cleared only by
 * a reconnect — so a false `revoked` does not degrade a seat, it BRICKS one, and
 * a box that merely lost its network for a second must never reach that state.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import { codexProbeSubject, deriveCodexStatus } from '../codex-auth.ts'
import { CodexCredentialService, codexExecutorAvailability, SEAT_LIVENESS_TTL_MS } from '../codex-credential.ts'
import { SqliteCodexRotationStore } from '../codex-rotation-store.ts'
import { CODEX_STATUS_TOOL, registerCodexCredentialToolSurface } from '../codex-credential-tool.ts'
import { probeCodexSeat, redactToken, type CodexProbeOutcome } from '../codex-probe.ts'
import { buildPhaseRunsOnCodex, codexDispatchPreflight } from '../codex-dispatch-preflight.ts'
import { registerTridentBuildToolSurface, WORK_BOARD_DISPATCH_BUILD_TOOL, WORK_BOARD_START_TOOL } from '../work-board-build-tool.ts'
import { TridentRunStore } from '../store.ts'
import {
  dispatchBoardBoundBuild,
  type BoardBoundBuildDeps,
  type TridentBoardBinder,
} from '../board-dispatch.ts'
import { executeCodeCommand } from '../code-command.ts'
import type { GitModeProbe } from '../git-mode.ts'
import { briefIntegrity } from '../brief-parts.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const FIXTURE = join(HERE, '..', '__fixtures__', 'codex-models-401-token-revoked.json')
const OWNER = asOwnerHandle('owner')

// ─────────────────────────────────────────────────────────────────────────────
// P2 — THE ANTI-EMPTY-CHECK GUARD.
//
// Every "revoked" assertion below is driven by bytes captured off the real
// endpoint. A fixture that went missing, got emptied, or quietly stopped being a
// 401 would make each of those tests pass against nothing at all. So the fixture
// is validated ONCE, loudly, before anything uses it — an extraction that finds
// nothing must FAIL, never wave through.
// ─────────────────────────────────────────────────────────────────────────────
interface Capture {
  http_status: number
  body: { error: { code: string; message: string }; status: number }
}

/**
 * THE PATH IS AN ARGUMENT, and that is the entire point of this signature.
 *
 * The previous version took none — `FIXTURE` was hardcoded — which made it
 * STRUCTURALLY IMPOSSIBLE to feed the guard a bad file, so the test that claimed
 * to exercise it re-typed a COPY of the check inline and asserted the copy threw.
 * Deleting all three guards from this function left that test green: it was
 * testing five lines it had just written, not this function. Now every negative
 * case below calls THIS function, so removing a guard reddens the suite.
 */
function loadCapture(path: string = FIXTURE): Capture {
  const raw = readFileSync(path, 'utf8')
  if (raw.trim().length === 0) throw new Error(`captured 401 fixture is EMPTY: ${path}`)
  const parsed = JSON.parse(raw) as Capture
  if (parsed.http_status !== 401) {
    throw new Error(`captured fixture is not a 401 (got ${String(parsed.http_status)}): ${path}`)
  }
  if (typeof parsed.body?.error?.code !== 'string' || parsed.body.error.code.length === 0) {
    throw new Error(`captured fixture has no error code: ${path}`)
  }
  return parsed
}

describe('the captured 401 fixture is real and non-vacuous (P2)', () => {
  /** Write `text` to a scratch file and hand THE REAL LOADER its path. */
  function loadBad(text: string): () => Capture {
    const bad = join(mkdtempSync(join(tmpdir(), 'codex-fx-')), 'x.json')
    writeFileSync(bad, text)
    return () => loadCapture(bad)
  }

  test('it exists, is non-empty, and parses to HTTP 401 with an error code', () => {
    expect(statSync(FIXTURE).size).toBeGreaterThan(0)
    const capture = loadCapture()
    expect(capture.http_status).toBe(401)
    expect(capture.body.error.code).toBe('token_revoked')
  })

  test('an EMPTIED fixture fails loudly — the guard itself, not a copy of it', () => {
    expect(loadBad('')).toThrow(/EMPTY/)
    expect(loadBad('   \n  ')).toThrow(/EMPTY/)
  })

  test('a fixture that stopped being a 401 fails loudly', () => {
    expect(loadBad(JSON.stringify({ http_status: 200, body: { error: { code: 'x' } } }))).toThrow(
      /not a 401 \(got 200\)/,
    )
  })

  test('a fixture that lost its error code fails loudly', () => {
    expect(loadBad(JSON.stringify({ http_status: 401, body: { error: {} } }))).toThrow(/no error code/)
    expect(loadBad(JSON.stringify({ http_status: 401, body: { error: { code: '' } } }))).toThrow(
      /no error code/,
    )
  })

  test('POSITIVE CONTROL: a well-formed copy at another path loads clean', () => {
    // Without this, every assertion above is satisfied by a loader that throws
    // unconditionally — "it threw" would prove nothing about WHICH guard fired.
    const good = join(mkdtempSync(join(tmpdir(), 'codex-fx-ok-')), 'x.json')
    writeFileSync(good, readFileSync(FIXTURE, 'utf8'))
    expect(loadCapture(good).http_status).toBe(401)
  })
})

describe('the probe has a PRODUCTION caller (merged-green-but-unwired guard)', () => {
  test('a non-test source file imports probeCodexSeat, and both wrappers probe over HTTP', () => {
    // A module only its own unit test calls is a green merge that delivers no
    // behaviour — this repo has shipped exactly that. `git grep` is the check,
    // and an EMPTY result must FAIL rather than read as a pass.
    // `--untracked` so the guard is honest in a worktree where the module is not
    // yet committed: without it `git grep` silently skips the new file and the
    // "does a caller exist" question is answered about a repo that has neither.
    const grep = spawnSync('git', ['grep', '-l', '--untracked', 'probeCodexSeat', '--', 'trident'], {
      cwd: REPO,
      encoding: 'utf8',
    })
    const files = (grep.stdout ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.includes('.test.') && !l.includes('__tests__'))
    expect(files).toContain('trident/codex-probe.ts')
    // The definition itself is not a caller.
    expect(files.filter((f) => f !== 'trident/codex-probe.ts')).toContain('trident/codex-credential.ts')

    // BOTH read surfaces must refresh liveness before answering — the agent tool
    // and the HTTP route the app polls. A probe wired to only one of them leaves
    // the other reporting `connected` for a dead seat, which is the original bug
    // with a smaller blast radius.
    for (const surface of ['trident/codex-credential-tool.ts', 'gateway/http/codex-credential-surface.ts']) {
      expect(readFileSync(join(REPO, surface), 'utf8')).toContain('refreshSeatLiveness')
    }

    // The shell half likewise: both wrappers must make an AUTHENTICATED request,
    // not merely re-read `codex login status`.
    for (const wrapper of ['trident/codex-build.sh', 'trident/codex-review.sh']) {
      const text = readFileSync(join(REPO, wrapper), 'utf8')
      expect(text).toContain('codex_auth_probe_status')
      expect(text).toContain('Authorization: Bearer')
    }
  })
})

/** A JWT whose `exp` is exactly `expSeconds`. Signature is never checked here. */
function jwtWithExp(expSeconds: number): string {
  const seg = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${seg({ alg: 'none', typ: 'JWT' })}.${seg({ exp: expSeconds, sub: 'user' })}.c2ln`
}

const NOW = Date.parse('2026-08-20T21:29:00.000Z')
const FUTURE_TOKEN = jwtWithExp(Math.floor(Date.parse('2026-08-28T02:04:50.000Z') / 1000))
const PAST_TOKEN = jwtWithExp(Math.floor(Date.parse('2026-08-19T00:00:00.000Z') / 1000))

// TWO FUTURE TOKENS, AND THE DIFFERENCE IS WHOSE CLOCK READS THEM.
//
// `FUTURE_TOKEN` is future relative to `NOW`, the PINNED clock every TypeScript case
// here injects. That pairing is deterministic forever and must stay pinned — a test
// that pins the clock and then dates a fixture off `Date.now()` is not pinned at all.
//
// The SHELL cases are different in kind. They exec the REAL `trident/codex-build.sh`
// and `trident/codex-review.sh`, which compute `exp > now` themselves against the
// REAL system clock — that computation is the behaviour under test, so it cannot be
// injected. Against the real clock a fixed date is a countdown: `FUTURE_TOKEN` stops
// being future on 2026-08-28, at which point P5, P5c and P5R flip to red on every box
// and every commit, and blame whichever diff happens to be in flight.
//
// This repo has already lost a day to exactly that shape — two scheduler tests that
// omitted a `now()` pin reddened at one hour of the day and were read as flaky. And
// `scripts/ci/lint.sh`'s WALL-CLOCK-BOUND gate does NOT catch this: it bans asserting
// on ELAPSED time, not on a fixture that silently expires.
//
// So: relative to the real clock, always a day out, never a countdown.
const SHELL_FUTURE_TOKEN = jwtWithExp(Math.floor(Date.now() / 1000) + 86_400)
const SHELL_PAST_TOKEN = jwtWithExp(Math.floor(Date.now() / 1000) - 86_400)

function bundle(access: string): string {
  return JSON.stringify({
    tokens: { id_token: 'id', access_token: access, refresh_token: 'ref', account_id: 'acct' },
    last_refresh: '2026-08-20T00:00:00.000Z',
  })
}

/** A `fetch` that answers with the captured bytes at a chosen status. */
function stubFetch(status: number, calls?: Array<{ url: string; auth: string }>): typeof fetch {
  const capture = loadCapture()
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {})
    calls?.push({ url: String(url), auth: headers.get('Authorization') ?? '' })
    return new Response(JSON.stringify(capture.body), { status })
  }) as unknown as typeof fetch
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PROBE ITSELF
// ─────────────────────────────────────────────────────────────────────────────
describe('probeCodexSeat — the one question a stored token cannot answer', () => {
  test('P1: the REAL captured 401, on a token whose exp is 8 days out → revoked', async () => {
    const calls: Array<{ url: string; auth: string }> = []
    const out = await probeCodexSeat(
      { accessToken: FUTURE_TOKEN, expInFuture: true },
      { fetch: stubFetch(401, calls) },
    )
    expect(out.kind).toBe('revoked')
    // …and NOT the state it was measured reporting.
    expect(out.kind).not.toBe('ok')
    // POSITIVE CONTROL ON THE CALL ITSELF: an assertion about a request that was
    // never made proves nothing, so the request is inspected.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.auth).toBe(`Bearer ${FUTURE_TOKEN}`)
    expect(calls[0]?.url).toContain('client_version=')
  })

  test('N7 (ANTI-HARDCODE): a 200 is `ok` — this is what makes P1 non-vacuous', async () => {
    const out = await probeCodexSeat({ accessToken: FUTURE_TOKEN, expInFuture: true }, { fetch: stubFetch(200) })
    expect(out.kind).toBe('ok')
  })

  test('N4: the SAME 401 on an already-EXPIRED token is `expired`, never `revoked`', async () => {
    const out = await probeCodexSeat({ accessToken: PAST_TOKEN, expInFuture: false }, { fetch: stubFetch(401) })
    expect(out.kind).toBe('expired')
    expect(out.kind).not.toBe('revoked')
  })

  test('N1: a transport failure is `unreachable` — a dropped packet must never kill a seat', async () => {
    const throwing = (async () => {
      throw new Error('connect ECONNREFUSED 1.2.3.4:443')
    }) as unknown as typeof fetch
    const out = await probeCodexSeat({ accessToken: FUTURE_TOKEN, expInFuture: true }, { fetch: throwing })
    expect(out.kind).toBe('unreachable')
  })

  test('N1b: an AbortSignal timeout is `unreachable`, not a verdict', async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation timed out.', 'TimeoutError'))
        })
      })) as unknown as typeof fetch
    const out = await probeCodexSeat(
      { accessToken: FUTURE_TOKEN, expInFuture: true },
      { fetch: hanging, timeoutMs: 15 },
    )
    expect(out.kind).toBe('unreachable')
  })

  test('N2: 500 and 502 are `unreachable` — an upstream outage is not a revocation', async () => {
    for (const status of [500, 502, 503]) {
      const out = await probeCodexSeat({ accessToken: FUTURE_TOKEN, expInFuture: true }, { fetch: stubFetch(status) })
      expect(out.kind).toBe('unreachable')
    }
  })

  test('N3: 429 is `rate_limited` — a capped seat is cooling, not dead', async () => {
    const out = await probeCodexSeat({ accessToken: FUTURE_TOKEN, expInFuture: true }, { fetch: stubFetch(429) })
    expect(out.kind).toBe('rate_limited')
  })

  test('403 is `rejected`, NEVER `revoked` — an edge/bot-management refusal is not a credential fact', async () => {
    // chatgpt.com is edge-fronted and this request carries only Authorization +
    // Accept, nothing like the real CLI's User-Agent/originator/account headers.
    // A bot-management 403 hits EVERY seat in the same second; classifying it as
    // `revoked` would cool an entire healthy pool off one edge rule.
    for (const expInFuture of [true, false]) {
      const out = await probeCodexSeat({ accessToken: FUTURE_TOKEN, expInFuture }, { fetch: stubFetch(403) })
      expect(out.kind).toBe('rejected')
      expect(out.kind).not.toBe('revoked')
      expect(out.kind).not.toBe('expired')
    }
    // POSITIVE CONTROL: the SAME token and the SAME clock on a 401 still is.
    expect((await probeCodexSeat({ accessToken: FUTURE_TOKEN, expInFuture: true }, { fetch: stubFetch(401) })).kind).toBe(
      'revoked',
    )
  })

  test('a MOVED endpoint (404) is `rejected` — loud, and never a verdict on the credential', async () => {
    const out = await probeCodexSeat({ accessToken: FUTURE_TOKEN, expInFuture: true }, { fetch: stubFetch(404) })
    expect(out.kind).toBe('rejected')
  })

  test('the verdict does NOT key on the body code string (measured varying on one box)', async () => {
    // 19:07 said `token_invalidated`; 21:29 said `token_revoked`. Same condition.
    const other = (async () =>
      new Response(JSON.stringify({ error: { code: 'token_invalidated' }, status: 401 }), {
        status: 401,
      })) as unknown as typeof fetch
    const out = await probeCodexSeat({ accessToken: FUTURE_TOKEN, expInFuture: true }, { fetch: other })
    expect(out.kind).toBe('revoked')
  })

  test('N5b: an empty access token is never probed at all', async () => {
    let calls = 0
    const counting = (async () => {
      calls += 1
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const out = await probeCodexSeat({ accessToken: '', expInFuture: true }, { fetch: counting })
    expect(out.kind).toBe('unreachable')
    expect(calls).toBe(0)
  })

  test('N8 (SECRET HYGIENE): no outcome ever echoes the token, even when upstream does', async () => {
    const leaky = (async () => {
      throw new Error(`TLS handshake failed while sending Authorization: Bearer ${FUTURE_TOKEN}`)
    }) as unknown as typeof fetch
    const out = (await probeCodexSeat(
      { accessToken: FUTURE_TOKEN, expInFuture: true },
      { fetch: leaky },
    )) as Extract<CodexProbeOutcome, { kind: 'unreachable' }>
    expect(out.kind).toBe('unreachable')
    expect(out.message).not.toContain(FUTURE_TOKEN)
    // …and not a recognisable PIECE of it either (the JWT payload segment).
    expect(out.message).not.toContain(FUTURE_TOKEN.split('.')[1]!)
    expect(out.message).toContain('[redacted]')
    // POSITIVE CONTROL for the redactor: it must actually be capable of leaving
    // ordinary text alone, or "no token in the message" is trivially true.
    expect(redactToken('TLS handshake failed', FUTURE_TOKEN)).toBe('TLS handshake failed')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE DISCRIMINATOR. `codexProbeSubject` computes the ONE boolean that decides
// `revoked` vs `expired`, and it had ZERO coverage in either direction: every
// call site above hands `expInFuture` in as a LITERAL the test itself typed, and
// every service test replaced the probe with a stub that discards its input. So
// `expInFuture: expMs === null || expMs > now()` could be replaced with the
// constant `false` (the fix goes inert, the measured defect returns verbatim) or
// the constant `true` (an ordinary EXPIRED token earns the never-expiring
// `unauthorized` cooldown) and 2450 tests stayed green.
//
// These assert the FUNCTION, not a literal.
// ─────────────────────────────────────────────────────────────────────────────
describe('codexProbeSubject — the boolean that separates revoked from expired', () => {
  const now = (): number => NOW

  test('a JWT whose exp is in the FUTURE → expInFuture true (this is the `revoked` input)', () => {
    const subject = codexProbeSubject(bundle(FUTURE_TOKEN), now)
    expect(subject).not.toBeNull()
    expect(subject?.accessToken).toBe(FUTURE_TOKEN)
    expect(subject?.expInFuture).toBe(true)
  })

  test('a JWT whose exp is in the PAST → expInFuture false (this is the `expired` input)', () => {
    const subject = codexProbeSubject(bundle(PAST_TOKEN), now)
    expect(subject?.accessToken).toBe(PAST_TOKEN)
    expect(subject?.expInFuture).toBe(false)
  })

  test('the boundary is exclusive: exp EXACTLY now counts as already expired', () => {
    const atNow = jwtWithExp(Math.floor(NOW / 1000))
    expect(codexProbeSubject(bundle(atNow), now)?.expInFuture).toBe(false)
    // …and one second later it is not.
    expect(codexProbeSubject(bundle(jwtWithExp(Math.floor(NOW / 1000) + 1)), now)?.expInFuture).toBe(true)
  })

  test('the CLOCK is read, not baked in — the same token flips as time passes', () => {
    // A hardcoded constant would be indifferent to `now`; the real function is not.
    const token = jwtWithExp(Math.floor(NOW / 1000) + 60)
    expect(codexProbeSubject(bundle(token), () => NOW)?.expInFuture).toBe(true)
    expect(codexProbeSubject(bundle(token), () => NOW + 61_000)?.expInFuture).toBe(false)
  })

  test('an OPAQUE (non-JWT) token → true: age cannot explain a 401 on a token with no stated expiry', () => {
    const subject = codexProbeSubject(bundle('opaque-not-a-jwt'), now)
    expect(subject?.accessToken).toBe('opaque-not-a-jwt')
    expect(subject?.expInFuture).toBe(true)
  })

  test('a JWT with no `exp` claim → true, for the same reason', () => {
    const noExp = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(
      JSON.stringify({ sub: 'user' }),
    ).toString('base64url')}.sig`
    expect(codexProbeSubject(bundle(noExp), now)?.expInFuture).toBe(true)
  })

  test('NOTHING TO PROBE WITH → null, which is the signal never to make the request', () => {
    expect(codexProbeSubject(null, now)).toBeNull()
    expect(codexProbeSubject('', now)).toBeNull()
    expect(codexProbeSubject('not json at all', now)).toBeNull()
    expect(codexProbeSubject(JSON.stringify({ tokens: {} }), now)).toBeNull()
    expect(codexProbeSubject(JSON.stringify({ tokens: { access_token: '' } }), now)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE PURE STATUS DERIVATION
// ─────────────────────────────────────────────────────────────────────────────
describe('deriveCodexStatus — revoked and expired never collapse', () => {
  const now = (): number => NOW

  test('future exp + probe `revoked` → revoked, and the copy names reconnecting', () => {
    const s = deriveCodexStatus(bundle(FUTURE_TOKEN), { materialized: true, now, probe: 'revoked' })
    expect(s.status).toBe('revoked')
    expect(s.detail.toLowerCase()).toContain('reconnect')
  })

  test('future exp + probe `unknown` → connected (the unchanged path)', () => {
    const s = deriveCodexStatus(bundle(FUTURE_TOKEN), { materialized: true, now, probe: 'unknown' })
    expect(s.status).toBe('connected')
  })

  test('N4: past exp stays `expired` EVEN WITH a revoked probe verdict', () => {
    const s = deriveCodexStatus(bundle(PAST_TOKEN), { materialized: true, now, probe: 'revoked' })
    expect(s.status).toBe('expired')
    expect(s.status).not.toBe('revoked')
  })

  test('N5: no credential → not_connected, whatever a probe might have said', () => {
    expect(deriveCodexStatus(null, { materialized: false, now, probe: 'revoked' }).status).toBe('not_connected')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// P3 — THE WIRING. A pure-function test passes whether or not production calls it.
// These drive the REAL service, a REAL credential store, a REAL rotation table
// and the REAL `codex_status` tool handler.
// ─────────────────────────────────────────────────────────────────────────────
describe('codex_status + CodexCredentialService consult the probe (P3 wiring)', () => {
  let tmp: string
  let db: ProjectDb
  let store: ProjectCredentialStore
  let codexHome: string
  let clock: number

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'codex-probe-svc-'))
    seedMigratedDb(join(tmp, 'project.db'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    store = new ProjectCredentialStore(db, { crypto: new SecretsStore({ data_dir: tmp, db }) })
    codexHome = join(tmp, '.codex')
    clock = NOW
  })
  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function service(
    outcome: () => CodexProbeOutcome,
    counter?: { n: number },
  ): CodexCredentialService {
    return new CodexCredentialService({
      store,
      codexHome,
      rotation: new SqliteCodexRotationStore(db),
      now: () => clock,
      probe: async () => {
        if (counter !== undefined) counter.n += 1
        return outcome()
      },
    })
  }

  function statusTool(svc: CodexCredentialService): ReturnType<ToolRegistry['get']> {
    const registry = new ToolRegistry()
    registerCodexCredentialToolSurface(registry, { service: svc })
    return registry.get(CODEX_STATUS_TOOL)
  }

  const CTX = { project_slug: 'owner', project_id: null, topic_id: 't', call_id: 'c', speaker_user_id: null }

  test('P3: a revoked seat reports `revoked` through the REAL tool handler', async () => {
    const svc = service(() => ({ kind: 'revoked', httpStatus: 401 }))
    await svc.connect(OWNER, bundle(FUTURE_TOKEN))
    // Before the probe the stored bytes say connected — this is the measured bug.
    expect(svc.status(OWNER).status).toBe('connected')

    const tool = statusTool(svc)!
    const out = (await tool.handler({}, CTX)) as {
      status: string
      expires_at?: string
      accounts: Array<{ slot: string; status: string; cooling: boolean; cooling_reason: string | null }>
    }
    expect(out.status).toBe('revoked')
    // The exact field that lied: an expiry days in the future beside a dead seat.
    expect(out.expires_at).toBe('2026-08-28T02:04:50.000Z')
    expect(out.accounts[0]?.status).toBe('revoked')
    // The DURABLE half — the existing `unauthorized` cooldown, reused, not rebuilt.
    expect(out.accounts[0]?.cooling_reason).toBe('unauthorized')
    expect(out.accounts[0]?.cooling).toBe(true)
  })

  test('N7 (ANTI-HARDCODE): the same wiring with a 200 reports `connected`', async () => {
    const svc = service(() => ({ kind: 'ok', httpStatus: 200 }))
    await svc.connect(OWNER, bundle(FUTURE_TOKEN))
    const out = (await statusTool(svc)!.handler({}, CTX)) as { status: string; accounts: Array<{ cooling_reason: string | null }> }
    expect(out.status).toBe('connected')
    expect(out.accounts[0]?.cooling_reason).toBeNull()
  })

  test('N1/N2: an unreachable probe leaves the seat CONNECTED and cools nothing', async () => {
    const svc = service(() => ({ kind: 'unreachable', message: 'ECONNREFUSED' }))
    await svc.connect(OWNER, bundle(FUTURE_TOKEN))
    const out = (await statusTool(svc)!.handler({}, CTX)) as {
      status: string
      accounts: Array<{ cooling: boolean; cooling_reason: string | null }>
    }
    expect(out.status).toBe('connected')
    expect(out.accounts[0]?.cooling_reason).toBeNull()
    expect(out.accounts[0]?.cooling).toBe(false)
    // …and the dispatch gate stays open. A network-isolated box keeps building.
    expect(svc.everySeatRevoked(OWNER)).toBe(false)
  })

  test('N3: a rate-limited probe never writes the never-expiring `unauthorized` state', async () => {
    const svc = service(() => ({ kind: 'rate_limited', httpStatus: 429 }))
    await svc.connect(OWNER, bundle(FUTURE_TOKEN))
    await svc.refreshSeatLiveness(OWNER)
    expect(svc.status(OWNER).status).toBe('connected')
    expect(svc.everySeatRevoked(OWNER)).toBe(false)
  })

  test('N5: with NOTHING connected the probe is never called', async () => {
    const counter = { n: 0 }
    const svc = service(() => ({ kind: 'revoked', httpStatus: 401 }), counter)
    const out = (await statusTool(svc)!.handler({}, CTX)) as { status: string }
    expect(out.status).toBe('not_connected')
    expect(counter.n).toBe(0)
  })

  test('N6: the TTL cache — two reads inside the window make ONE request', async () => {
    const counter = { n: 0 }
    const svc = service(() => ({ kind: 'ok', httpStatus: 200 }), counter)
    await svc.connect(OWNER, bundle(FUTURE_TOKEN))
    const tool = statusTool(svc)!
    await tool.handler({}, CTX)
    await tool.handler({}, CTX)
    expect(counter.n).toBe(1)
    // …and the window really does lapse, or the "cache" would be a permanent
    // one-shot and a seat revoked after boot would never be noticed.
    clock += SEAT_LIVENESS_TTL_MS + 1
    await tool.handler({}, CTX)
    expect(counter.n).toBe(2)
  })

  test('the revocation SURVIVES the TTL and a fresh service (the cooldown is durable)', async () => {
    const svc = service(() => ({ kind: 'revoked', httpStatus: 401 }))
    await svc.connect(OWNER, bundle(FUTURE_TOKEN))
    await svc.refreshSeatLiveness(OWNER)
    clock += SEAT_LIVENESS_TTL_MS * 10
    // A brand-new service object = a restarted gateway, with an empty cache.
    const restarted = new CodexCredentialService({
      store,
      codexHome,
      rotation: new SqliteCodexRotationStore(db),
      now: () => clock,
      probe: async () => ({ kind: 'unreachable', message: 'no network after restart' }),
    })
    expect(restarted.status(OWNER).status).toBe('revoked')
    expect(restarted.everySeatRevoked(OWNER)).toBe(true)
  })

  test('a RECONNECT clears it — the mandatory second half of the manual verify', async () => {
    const svc = service(() => ({ kind: 'revoked', httpStatus: 401 }))
    await svc.connect(OWNER, bundle(FUTURE_TOKEN))
    await svc.refreshSeatLiveness(OWNER)
    expect(svc.status(OWNER).status).toBe('revoked')

    // The owner pastes a fresh bundle. `connectAccount` calls `markConnected`,
    // which is the only thing that clears an `unauthorized` cooldown.
    const healthy = service(() => ({ kind: 'ok', httpStatus: 200 }))
    const res = await healthy.connectAccount(OWNER, bundle(jwtWithExp(Math.floor(clock / 1000) + 86_400)))
    expect(res.ok).toBe(true)
    await healthy.refreshSeatLiveness(OWNER)
    expect(healthy.status(OWNER).status).toBe('connected')
    expect(healthy.everySeatRevoked(OWNER)).toBe(false)
  })

  test('codexExecutorAvailability names revocation — and stays usable without it', () => {
    // A PATH THIS TEST OWNS. The previous version read the ambient PATH and put
    // its real assertion inside `if (live.usable)`, so on a box without the codex
    // CLI (any CI runner) the `else` arm asserted `dead.usable === false` — which
    // is ALREADY true for the pre-existing `needs the codex CLI` reason and would
    // pass with the revocation branch deleted. Two stub executables in a temp dir
    // make the live arm true everywhere, unconditionally, and depend on nothing
    // outside this test.
    const bin = mkdtempSync(join(tmpdir(), 'codex-avail-bin-'))
    for (const name of ['codex', 'perl']) {
      const exe = join(bin, name)
      writeFileSync(exe, '#!/bin/sh\nexit 0\n')
      chmodSync(exe, 0o755)
    }
    const env = { PATH: bin }
    const live = codexExecutorAvailability({ codexHome, env, seatsRevoked: false })
    const dead = codexExecutorAvailability({ codexHome, env, seatsRevoked: true })
    // POSITIVE CONTROL, now an assertion rather than a branch: with the same
    // codexHome and the same PATH, the ONLY difference is the flag.
    expect(live.usable).toBe(true)
    expect(dead.usable).toBe(false)
    expect(dead.usable === false ? dead.reason.toLowerCase() : '').toContain('revoked')
    rmSync(bin, { recursive: true, force: true })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // THE DISCRIMINATOR, THROUGH THE PRODUCTION PATH.
  //
  // The tests above pin `codexProbeSubject` directly; these drive the REAL
  // service with a probe that runs the REAL `probeCodexSeat` classification over
  // a stubbed transport, so the boolean under test is the one production
  // computes from the stored bytes — never one a test typed. Both mutations of
  // `codex-auth.ts`'s `expInFuture` (to the constant `false` and to the constant
  // `true`) redden here, in opposite tests.
  // ───────────────────────────────────────────────────────────────────────────
  /** A service whose probe is the REAL classifier over a stubbed HTTP status. */
  function realProbeService(
    status: number,
    seen?: Array<{ accessToken: string; expInFuture: boolean }>,
  ): CodexCredentialService {
    return new CodexCredentialService({
      store,
      codexHome,
      rotation: new SqliteCodexRotationStore(db),
      now: () => clock,
      probe: async (subject) => {
        seen?.push({ accessToken: subject.accessToken, expInFuture: subject.expInFuture })
        return probeCodexSeat(subject, { fetch: stubFetch(status) })
      },
    })
  }

  test('END-TO-END: a 401 on a stored token whose exp is in the FUTURE cools the seat `unauthorized`', async () => {
    const seen: Array<{ accessToken: string; expInFuture: boolean }> = []
    const svc = realProbeService(401, seen)
    await svc.connect(OWNER, bundle(FUTURE_TOKEN))
    await svc.refreshSeatLiveness(OWNER)
    // The input the SERVICE computed — not one this test handed in.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.accessToken).toBe(FUTURE_TOKEN)
    expect(seen[0]?.expInFuture).toBe(true)
    expect(svc.status(OWNER).status).toBe('revoked')
    expect(svc.everySeatRevoked(OWNER)).toBe(true)
  })

  test('END-TO-END: the SAME 401 on a stored token whose exp has PASSED cools NOTHING', async () => {
    const seen: Array<{ accessToken: string; expInFuture: boolean }> = []
    const svc = realProbeService(401, seen)
    await svc.connect(OWNER, bundle(PAST_TOKEN))
    await svc.refreshSeatLiveness(OWNER)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.expInFuture).toBe(false)
    // An aged-out access token is refreshed by the CLI from `refresh_token`. It
    // must never earn the never-expiring `unauthorized` state, and it must never
    // be reported with the `revoked` remedy.
    expect(svc.status(OWNER).status).toBe('expired')
    expect(svc.status(OWNER).status).not.toBe('revoked')
    expect(svc.everySeatRevoked(OWNER)).toBe(false)
    expect(svc.listAccounts(OWNER)[0]?.cooling_reason ?? null).toBeNull()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // THE RETRACTION. A verdict only a human can withdraw is a brick, and this one
  // is reachable from a PASSIVE settings poll: `refreshSeatLiveness` runs with no
  // build in flight. One anomalous 401 — an edge rule, a half-rolled deploy, a
  // token superseded in a race — must not refuse every build until someone pastes
  // a fresh auth.json.
  // ───────────────────────────────────────────────────────────────────────────
  test('RETRACTION: a later `ok` probe withdraws the revocation and re-opens dispatch', async () => {
    let outcome: CodexProbeOutcome = { kind: 'revoked', httpStatus: 401 }
    const svc = service(() => outcome)
    await svc.connect(OWNER, bundle(FUTURE_TOKEN))
    await svc.refreshSeatLiveness(OWNER)
    // Bricked, as measured.
    expect(svc.status(OWNER).status).toBe('revoked')
    expect(svc.everySeatRevoked(OWNER)).toBe(true)
    expect(svc.listAccounts(OWNER)[0]?.cooling_reason).toBe('unauthorized')

    // The server starts answering 200. Ten TTL-expired polls, exactly the
    // reviewer's reproduction.
    outcome = { kind: 'ok', httpStatus: 200 }
    for (let i = 0; i < 10; i++) {
      clock += SEAT_LIVENESS_TTL_MS + 1
      await svc.refreshSeatLiveness(OWNER)
    }
    expect(svc.status(OWNER).status).toBe('connected')
    expect(svc.everySeatRevoked(OWNER)).toBe(false)
    expect(svc.listAccounts(OWNER)[0]?.cooling_reason ?? null).toBeNull()
    expect(svc.listAccounts(OWNER)[0]?.cooling).toBe(false)

    // …and the DISPATCH GATE re-opens. This is the assertion that matters: the
    // status pane recovering while builds stay refused would be the same outage
    // with a friendlier label.
    const gate = await codexDispatchPreflight({
      phaseModels: () => ({ build: { model: 'sol' } }),
      refreshLiveness: () => svc.refreshSeatLiveness(OWNER),
      everySeatRevoked: () => svc.everySeatRevoked(OWNER),
      reason: () => 'the connected Codex seat was REVOKED server-side — reconnect it',
    })
    expect(gate.ok).toBe(true)
  })

  test('RETRACTION SURVIVES A RESTART: the durable row itself is cleared, not a cache', async () => {
    let outcome: CodexProbeOutcome = { kind: 'revoked', httpStatus: 401 }
    const svc = service(() => outcome)
    await svc.connect(OWNER, bundle(FUTURE_TOKEN))
    await svc.refreshSeatLiveness(OWNER)
    outcome = { kind: 'ok', httpStatus: 200 }
    clock += SEAT_LIVENESS_TTL_MS + 1
    await svc.refreshSeatLiveness(OWNER)
    // A brand-new service object = a restarted gateway with an empty cache, and
    // one that cannot reach the network at all.
    const restarted = new CodexCredentialService({
      store,
      codexHome,
      rotation: new SqliteCodexRotationStore(db),
      now: () => clock,
      probe: async () => ({ kind: 'unreachable', message: 'no network after restart' }),
    })
    expect(restarted.everySeatRevoked(OWNER)).toBe(false)
    expect(restarted.status(OWNER).status).toBe('connected')
  })

  test('N (ANTI-OVERRETRACT): a non-verdict does NOT withdraw a revocation', async () => {
    // The retraction must key on POSITIVE evidence — the server saying yes — not
    // merely on the absence of another 401. An unreachable endpoint after a
    // measured revocation leaves the seat cooled.
    let outcome: CodexProbeOutcome = { kind: 'revoked', httpStatus: 401 }
    const svc = service(() => outcome)
    await svc.connect(OWNER, bundle(FUTURE_TOKEN))
    await svc.refreshSeatLiveness(OWNER)
    for (const later of [
      { kind: 'unreachable', message: 'ECONNREFUSED' },
      { kind: 'rate_limited', httpStatus: 429 },
      { kind: 'rejected', httpStatus: 404 },
      { kind: 'expired', httpStatus: 401 },
    ] as CodexProbeOutcome[]) {
      outcome = later
      clock += SEAT_LIVENESS_TTL_MS + 1
      await svc.refreshSeatLiveness(OWNER)
      expect(svc.everySeatRevoked(OWNER)).toBe(true)
      expect(svc.listAccounts(OWNER)[0]?.cooling_reason).toBe('unauthorized')
    }
  })

  test('N (ANTI-OVERRETRACT): an `ok` probe never clears a RATE-LIMIT cooldown', async () => {
    // A quota cooldown is a rotation decision with its own timer and its own
    // evidence. A liveness probe knows nothing about quota, and clearing it would
    // rotate a capped seat straight back into service.
    const svc = service(() => ({ kind: 'ok', httpStatus: 200 }))
    await svc.connect(OWNER, bundle(FUTURE_TOKEN))
    // Force the slot row into existence first — `setCooldown` is an UPDATE and
    // would silently no-op against a seat the service has not synced yet, which
    // would make this test pass with the retraction clearing everything.
    expect(svc.listAccounts(OWNER)).toHaveLength(1)
    const rotation = new SqliteCodexRotationStore(db)
    rotation.setCooldown(OWNER, 'default', {
      cooling_until: clock + 3_600_000,
      cooling_reason: 'rate-limited',
    })
    await svc.refreshSeatLiveness(OWNER)
    expect(svc.listAccounts(OWNER)[0]?.cooling_reason).toBe('rate-limited')
    expect(svc.listAccounts(OWNER)[0]?.cooling).toBe(true)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 403 IS NOT A CREDENTIAL VERDICT. chatgpt.com is edge-fronted and this probe
  // sends only Authorization + Accept; a bot-management 403 arrives on every seat
  // at once and says nothing about the token.
  // ───────────────────────────────────────────────────────────────────────────
  test('a 403 leaves the seat CONNECTED and cools nothing', async () => {
    const svc = realProbeService(403)
    await svc.connect(OWNER, bundle(FUTURE_TOKEN))
    await svc.refreshSeatLiveness(OWNER)
    expect(svc.status(OWNER).status).toBe('connected')
    expect(svc.everySeatRevoked(OWNER)).toBe(false)
    expect(svc.listAccounts(OWNER)[0]?.cooling_reason ?? null).toBeNull()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // WHICH COPY IS PROBED. The CLI rewrites CODEX_HOME/auth.json on every refresh
  // and harvest-back into the store is fire-and-forget, so the store copy is
  // routinely days stale. A SUPERSEDED access token has an exp in the future —
  // exactly the input that yields `revoked`.
  // ───────────────────────────────────────────────────────────────────────────
  test('the MATERIALIZED auth.json is probed, not the staler store copy', async () => {
    const seen: Array<{ accessToken: string; expInFuture: boolean }> = []
    const svc = realProbeService(200, seen)
    const STORE_TOKEN = jwtWithExp(Math.floor(NOW / 1000) + 3600)
    const DISK_TOKEN = jwtWithExp(Math.floor(NOW / 1000) + 999_999)
    await svc.connect(OWNER, bundle(STORE_TOKEN))
    // The CLI refreshes mid-run: the file on disk moves on, the store does not.
    writeFileSync(join(codexHome, 'auth.json'), bundle(DISK_TOKEN))
    await svc.refreshSeatLiveness(OWNER)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.accessToken).toBe(DISK_TOKEN)
    expect(seen[0]?.accessToken).not.toBe(STORE_TOKEN)
  })

  test('…and falls back to the store copy when nothing is materialized', async () => {
    const seen: Array<{ accessToken: string; expInFuture: boolean }> = []
    const svc = realProbeService(200, seen)
    await svc.connect(OWNER, bundle(FUTURE_TOKEN))
    rmSync(join(codexHome, 'auth.json'), { force: true })
    await svc.refreshSeatLiveness(OWNER)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.accessToken).toBe(FUTURE_TOKEN)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// P4 — DISPATCH. The point of the card: a doomed lane never spawns.
// ─────────────────────────────────────────────────────────────────────────────
describe('dispatch preflight (P4)', () => {
  let tmp: string
  let db: ProjectDb
  let runs: TridentRunStore

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'codex-probe-dispatch-'))
    seedMigratedDb(join(tmp, 'project.db'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    runs = new TridentRunStore(db)
  })
  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  const CTX = { project_slug: 'proj-1', project_id: null, topic_id: null, call_id: 'c1', speaker_user_id: null }
  const READY = 'wire the CSV export button to the new endpoint, with tests for the empty case'

  function board(): TridentBoardBinder {
    return {
      get: (_slug, id) => (id === 'ready' ? { id: 'ready', title: READY, design_doc_ref: null } : null),
      attachRun: async () => {},
    }
  }
  function localProbe(): GitModeProbe {
    return {
      credential: { owner_handle: 'test-owner', source: 'test stub', load: async () => ({}) },
      hasGithubOrigin: async () => false,
      publisherAvailable: async () => ({ authenticated: true }),
    }
  }
  function tools(preflight?: () => Promise<{ ok: true } | { ok: false; reason: string }>): ToolRegistry {
    const reg = new ToolRegistry()
    registerTridentBuildToolSurface(reg, {
      store: runs,
      work_board: board(),
      repo_path: '/repo',
      resolveBuildRepo: async (home) => home,
      merge_mode_probe: localProbe(),
      resolveRalph: async () => false,
      ...(preflight !== undefined ? { preflight } : {}),
    })
    return reg
  }
  const runCount = (): number =>
    db.prepare<{ n: number }, []>(`SELECT COUNT(*) AS n FROM code_trident_runs`).get()?.n ?? -1

  test('P4: a revoked seat REFUSES the dispatch and creates NO run row', async () => {
    const tool = tools(async () => ({ ok: false, reason: 'the connected Codex seat was REVOKED server-side — reconnect it' }))
      .get(WORK_BOARD_DISPATCH_BUILD_TOOL)!
    const before = runCount()
    const out = (await tool.handler({ board_item_id: 'ready', task: READY }, CTX)) as {
      ok: boolean
      error?: string
      run_id?: string
    }
    expect(out.ok).toBe(false)
    expect(out.error?.toLowerCase()).toContain('revoked')
    expect(out.run_id).toBeUndefined()
    // THE ASSERTION THAT MATTERS: nothing was spawned.
    expect(runCount()).toBe(before)
  })

  test('P4b: `work_board_start` (the ▶ retry path) is refused the same way', async () => {
    const tool = tools(async () => ({ ok: false, reason: 'the connected Codex seat was REVOKED server-side — reconnect it' }))
      .get(WORK_BOARD_START_TOOL)!
    const before = runCount()
    const out = (await tool.handler({ board_item_id: 'ready' }, CTX)) as { ok: boolean; error?: string }
    expect(out.ok).toBe(false)
    expect(out.error?.toLowerCase()).toContain('revoked')
    expect(runCount()).toBe(before)
  })

  test('N (ANTI-OUTAGE): with no preflight wired, dispatch is unchanged', async () => {
    const tool = tools().get(WORK_BOARD_DISPATCH_BUILD_TOOL)!
    const out = (await tool.handler({ board_item_id: 'ready', task: READY }, CTX)) as { ok: boolean; run_id?: string }
    expect(out.ok).toBe(true)
    expect(typeof out.run_id).toBe('string')
    expect(runCount()).toBe(1)
  })

  test('N (ANTI-OUTAGE): a passing preflight dispatches normally', async () => {
    const tool = tools(async () => ({ ok: true })).get(WORK_BOARD_DISPATCH_BUILD_TOOL)!
    const out = (await tool.handler({ board_item_id: 'ready', task: READY }, CTX)) as { ok: boolean }
    expect(out.ok).toBe(true)
    expect(runCount()).toBe(1)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // THE GATE LIVES AT THE CHOKEPOINT, NOT AT ONE CALLER.
  //
  // `dispatchBoardBoundBuild` has THREE production callers — the agent tools, the
  // app's ▶ start/retry closure (`open/composer.ts` `boardStartBuild`, consumed by
  // `gateway/http/work-board-surface.ts`), and `/code`
  // (`trident/code-command.ts`). Wiring the preflight into the tool handler gated
  // ONE of them; the owner's primary dispatch paths kept the old behaviour
  // verbatim. These drive the chokepoint and the `/code` executor directly.
  // ───────────────────────────────────────────────────────────────────────────
  const REFUSAL =
    'Refusing to start this build: the Build phase runs on Codex and the connected Codex seat was REVOKED server-side. No run was created.'

  function chokepointDeps(
    preflight?: () => Promise<{ ok: true } | { ok: false; reason: string }>,
  ): BoardBoundBuildDeps {
    return {
      store: runs,
      board: board(),
      project_slug: 'proj-1',
      repo_path: '/repo',
      resolveBuildRepo: async (home) => home,
      resolveMergeMode: async () => 'local',
      resolveRalph: async () => false,
      ...(preflight !== undefined ? { preflight } : {}),
    }
  }

  test('CHOKEPOINT: a refusing preflight rejects with `executor_unavailable` and creates NO run', async () => {
    const before = runCount()
    const out = await dispatchBoardBoundBuild(
      { board_item_id: 'ready', task: READY },
      chokepointDeps(async () => ({ ok: false, reason: REFUSAL })),
    )
    expect(out.ok).toBe(false)
    expect(out.ok === false ? out.code : '').toBe('executor_unavailable')
    expect(out.ok === false ? out.message : '').toBe(REFUSAL)
    expect(runCount()).toBe(before)
  })

  test('CHOKEPOINT N (ANTI-OUTAGE): the same dispatch with a PASSING preflight runs', async () => {
    const out = await dispatchBoardBoundBuild(
      { board_item_id: 'ready', task: READY },
      chokepointDeps(async () => ({ ok: true })),
    )
    expect(out.ok).toBe(true)
    expect(runCount()).toBe(1)
  })

  test('CHOKEPOINT N: with NO preflight wired the chokepoint is unchanged', async () => {
    const out = await dispatchBoardBoundBuild({ board_item_id: 'ready', task: READY }, chokepointDeps())
    expect(out.ok).toBe(true)
    expect(runCount()).toBe(1)
  })

  test('a bound_pr REVIEW round is NOT refused with a sentence about the Build phase', async () => {
    // The refusal names the BUILD phase's executor. A `bound_pr` round does not
    // run that phase, so refusing one here would misattribute the cause — and the
    // preflight ran BEFORE `bound_pr` was consulted, so it did exactly that.
    let called = 0
    const out = await dispatchBoardBoundBuild(
      { board_item_id: 'ready', task: 'review PR #123', bound_pr: 123 },
      chokepointDeps(async () => {
        called += 1
        return { ok: false, reason: REFUSAL }
      }),
    )
    expect(called).toBe(0)
    expect(out.ok).toBe(true)
    expect(out.ok === true ? out.run.bound_pr : null).toBe(123)
  })

  test('/code (the chat command) is refused by the SAME gate — and creates no run', async () => {
    const before = runCount()
    const refused = await executeCodeCommand(
      { kind: 'dispatch', task: READY, board_item_id: 'ready' },
      {
        store: runs,
        work_board: board(),
        project_slug: 'proj-1',
        repo_path: '/repo',
        resolveBuildRepo: async (home) => home,
        resolveMergeMode: async () => 'local',
        resolveRalph: async () => false,
        preflight: async () => ({ ok: false, reason: REFUSAL }),
      },
    )
    expect(refused.error?.code).toBe('backend_error')
    expect(refused.text).toContain('No run was created')
    expect(runCount()).toBe(before)

    // POSITIVE CONTROL: the identical `/code` with a passing gate DOES build, so
    // the refusal above is the gate and not some unrelated malformed context.
    const allowed = await executeCodeCommand(
      { kind: 'dispatch', task: READY, board_item_id: 'ready' },
      {
        store: runs,
        work_board: board(),
        project_slug: 'proj-1',
        repo_path: '/repo',
        resolveBuildRepo: async (home) => home,
        resolveMergeMode: async () => 'local',
        resolveRalph: async () => false,
        preflight: async () => ({ ok: true }),
      },
    )
    expect(allowed.error).toBeUndefined()
    expect(runCount()).toBe(before + 1)
  })

  test('EVERY production caller of the chokepoint hands it a preflight (wiring guard)', () => {
    // The ▶ closure lives inside `buildOpenComposition` and cannot be imported by
    // a unit test (it needs a whole gateway). What CAN be checked, and what the
    // last round got wrong, is that no dispatch entry is left unwired: every
    // non-test file that calls `dispatchBoardBoundBuild` must pass `preflight`.
    // An EMPTY extraction FAILS rather than reading as a pass.
    const grep = spawnSync(
      'git',
      ['grep', '-l', '--untracked', 'dispatchBoardBoundBuild(', '--', 'open', 'trident', 'gateway'],
      { cwd: REPO, encoding: 'utf8' },
    )
    const callers = (grep.stdout ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.includes('.test.') && !l.includes('__tests__'))
      .filter((f) => f !== 'trident/board-dispatch.ts') // the definition is not a caller
    // The known production entries, named — a caller that disappears from this
    // list is as interesting as one that forgets the gate.
    //
    // `dispatch-holds.ts` is the FOURTH, added with the dependency-aware
    // dispatch rebuild: its sweep re-fires a held card through this same
    // chokepoint when the blocker completes. It is listed here only because it
    // is genuinely wired (composer appends the sweep to both terminal-observer
    // chains) AND genuinely gated — its `makeDispatchDeps` requires a
    // `preflight` in the TYPE, so the grep below is backed by the compiler
    // rather than by a comment that happens to contain the word.
    expect(callers.sort()).toEqual([
      'open/composer.ts',
      'trident/code-command.ts',
      'trident/dispatch-holds.ts',
      'trident/work-board-build-tool.ts',
    ])
    for (const file of callers) {
      const src = `${file}: ${readFileSync(join(REPO, file), 'utf8')}`
      expect(src).toContain('preflight')
      // …AND THE CREDENTIAL, on the same enumeration (Argus r17). `hostRunner` is
      // the seam the built-never-reviewed seed's `ls-remote` probe reads, and it
      // had been wired on `work_board_dispatch_build` while `work_board_start` —
      // the RETRY path the card exists for — dropped it, so every re-dispatch
      // probed uncredentialed and adopted nothing. Textual here for the same
      // reason `preflight` is (these entries are closures inside a composition);
      // the BEHAVIOUR is proven against a private origin, per tool entry, in
      // `work-board-build-tool.test.ts`, and `dispatch-holds.ts` additionally
      // demands it in the TYPE so the compiler backs this word up.
      expect(src).toContain('hostRunner')
    }
    // …and the ▶ closure specifically: the same shared object, by name, inside
    // the `boardStartBuild` dispatch call.
    //
    // FOUR uses, not four entries: the three dispatch entries above, plus the
    // hold sweep's `makeDispatchDeps`, which rebuilds deps for a card it
    // re-fires later and must hand it the SAME gate. Counting by name is the
    // point — it proves the sweep shares the one probe rather than quietly
    // constructing a second, differently-behaved one.
    const composer = readFileSync(join(REPO, 'open', 'composer.ts'), 'utf8')
    expect((composer.match(/preflight: tridentCodexBuildPreflight/g) ?? []).length).toBe(4)
  })
})

describe('codexDispatchPreflight — only a codex BUILD is ever blocked', () => {
  const revokedDeps = {
    refreshLiveness: async (): Promise<void> => {},
    everySeatRevoked: (): boolean => true,
    reason: (): string => 'the connected Codex seat was REVOKED server-side — reconnect it',
  }

  test('the default build phase does NOT run on codex (this is why blanket refusal would be an outage)', () => {
    expect(buildPhaseRunsOnCodex({})).toBe(false)
    expect(buildPhaseRunsOnCodex({ build: { model: 'opus' } })).toBe(false)
  })

  test('a codex-tier build phase DOES', () => {
    expect(buildPhaseRunsOnCodex({ build: { model: 'sol' } })).toBe(true)
  })

  test('P4c: codex build + every seat revoked → refused', async () => {
    const out = await codexDispatchPreflight({ phaseModels: () => ({ build: { model: 'sol' } }), ...revokedDeps })
    expect(out.ok).toBe(false)
    expect(out.ok === false ? out.reason.toLowerCase() : '').toContain('revoked')
  })

  test('N: a CLAUDE build with the same dead seat is allowed — the review degrades, the build does not', async () => {
    const out = await codexDispatchPreflight({ phaseModels: () => ({}), ...revokedDeps })
    expect(out.ok).toBe(true)
  })

  test('N: a codex build with a HEALTHY seat is allowed', async () => {
    const out = await codexDispatchPreflight({
      phaseModels: () => ({ build: { model: 'sol' } }),
      refreshLiveness: async () => {},
      everySeatRevoked: () => false,
      reason: () => 'unused',
    })
    expect(out.ok).toBe(true)
  })

  test('N: a THROWING liveness refresh allows the build — the fix must not become the outage', async () => {
    const out = await codexDispatchPreflight({
      phaseModels: () => ({ build: { model: 'sol' } }),
      refreshLiveness: async () => {
        throw new Error('network down')
      },
      everySeatRevoked: () => true,
      reason: () => 'unused',
    })
    expect(out.ok).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// P5 — THE WRAPPER. The measured false green, encoded: `codex login status`
// exits 0 (it only reads a file) while the endpoint returns 401.
// ─────────────────────────────────────────────────────────────────────────────
// THE GUARD THAT WOULD HAVE CAUGHT THE COUNTDOWN. Both shell fixtures are asserted
// against the SAME real clock the wrappers read, so if either ever stops straddling
// "now" this fails here with a clear reason, instead of surfacing as three unrelated
// shell cases going red on a date nobody connects to a fixture.
describe('the shell fixtures are relative to the real clock, not a fixed date', () => {
  function expOf(jwt: string): number {
    return JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()).exp as number
  }
  test('the future fixture is genuinely in the future, and the past one genuinely past', () => {
    const nowSec = Math.floor(Date.now() / 1000)
    expect(expOf(SHELL_FUTURE_TOKEN)).toBeGreaterThan(nowSec)
    expect(expOf(SHELL_PAST_TOKEN)).toBeLessThan(nowSec)
    // NEGATIVE CONTROL — the pinned TS fixture is NOT safe to use here, and this
    // records why: it is a fixed calendar date, so this same comparison is a
    // countdown. Asserting the reader, not the value, keeps this honest whichever
    // side of 2026-08-28 the suite runs on.
    expect(String(FUTURE_TOKEN)).not.toBe(String(SHELL_FUTURE_TOKEN))
  })
})


describe('codex-build.sh auth precheck probes the endpoint (P5)', () => {
  const seen: Array<{ path: string; auth: string }> = []
  let httpStatus = 401
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      seen.push({ path: `${url.pathname}${url.search}`, auth: req.headers.get('Authorization') ?? '' })
      return new Response(JSON.stringify(loadCapture().body), { status: httpStatus })
    },
  })
  const stubUrl = `http://127.0.0.1:${server.port}/backend-api/codex/models?client_version=0.147.0`

  afterAll(() => {
    server.stop(true)
  })

  const BRIEF_TEXT = 'You are FORGE. Build the thing on branch trident/probe-run.\n'

  interface WrapperRun {
    status: number | null
    stderr: string
  }

  /**
   * The wrapper, run far enough to reach the auth precheck.
   *
   * A REAL `codex` mock whose `login status` EXITS 0 — the exact false green
   * measured on this box — plus a real `curl` and a real local endpoint. Nothing
   * about the thing under test is stubbed: only the endpoint's address moves.
   */
  async function runWrapper(access: string | null): Promise<WrapperRun> {
    const dir = mkdtempSync(join(tmpdir(), 'codex-probe-wrapper-'))
    const codexHome = join(dir, 'codexhome')
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(
      join(codexHome, 'auth.json'),
      JSON.stringify(access === null ? { tokens: {} } : { tokens: { access_token: access, refresh_token: 'r' } }),
    )
    const bin = join(dir, 'bin')
    mkdirSync(bin, { recursive: true })
    // `login status` EXITS 0 on a revoked seat. That is the defect, fixtured.
    const mock = join(bin, 'codex')
    writeFileSync(mock, '#!/bin/sh\nif [ "$1" = "login" ] && [ "$2" = "status" ]; then exit 0; fi\nexit 0\n')
    chmodSync(mock, 0o755)

    const git = (...args: string[]): void => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
    }
    git('init', '-q', '-b', 'trident/probe-run')
    git('config', 'user.email', 'build@localhost')
    git('config', 'user.name', 'build')
    writeFileSync(join(dir, 'file.txt'), 'base\n')
    git('add', 'file.txt')
    git('commit', '-q', '-m', 'base')

    const brief = join(dir, 'brief.txt')
    writeFileSync(brief, BRIEF_TEXT)
    // SPAWNED ASYNCHRONOUSLY, and that is not a style choice: the stub endpoint
    // is served by THIS process's event loop, so a blocking `spawnSync` would
    // deadlock — curl would wait for a server that cannot answer until the
    // wrapper it is blocking has exited, and every probe would time out looking
    // exactly like an unreachable endpoint.
    const child = Bun.spawn(['bash', join(REPO, 'trident', 'codex-build.sh'), 'trident/probe-run'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...(process.env as Record<string, string>),
        PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`,
        CODEX_HOME: codexHome,
        NEUTRON_CODEX_BUILD_BRIEF_FILE: brief,
        // The wrapper refuses a brief it cannot verify (CODEX_BUILD_NO_BRIEF_INTEGRITY)
        // BEFORE it reaches the auth precheck — so the receipt the workflow would
        // compute has to be supplied, or every case below fails for the wrong reason.
        NEUTRON_CODEX_BUILD_BRIEF_INTEGRITY: briefIntegrity(BRIEF_TEXT),
        NEUTRON_CODEX_BUILD_TRAILER_FILE: join(dir, 'trailer.txt'),
        NEUTRON_CODEX_AUTH_PROBE_URL: stubUrl,
        NEUTRON_CODEX_AUTH_RETRY_DELAY: '0',
        NEUTRON_CODEX_AUTH_PROBE_TIMEOUT: '5',
      },
    })
    const stderr = await new Response(child.stderr).text()
    const status = await child.exited
    rmSync(dir, { recursive: true, force: true })
    return { status, stderr }
  }

  test('P5: `codex login status` passes, the endpoint 401s → DEFERRED (exit 3)', async () => {
    seen.length = 0
    httpStatus = 401
    const out = await runWrapper(SHELL_FUTURE_TOKEN)
    expect(out.status).toBe(3)
    expect(out.stderr).toContain('CODEX_BUILD_AUTH_EXPIRED')
    expect(out.stderr).toContain('REVOKED')
    // POSITIVE CONTROL ON THE PROBE: it really made an authenticated request. If
    // curl were missing or the token unreadable the wrapper would skip the probe,
    // and this assertion — not a silent pass — is what says so.
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0]?.auth).toBe(`Bearer ${SHELL_FUTURE_TOKEN}`)
    expect(seen[0]?.path).toContain('client_version=')
  })

  test('N7 (ANTI-HARDCODE): the same wrapper with a 200 does NOT fail the auth precheck', async () => {
    seen.length = 0
    httpStatus = 200
    const out = await runWrapper(SHELL_FUTURE_TOKEN)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    // It may still DEFER later for its own reasons (no diff, no worktree) — what
    // must not happen is failing on AUTH.
    expect(out.stderr).not.toContain('CODEX_BUILD_AUTH_EXPIRED')
  })

  test('N2: a 500 from the endpoint does NOT fail the auth precheck', async () => {
    seen.length = 0
    httpStatus = 500
    const out = await runWrapper(SHELL_FUTURE_TOKEN)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(out.stderr).not.toContain('CODEX_BUILD_AUTH_EXPIRED')
  })

  test('N: an auth.json with no access_token skips the probe and keeps the old behaviour', async () => {
    seen.length = 0
    httpStatus = 401
    const out = await runWrapper(null)
    expect(seen.length).toBe(0)
    expect(out.stderr).not.toContain('CODEX_BUILD_AUTH_EXPIRED')
  })

  // ───────────────────────────────────────────────────────────────────────────
  // THE CLOCK, IN THE SHELL. `codex-probe.ts` calls the exp check "THE WHOLE
  // CLASSIFICATION"; the wrapper had no clock at all and treated every 401/403 as
  // fatal. An access token whose `exp` has passed but whose refresh_token is live
  // is a NORMAL, SELF-HEALING state here — the CLI refreshes auth.json at exec
  // time, which is the entire premise of the harvest-back path — and a seat that
  // has been idle or rotated away is routinely in it. Deferring that build (and
  // calling it REVOKED) is the same misleading-cause defect this card exists to
  // remove, one layer down.
  // ───────────────────────────────────────────────────────────────────────────
  test('P5b: an EXPIRED access token + 401 does NOT fail the precheck (the CLI refreshes it)', async () => {
    seen.length = 0
    httpStatus = 401
    const out = await runWrapper(SHELL_PAST_TOKEN)
    // POSITIVE CONTROL: the probe really ran with this token — otherwise "no
    // AUTH_EXPIRED" would be satisfied by a wrapper that skipped the probe
    // entirely (no curl, unreadable token) and this would assert nothing.
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0]?.auth).toBe(`Bearer ${SHELL_PAST_TOKEN}`)
    expect(out.stderr).not.toContain('CODEX_BUILD_AUTH_EXPIRED')
    expect(out.stderr).not.toContain('REVOKED')
  })

  test('P5c: the discriminator is the TOKEN, not the endpoint — same 401, future exp, DEFERRED', async () => {
    // The pair. Same server, same status, same second: only the token's own `exp`
    // differs, and that alone decides. Without this, P5b passes against a wrapper
    // that simply stopped checking auth.
    seen.length = 0
    httpStatus = 401
    const out = await runWrapper(SHELL_FUTURE_TOKEN)
    expect(out.status).toBe(3)
    expect(out.stderr).toContain('CODEX_BUILD_AUTH_EXPIRED')
    expect(out.stderr).toContain('REVOKED')
  })

  test('N: a 403 does NOT fail the precheck — an edge refusal is not a credential fact', async () => {
    seen.length = 0
    httpStatus = 403
    const out = await runWrapper(SHELL_FUTURE_TOKEN)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(out.stderr).not.toContain('CODEX_BUILD_AUTH_EXPIRED')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// P5R — THE REVIEW WRAPPER. `codex-review.sh` carries a COPY of the precheck
// (deliberately duplicated: the two wrappers are copied to other repos
// independently), so it carries the defect independently too. A DEFERRED review
// is never treated as an approval, which makes a false one a stalled PR.
// ─────────────────────────────────────────────────────────────────────────────
describe('codex-review.sh auth precheck applies the same clock (P5R)', () => {
  const seen: Array<{ path: string; auth: string }> = []
  let httpStatus = 401
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      seen.push({ path: `${url.pathname}${url.search}`, auth: req.headers.get('Authorization') ?? '' })
      return new Response(JSON.stringify(loadCapture().body), { status: httpStatus })
    },
  })
  const stubUrl = `http://127.0.0.1:${server.port}/backend-api/codex/models?client_version=0.147.0`

  afterAll(() => {
    server.stop(true)
  })

  async function runReviewWrapper(access: string): Promise<{ status: number | null; stderr: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'codex-probe-review-'))
    const codexHome = join(dir, 'codexhome')
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(
      join(codexHome, 'auth.json'),
      JSON.stringify({ tokens: { access_token: access, refresh_token: 'r' } }),
    )
    const bin = join(dir, 'bin')
    mkdirSync(bin, { recursive: true })
    // The same measured false green: `login status` exits 0 on a dead seat.
    const mock = join(bin, 'codex')
    writeFileSync(mock, '#!/bin/sh\nexit 0\n')
    chmodSync(mock, 0o755)
    const child = Bun.spawn(['bash', join(REPO, 'trident', 'codex-review.sh'), 'main'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...(process.env as Record<string, string>),
        PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`,
        CODEX_HOME: codexHome,
        NEUTRON_CODEX_AUTH_PROBE_URL: stubUrl,
        NEUTRON_CODEX_AUTH_RETRY_DELAY: '0',
        NEUTRON_CODEX_AUTH_PROBE_TIMEOUT: '5',
      },
    })
    const stderr = await new Response(child.stderr).text()
    const status = await child.exited
    rmSync(dir, { recursive: true, force: true })
    return { status, stderr }
  }

  test('P5R: 401 on a token whose exp is in the FUTURE → DEFERRED, named REVOKED', async () => {
    seen.length = 0
    httpStatus = 401
    const out = await runReviewWrapper(SHELL_FUTURE_TOKEN)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0]?.auth).toBe(`Bearer ${SHELL_FUTURE_TOKEN}`)
    expect(out.status).toBe(3)
    expect(out.stderr).toContain('CODEX_REVIEW_AUTH_EXPIRED')
    expect(out.stderr).toContain('REVOKED')
  })

  test('P5R b: the SAME 401 on an already-EXPIRED token does NOT fail the precheck', async () => {
    seen.length = 0
    httpStatus = 401
    const out = await runReviewWrapper(SHELL_PAST_TOKEN)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0]?.auth).toBe(`Bearer ${SHELL_PAST_TOKEN}`)
    expect(out.stderr).not.toContain('CODEX_REVIEW_AUTH_EXPIRED')
  })

  test('P5R c: a 200 does not fail the precheck either (the anti-hardcode control)', async () => {
    seen.length = 0
    httpStatus = 200
    const out = await runReviewWrapper(SHELL_FUTURE_TOKEN)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(out.stderr).not.toContain('CODEX_REVIEW_AUTH_EXPIRED')
  })
})
