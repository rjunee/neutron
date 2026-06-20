/**
 * credential-rotation-rekey.test.ts — S3 §2 acceptance #2 (closes #104).
 *
 * The selected credential id (`PooledCredential.id`, NEVER the secret) is folded
 * into the warm-pool key. So when credential A goes into cooldown and the next
 * turn selects B, the key CHANGES → a fresh REPL cold-spawns under B's env
 * instead of re-using the child spawned with A's OAuth token. Cooldown
 * attribution then matches the child serving the turn (the bug #104 names).
 *
 * This file proves the substrate-level re-key + the non-secret invariant. The
 * env-threading (`reportSuccess`/`reportFailure` keyed on the new cred id, the
 * scrubbed spawn env carrying B's token) is exercised by the gateway composer
 * credential suite (`build-llm-call-substrate.test.ts`,
 * `build-import-substrate.test.ts`).
 */

import { describe, it, expect, afterEach } from 'bun:test'
import type { AgentSpec } from '../../../../substrate.ts'
import type { SessionHandle } from '../../../../session-handle.ts'
import type { Event } from '../../../../events.ts'
import type { PtyChild, PtyHost } from '../pty-host.ts'
import {
  createPersistentReplSubstrate,
  getReplSinkInfo,
  poolKeyFor,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'

afterEach(async () => {
  await shutdownAllPersistentRepls()
})

function makeEchoHost(): { host: PtyHost; spawnCount: () => number; envs: Array<Record<string, string | undefined>> } {
  let spawns = 0
  const envs: Array<Record<string, string | undefined>> = []
  const host: PtyHost = {
    spawn(argv: string[], hostOpts?: { env?: Record<string, string | undefined> }): PtyChild {
      spawns += 1
      const pid = 100000 + spawns
      if (hostOpts?.env !== undefined) envs.push(hostOpts.env)
      const i = argv.indexOf('--session-id')
      const r = argv.indexOf('--resume')
      const sid = (i >= 0 ? argv[i + 1] : r >= 0 ? argv[r + 1] : undefined) as string
      const { port: sinkPort, token } = getReplSinkInfo()
      let hasExited = false
      let exitResolve: (code: number | null) => void = () => {}
      const exited = new Promise<number | null>((res) => {
        exitResolve = res
      })
      const post = (path: string, body: unknown): Promise<unknown> =>
        fetch(`http://127.0.0.1:${sinkPort}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sink-Token': token },
          body: JSON.stringify(body),
        }).catch(() => undefined)
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === '/health') return Response.json({ ok: true })
          if (req.method === 'POST' && url.pathname === '/message') {
            const body = (await req.json()) as { text: string; turn_id?: string }
            void post('/reply', { session_id: sid, text: `echo:${body.text}`, turn_id: body.turn_id })
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid })
      return {
        pid,
        write() {},
        resize() {},
        kill() {
          if (hasExited) return
          hasExited = true
          try {
            server.stop(true)
          } catch {
            /* ignore */
          }
          exitResolve(143)
        },
        exited,
        hasExited: () => hasExited,
      }
    },
  }
  return { host, spawnCount: () => spawns, envs }
}

function opts(host: PtyHost, extra: Partial<PersistentReplSubstrateOptions>): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'cc-llm-acme',
    cwd: '/tmp/neutron-acme',
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
    ...extra,
  }
}

function spec(prompt: string): AgentSpec {
  return { prompt, tools: [], model_preference: ['claude-opus-4-7'] }
}

async function drain(handle: SessionHandle): Promise<string> {
  let text = ''
  for await (const ev of handle.events as AsyncIterable<Event>) {
    if (ev.kind === 'token') text += ev.text
    else if (ev.kind === 'completion') return text
    else if (ev.kind === 'error') throw new Error(`drain error: ${ev.message}`)
  }
  return text
}

describe('credential rotation re-keys the warm pool (closes #104)', () => {
  it('rotating the selected credential (A→B) for the same (instance,user,project) spawns a NEW REPL', async () => {
    const { host, spawnCount, envs } = makeEchoHost()
    const identity = { user_id: 'u-1', project_id: 'default' } as const

    // Turn 1+2 under credential A → ONE warm REPL (re-used).
    const credA1 = createPersistentReplSubstrate(
      opts(host, { ...identity, credential_identity: 'cred-A', env: { CLAUDE_CODE_OAUTH_TOKEN: 'token-A' } }),
    )
    await drain(credA1.start(spec('one')))
    const credA2 = createPersistentReplSubstrate(
      opts(host, { ...identity, credential_identity: 'cred-A', env: { CLAUDE_CODE_OAUTH_TOKEN: 'token-A' } }),
    )
    await drain(credA2.start(spec('two')))
    expect(spawnCount()).toBe(1) // same credential → warm reuse

    // A goes into cooldown; turn 3 selects B → the key changes → a FRESH REPL.
    const credB = createPersistentReplSubstrate(
      opts(host, { ...identity, credential_identity: 'cred-B', env: { CLAUDE_CODE_OAUTH_TOKEN: 'token-B' } }),
    )
    await drain(credB.start(spec('three')))
    expect(spawnCount()).toBe(2) // rotation re-keyed → a new spawn, NOT the stale A child

    // The new child was spawned under B's env (the stale-credential child was
    // never re-used — the exact bug #104 names).
    const lastEnv = envs[envs.length - 1]
    expect(lastEnv?.['CLAUDE_CODE_OAUTH_TOKEN']).toBe('token-B')
  })

  it('the rotated key differs only by credential_identity and never contains the token', () => {
    const keyA = poolKeyFor({
      substrate_instance_id: 'cc-llm-acme',
      user_id: 'u-1',
      project_id: 'default',
      credential_identity: 'cred-A',
    })
    const keyB = poolKeyFor({
      substrate_instance_id: 'cc-llm-acme',
      user_id: 'u-1',
      project_id: 'default',
      credential_identity: 'cred-B',
    })
    expect(keyA).not.toBe(keyB)
    expect(keyA).toContain('cred-A')
    expect(keyA).not.toContain('token-A')
    expect(keyB).not.toContain('token-B')
  })

  it('ISSUES #49 — an overlay var set to `undefined` is DELETED from the spawned child env (no host leak)', async () => {
    // The composer scrubs host auth vars by setting them to `undefined` in the
    // overlay. With the persistent REPL now the sole substrate, `mergeEnv` MUST
    // honor undefined-as-delete so a host-leaked ANTHROPIC_API_KEY can't survive
    // into the child and out-rank the pool credential.
    const HOST_KEY = 'ANTHROPIC_API_KEY'
    const had = Object.prototype.hasOwnProperty.call(process.env, HOST_KEY)
    const prior = process.env[HOST_KEY]
    process.env[HOST_KEY] = 'host-key-DO-NOT-USE'
    try {
      const { host, envs } = makeEchoHost()
      const sub = createPersistentReplSubstrate(
        opts(host, {
          user_id: 'u-49',
          project_id: 'default',
          credential_identity: 'cred-oauth',
          // Composer-shaped scrub overlay: unset API key, set the OAuth token.
          env: { ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: 'pool-oauth-token' },
        }),
      )
      await drain(sub.start(spec('hello')))
      const childEnv = envs[envs.length - 1]!
      // The host key is GONE (deleted), not present-as-undefined.
      expect(HOST_KEY in childEnv).toBe(false)
      // The selected pool credential survives.
      expect(childEnv['CLAUDE_CODE_OAUTH_TOKEN']).toBe('pool-oauth-token')
      // An unrelated host var (PATH) still inherits.
      expect(childEnv['PATH']).toBeDefined()
    } finally {
      if (had) process.env[HOST_KEY] = prior!
      else delete process.env[HOST_KEY]
    }
  })
})

describe('warm REPL never serves a turn on a stale OAuth token (closes Codex r2 P1)', () => {
  it('a SAME-credential-id token REFRESH evicts the stale warm REPL and respawns under the new token', async () => {
    const { host, spawnCount, envs } = makeEchoHost()
    // Same (instance,user,project,credential) across all turns — the pool key folds
    // the STABLE PooledCredential.id (`cred-A`), NOT the rotating token VALUE. The
    // existing A→B test covers credential ROTATION; this covers a per-dispatch
    // OAuth REFRESH under the SAME id, which the pool key alone does NOT catch.
    const identity = { user_id: 'u-1', project_id: 'default', credential_identity: 'cred-A' } as const

    // Turn 1 spawns the warm REPL under token-A.
    const t1 = createPersistentReplSubstrate(
      opts(host, { ...identity, env: { CLAUDE_CODE_OAUTH_TOKEN: 'token-A' } }),
    )
    await drain(t1.start(spec('one')))
    expect(spawnCount()).toBe(1)

    // Turn 2: the composer's per-dispatch refresh rotated the access token
    // (token-A → token-A2). The warm child still holds the now-EXPIRED token-A, so
    // the credential-freshness guard must evict + respawn under token-A2 — pre-fix
    // it reused the stale child and every turn would fail after the token expired.
    const t2 = createPersistentReplSubstrate(
      opts(host, { ...identity, env: { CLAUDE_CODE_OAUTH_TOKEN: 'token-A2' } }),
    )
    await drain(t2.start(spec('two')))
    expect(spawnCount()).toBe(2)
    expect(envs[envs.length - 1]?.['CLAUDE_CODE_OAUTH_TOKEN']).toBe('token-A2')

    // Turn 3: the refresh returned the SAME still-valid token (no rotation) → warm
    // reuse, NO respawn. The guard fires on token CHANGE only, so we don't churn
    // the REPL (and lose context) on every dispatch — the objection to folding the
    // token into the pool key.
    const t3 = createPersistentReplSubstrate(
      opts(host, { ...identity, env: { CLAUDE_CODE_OAUTH_TOKEN: 'token-A2' } }),
    )
    await drain(t3.start(spec('three')))
    expect(spawnCount()).toBe(2)
  })

  it('interactive-Max-login model: claudeConfigDir threads CLAUDE_CONFIG_DIR and the freshness guard stays inert (self-refresh, no env token)', async () => {
    const { host, spawnCount, envs } = makeEchoHost()
    const identity = { user_id: 'u-cfg', project_id: 'default', credential_identity: 'cred-cfg' } as const
    const cfgDir = '/tmp/neutron-acme/.claude-cfg'

    // No env auth token — auth flows through the config dir's `.credentials.json`
    // (refresh_token) and the child SELF-REFRESHES. The durable Codex-r2-P1 fix.
    const c1 = createPersistentReplSubstrate(
      opts(host, { ...identity, claudeConfigDir: cfgDir, env: {} }),
    )
    await drain(c1.start(spec('one')))
    expect(spawnCount()).toBe(1)
    // CLAUDE_CONFIG_DIR reaches the child so `claude` reads/refreshes its own creds.
    expect(envs[envs.length - 1]?.['CLAUDE_CONFIG_DIR']).toBe(cfgDir)

    // A second turn carries no env token either side → empty fingerprints → warm
    // reuse, NO respawn: a self-refreshing child is never needlessly churned.
    const c2 = createPersistentReplSubstrate(
      opts(host, { ...identity, claudeConfigDir: cfgDir, env: {} }),
    )
    await drain(c2.start(spec('two')))
    expect(spawnCount()).toBe(1)
  })
})
