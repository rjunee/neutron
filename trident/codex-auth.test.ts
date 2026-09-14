/**
 * `trident/codex-auth.ts` — pure validation + materialize + status.
 *
 * The hard rule under test: SUBSCRIPTION auth (tokens.refresh_token) is accepted
 * + normalized; a metered OPENAI_API_KEY (auth_mode=apikey) or a bare sk- paste
 * is REJECTED. Materialization writes a 0600 auth.json at CODEX_HOME so
 * codex-review.sh's exit-10 NOT_CONNECTED branch is bypassed.
 */

import { describe, expect, test, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  codexAuthPath,
  assertCodexControlSocketPath,
  codexControlSocketPath,
  CODEX_CONTROL_SOCKET_PATH_MAX_BYTES,
  CodexControlSocketPathError,
  codexProjectHome,
  deriveCodexStatus,
  materializeCodexAuth,
  readMaterializedAuth,
  removeCodexAuth,
  resolveCodexHome,
  validateCodexSubscriptionAuth,
  type CodexAuthFile,
} from './codex-auth.ts'

const NOW = 1_800_000_000_000 // fixed clock
const now = (): number => NOW

async function bindUnixSocket(path: string): Promise<NodeJS.ErrnoException | null> {
  mkdirSync(dirname(path), { recursive: true })
  const server = createServer()
  return await new Promise((resolve) => {
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error))
    server.listen(path, () => server.close(() => resolve(null)))
  })
}

/** Build a minimal JWT access token with the given `exp` (seconds). */
function jwt(expSeconds: number): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp: expSeconds })}.sig`
}

/** A well-formed subscription auth.json blob. */
function subscriptionAuth(opts: { exp?: number; openaiKey?: string | null } = {}): string {
  const access = opts.exp !== undefined ? jwt(opts.exp) : 'opaque-access-token'
  return JSON.stringify({
    OPENAI_API_KEY: opts.openaiKey ?? null,
    tokens: {
      id_token: 'id-tok',
      access_token: access,
      refresh_token: 'refresh-tok',
      account_id: 'acct_123',
    },
    last_refresh: '2026-06-30T00:00:00.000Z',
  })
}

describe('validateCodexSubscriptionAuth', () => {
  test('accepts a subscription auth.json and normalizes it (strips OPENAI_API_KEY)', () => {
    const v = validateCodexSubscriptionAuth(subscriptionAuth(), now)
    expect(v.ok).toBe(true)
    expect(v.mode).toBe('subscription')
    const parsed = JSON.parse(v.normalized ?? '{}') as CodexAuthFile
    expect(parsed.tokens.access_token).toBe('opaque-access-token')
    expect(parsed.tokens.refresh_token).toBe('refresh-tok')
    expect(parsed.tokens.id_token).toBe('id-tok')
    // OPENAI_API_KEY must NOT survive into the normalized bundle.
    expect((parsed as { OPENAI_API_KEY?: unknown }).OPENAI_API_KEY).toBeUndefined()
    expect(parsed.last_refresh).toBe('2026-06-30T00:00:00.000Z')
  })

  test('REJECTS a metered OPENAI_API_KEY inside auth.json (auth_mode=apikey)', () => {
    const v = validateCodexSubscriptionAuth(subscriptionAuth({ openaiKey: 'sk-live-abc123' }), now)
    expect(v.ok).toBe(false)
    expect(v.mode).toBe('apikey')
    expect(v.code).toBe('metered_key')
    expect(v.error?.toLowerCase()).toContain('metered')
  })

  test('REJECTS a bare sk- API key paste as metered', () => {
    const v = validateCodexSubscriptionAuth('sk-proj-ABCDEF0123456789', now)
    expect(v.ok).toBe(false)
    expect(v.mode).toBe('apikey')
    expect(v.code).toBe('metered_key')
  })

  test('rejects apikey-mode auth.json (no tokens, only OPENAI_API_KEY)', () => {
    const v = validateCodexSubscriptionAuth(
      JSON.stringify({ OPENAI_API_KEY: 'sk-abc', tokens: null, last_refresh: null }),
      now,
    )
    expect(v.ok).toBe(false)
    expect(v.code).toBe('metered_key')
  })

  test('rejects auth.json missing refresh_token (not a subscription login)', () => {
    const v = validateCodexSubscriptionAuth(
      JSON.stringify({ tokens: { access_token: 'a' }, last_refresh: 'x' }),
      now,
    )
    expect(v.ok).toBe(false)
    expect(v.code).toBe('missing_tokens')
    expect(v.error).toContain('refresh_token')
  })

  test('rejects malformed / non-JSON / empty', () => {
    expect(validateCodexSubscriptionAuth('', now).code).toBe('malformed')
    expect(validateCodexSubscriptionAuth('not json {', now).code).toBe('malformed')
    expect(validateCodexSubscriptionAuth('[1,2,3]', now).code).toBe('malformed')
    expect(validateCodexSubscriptionAuth(42, now).code).toBe('malformed')
  })

  test('defaults last_refresh to now when absent/invalid', () => {
    const v = validateCodexSubscriptionAuth(
      JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r' } }),
      now,
    )
    expect(v.ok).toBe(true)
    const parsed = JSON.parse(v.normalized ?? '{}') as CodexAuthFile
    expect(parsed.last_refresh).toBe(new Date(NOW).toISOString())
  })
})

describe('materializeCodexAuth + resolveCodexHome', () => {
  let tmp: string
  afterEach(() => {
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true })
  })

  test('resolveCodexHome is <owner_home>/.codex', () => {
    expect(resolveCodexHome({ owner_home: '/data/owner' })).toBe('/data/owner/.codex')
  })

  test('a realistically long project id produces a bounded control socket that binds', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'codex-socket-'))
    const projectId = `customer-import-${'x'.repeat(112)}`
    const projectHome = codexProjectHome(join(tmp, '.codex'), projectId)
    const socketPath = codexControlSocketPath(projectHome)

    expect(projectHome.split('/').at(-1)).toHaveLength(22)
    expect(Buffer.byteLength(socketPath, 'utf8')).toBeLessThanOrEqual(
      CODEX_CONTROL_SOCKET_PATH_MAX_BYTES,
    )

    // A BIND HERE IS CORROBORATION, NOT THE GUARD. Measured on this kernel: `node:net`
    // and `Bun.listen` both bind pathnames up to 109 bytes, i.e. they are WIDER than the
    // rule Codex (and libc) enforce at 107 — so a successful bind cannot witness the
    // boundary and only the byte assertion above can. The boundary is pinned separately,
    // against the measured subject, in the test below.
    const bindError = await bindUnixSocket(socketPath)
    if (bindError?.code === 'EPERM') {
      // Some restricted test runners forbid AF_UNIX binds altogether. Prove that
      // environmental refusal with a known-short positive control; anywhere that
      // permits sockets must exercise the real bind above successfully.
      const controlError = await bindUnixSocket(join(tmp, 'short.sock'))
      expect(controlError?.code).toBe('EPERM')
    } else {
      expect(bindError).toBeNull()
    }
  })

  test('a composed control socket over the bound is refused, never truncated', () => {
    // MULTIBYTE ON PURPOSE: 33 × 'é' is 33 characters and 66 bytes, so a length-based
    // check would pass this and a byte-based one must not.
    const overlongGlobalHome = `/${'é'.repeat(33)}`
    const unboundedSocket = codexControlSocketPath(overlongGlobalHome)
    expect(Buffer.byteLength(unboundedSocket, 'utf8')).toBeGreaterThan(
      CODEX_CONTROL_SOCKET_PATH_MAX_BYTES,
    )

    expect(() => assertCodexControlSocketPath(overlongGlobalHome)).toThrow(
      CodexControlSocketPathError,
    )
    expect(() => assertCodexControlSocketPath(overlongGlobalHome)).toThrow(
      /control socket path is \d+ bytes; the Linux maximum is 107 bytes/,
    )
    // REFUSED, NOT SHORTENED. A truncating implementation would have returned SOMETHING —
    // a prefix that binds at the wrong place is worse than the overrun it replaces — so
    // the absence of a return value is asserted rather than assumed.
    let returned: unknown = 'not-called'
    try {
      returned = assertCodexControlSocketPath(overlongGlobalHome)
    } catch {
      returned = 'threw'
    }
    expect(returned).toBe('threw')
  })

  /**
   * THE BOUND, IN BOTH DIRECTIONS, ON THE EXACT BYTE IT TURNS.
   *
   * An over-bound case alone is satisfied by a guard that refuses everything, which is the
   * most common real defect here. So the byte BELOW the boundary must be accepted by the
   * same call that refuses the byte above it.
   *
   * The numbers are not this file's opinion: `codex app-server daemon version`
   * (codex-cli 0.154.0) was run against CODEX_HOMEs composed to put the derived socket
   * pathname on each side of the line. 107 connects; 108 answers `path must be shorter
   * than SUN_LEN`. A raw libc AF_UNIX bind agrees (107 binds, 108 is ENAMETOOLONG).
   */
  test('the bound turns between 107 and 108 bytes — accepted below, refused above', () => {
    const suffixBytes = Buffer.byteLength(codexControlSocketPath(''), 'utf8')
    // `codexControlSocketPath('')` is the relative suffix, so its length is what a home
    // contributes on top of. Guard the arithmetic rather than trusting it.
    expect(suffixBytes).toBeGreaterThan(0)
    const homeOf = (socketBytes: number): string => {
      const home = `/${'h'.repeat(socketBytes - suffixBytes - 2)}`
      expect(Buffer.byteLength(codexControlSocketPath(home), 'utf8')).toBe(socketBytes)
      return home
    }

    const atBound = homeOf(CODEX_CONTROL_SOCKET_PATH_MAX_BYTES)
    expect(assertCodexControlSocketPath(atBound)).toBe(atBound)

    const overBound = homeOf(CODEX_CONTROL_SOCKET_PATH_MAX_BYTES + 1)
    expect(() => assertCodexControlSocketPath(overBound)).toThrow(CodexControlSocketPathError)
  })

  /**
   * THE RESOLVERS ARE TOTAL, AND THAT IS A DECISION — not an omission (#637).
   *
   * A CODEX_HOME serves two unrelated purposes: it holds `auth.json` (what every caller in
   * this tree does) and it is what a daemon derives a control socket from (what no caller
   * in this tree does — SPEC.md records that `codex app-server daemon start` refuses on
   * this install for want of a managed standalone distribution). Enforcing the socket
   * bound at directory resolution charged the first for the second. MEASURED: a 26-byte
   * owner home — `<home>/neutron`, the `resolveNeutronHome` default — pushed the composed
   * project socket to 109 bytes, so `codexProjectHome` threw; that is the single call
   * behind `connect`, `status`, `refreshSeatLiveness` and `resolveActiveCodexHome` for a
   * PROJECT-scoped seat, and a project-scoped Codex credential that works today would have
   * stopped working on a box that never binds a socket.
   *
   * This asserts that decision positively, so re-adding the throw to either resolver reds
   * here and has to argue with this comment rather than sail past it. The refusal itself is
   * not weakened — the test above still requires it of the gate that owns it.
   */
  test('the resolvers stay total over an over-long home; only the socket gate refuses', () => {
    const longOwnerHome = `/${'o'.repeat(120)}`
    const global = resolveCodexHome({ owner_home: longOwnerHome })
    expect(global).toBe(`${longOwnerHome}/.codex`)
    const project = codexProjectHome(global, 'proj-alpha')
    expect(project.startsWith(`${global}/projects/`)).toBe(true)
    expect(project.split('/').at(-1)).toHaveLength(22)

    // …and the gate that DOES own the bound still refuses this very path, so the two
    // assertions above are a scoping decision and not a hole.
    expect(Buffer.byteLength(codexControlSocketPath(project), 'utf8')).toBeGreaterThan(
      CODEX_CONTROL_SOCKET_PATH_MAX_BYTES,
    )
    expect(() => assertCodexControlSocketPath(project)).toThrow(CodexControlSocketPathError)
  })

  test('writes auth.json at CODEX_HOME with mode 0600', () => {
    tmp = mkdtempSync(join(tmpdir(), 'codex-mat-'))
    const codexHome = join(tmp, '.codex')
    const { path } = materializeCodexAuth({ codexHome, authJson: subscriptionAuth() })
    expect(path).toBe(codexAuthPath(codexHome))
    expect(existsSync(path)).toBe(true)
    // 0600 — owner rw only (mirrors chatgpt-oauth writeCodexAuthFile).
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readMaterializedAuth(codexHome)).not.toBeNull()
    removeCodexAuth(codexHome)
    expect(readMaterializedAuth(codexHome)).toBeNull()
    // removeCodexAuth is idempotent.
    expect(() => removeCodexAuth(codexHome)).not.toThrow()
  })
})

describe('deriveCodexStatus', () => {
  test('connected when tokens present and access token unexpired', () => {
    const s = deriveCodexStatus(subscriptionAuth({ exp: Math.floor(NOW / 1000) + 3600 }), {
      materialized: true,
      now,
    })
    expect(s.status).toBe('connected')
    expect(s.materialized).toBe(true)
    expect(s.expires_at).toBeDefined()
  })

  test('connected (opaque, non-JWT token) — treated as non-expiring here', () => {
    const s = deriveCodexStatus(subscriptionAuth(), { materialized: true, now })
    expect(s.status).toBe('connected')
    expect(s.expires_at).toBeUndefined()
  })

  test('expired when the access-token JWT exp is in the past', () => {
    const s = deriveCodexStatus(subscriptionAuth({ exp: Math.floor(NOW / 1000) - 10 }), {
      materialized: true,
      now,
    })
    expect(s.status).toBe('expired')
    expect(s.expires_at).toBeDefined()
  })

  test('not_connected for null / unreadable / tokenless', () => {
    expect(deriveCodexStatus(null, { materialized: false, now }).status).toBe('not_connected')
    expect(deriveCodexStatus('{not json', { materialized: false, now }).status).toBe('not_connected')
    expect(
      deriveCodexStatus(JSON.stringify({ tokens: {} }), { materialized: false, now }).status,
    ).toBe('not_connected')
  })
})
