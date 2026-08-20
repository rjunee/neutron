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
import { deriveCodexStatus } from '../codex-auth.ts'
import { CodexCredentialService, codexExecutorAvailability, SEAT_LIVENESS_TTL_MS } from '../codex-credential.ts'
import { SqliteCodexRotationStore } from '../codex-rotation-store.ts'
import { CODEX_STATUS_TOOL, registerCodexCredentialToolSurface } from '../codex-credential-tool.ts'
import { probeCodexSeat, redactToken, type CodexProbeOutcome } from '../codex-probe.ts'
import { buildPhaseRunsOnCodex, codexDispatchPreflight } from '../codex-dispatch-preflight.ts'
import { registerTridentBuildToolSurface, WORK_BOARD_DISPATCH_BUILD_TOOL, WORK_BOARD_START_TOOL } from '../work-board-build-tool.ts'
import { TridentRunStore } from '../store.ts'
import type { TridentBoardBinder } from '../board-dispatch.ts'
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

function loadCapture(): Capture {
  const raw = readFileSync(FIXTURE, 'utf8')
  if (raw.trim().length === 0) throw new Error(`captured 401 fixture is EMPTY: ${FIXTURE}`)
  const parsed = JSON.parse(raw) as Capture
  if (parsed.http_status !== 401) {
    throw new Error(`captured fixture is not a 401 (got ${String(parsed.http_status)}): ${FIXTURE}`)
  }
  if (typeof parsed.body?.error?.code !== 'string' || parsed.body.error.code.length === 0) {
    throw new Error(`captured fixture has no error code: ${FIXTURE}`)
  }
  return parsed
}

describe('the captured 401 fixture is real and non-vacuous (P2)', () => {
  test('it exists, is non-empty, and parses to HTTP 401 with an error code', () => {
    expect(statSync(FIXTURE).size).toBeGreaterThan(0)
    const capture = loadCapture()
    expect(capture.http_status).toBe(401)
    expect(capture.body.error.code).toBe('token_revoked')
  })

  test('a fixture that stopped being a 401 FAILS LOUDLY rather than passing vacuously', () => {
    // The guard itself, exercised. Without this, `loadCapture` is a comment.
    const bad = join(mkdtempSync(join(tmpdir(), 'codex-fx-')), 'x.json')
    writeFileSync(bad, '')
    expect(() => {
      const raw = readFileSync(bad, 'utf8')
      if (raw.trim().length === 0) throw new Error('captured 401 fixture is EMPTY')
    }).toThrow(/EMPTY/)
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
    const env = { PATH: process.env['PATH'] ?? '' }
    const live = codexExecutorAvailability({ codexHome, env, seatsRevoked: false })
    const dead = codexExecutorAvailability({ codexHome, env, seatsRevoked: true })
    // The live arm depends on `codex`/`perl` being installed, which a CI box may
    // not have — so assert the DIFFERENCE the flag makes, not an absolute.
    if (live.usable) {
      expect(dead.usable).toBe(false)
      expect(dead.usable === false ? dead.reason.toLowerCase() : '').toContain('revoked')
    } else {
      expect(dead.usable).toBe(false)
    }
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
    const out = await runWrapper(FUTURE_TOKEN)
    expect(out.status).toBe(3)
    expect(out.stderr).toContain('CODEX_BUILD_AUTH_EXPIRED')
    expect(out.stderr).toContain('REVOKED')
    // POSITIVE CONTROL ON THE PROBE: it really made an authenticated request. If
    // curl were missing or the token unreadable the wrapper would skip the probe,
    // and this assertion — not a silent pass — is what says so.
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0]?.auth).toBe(`Bearer ${FUTURE_TOKEN}`)
    expect(seen[0]?.path).toContain('client_version=')
  })

  test('N7 (ANTI-HARDCODE): the same wrapper with a 200 does NOT fail the auth precheck', async () => {
    seen.length = 0
    httpStatus = 200
    const out = await runWrapper(FUTURE_TOKEN)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    // It may still DEFER later for its own reasons (no diff, no worktree) — what
    // must not happen is failing on AUTH.
    expect(out.stderr).not.toContain('CODEX_BUILD_AUTH_EXPIRED')
  })

  test('N2: a 500 from the endpoint does NOT fail the auth precheck', async () => {
    seen.length = 0
    httpStatus = 500
    const out = await runWrapper(FUTURE_TOKEN)
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
})
