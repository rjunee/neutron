/**
 * owner-mcp-servers.test.ts — the owner's installed MCP servers reach the SPAWN.
 *
 * Two links, and either can be dropped while the other still passes:
 *
 *   1. THE CONFIG. The server must appear in `--mcp-config`'s `mcpServers`, or
 *      `claude` never starts it.
 *   2. THE ALLOW-LIST. Its `mcp__<name>` namespace must appear in `--allowedTools`,
 *      or its tools hit a per-call permission prompt no headless REPL can answer —
 *      the server starts and is useless.
 *
 * They are asserted SEPARATELY, in both the positive and the negative, because
 * "wired" is a conjunction and a single combined assertion would let half of it rot.
 *
 * THE SECURITY BLOCK is the point of the file. The history-import (`cc-import-*`) and
 * disposable Trident (`cc-trident-*`) REPLs run untrusted content under
 * `--dangerously-skip-permissions` with `tools: []` default-deny, specifically to close
 * a prompt-injection vector. An owner-installed MCP server is a SUBPROCESS — strictly
 * more capability than any built-in tool — so those substrates must receive none, and
 * the tests assert that they receive none EVEN WHEN handed the resolver, because the
 * second gate in `spawn.ts` is what makes a future wiring mistake survivable.
 *
 * THE REUSE BLOCK pins the two symmetric ways to get warm-session reuse wrong: too
 * coarse and an installed server never appears until a restart; too sensitive and the
 * owner pays a cold spawn on every single message. Both are silent in production.
 */

import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'

import {
  OWNER_MCP_STARTUP_BUDGET_MS,
  OWNER_MCP_STARTUP_TIMEOUT_FLOOR_MS,
  OWNER_MCP_STARTUP_TIMEOUT_MS,
  ownerMcpStartupTimeoutMs,
} from '../signatures.ts'
import { MCP_SERVERS_MAX } from '../../../../mcp-servers.ts'

import type { Event } from '../../../../events.ts'
import type { ResolvedOwnerMcpServer } from '../../../../mcp-servers.ts'
import type { SessionHandle } from '../../../../session-handle.ts'
import type { AgentSpec } from '../../../../substrate.ts'
import type { PtyChild, PtyHost, PtySpawnOpts } from '../pty-host.ts'
import { pool } from '../pool-state.ts'
import { poolKeyFor } from '../pool.ts'
// The supervision respawn's own entry point (`supervision.ts` calls exactly this), used
// by the no-dispatch eviction test to reproduce a spawn with no turn driver behind it.
import { getOrSpawnSession } from '../spawn.ts'
import type { ReplSession } from '../repl-session.ts'
import {
  createPersistentReplSubstrate,
  evictWarmReplsForMcpSurfaceChange,
  getReplSinkInfo,
  setReplToolBridge,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
  type ReplToolBridge,
} from '../persistent-repl-substrate.ts'

/**
 * HEADROOM, because the budgets in `opts()` are the same size as bun's default per-test
 * timeout. `readyBudgetMs`/`healthBudgetMs` are 5000 and the default timeout is 5000, so a
 * test whose fake spawn takes its full budget on a loaded machine is killed by the RUNNER
 * at the same instant the code under test would have succeeded — and the kill lands
 * mid-`afterEach`, which cascades into unrelated failures in the next test. Measured on a
 * contended box: 26 pass / 3 fail, and 29 pass / 0 fail with `--timeout 90000`.
 *
 * Raising the runner's patience rather than lowering the budget is deliberate. The budget
 * is what lets a genuinely slow spawn succeed; shrinking it to fit the runner would make
 * the suite flakier on exactly the slow machines this is about, and would weaken an
 * assertion (`bounds the blocking MCP startup wait`) that reads the budget.
 */
setDefaultTimeout(90_000)

afterEach(async () => {
  await shutdownAllPersistentRepls()
  setReplToolBridge(undefined)
})

const EXAMPLE: ResolvedOwnerMcpServer = {
  name: 'example-server',
  command: '/usr/local/bin/example-mcp',
  args: ['--stdio', '--region', 'eu'],
  env_names: ['EXAMPLE_API_KEY'],
  env: { EXAMPLE_API_KEY: 'sk-not-a-real-key' },
}

/** Echo host capturing every spawn's argv + env (mirrors `tool-bridge.test.ts`). */
function makeCapturingHost(
  /** Awaited before the fake child posts its reply, so a test can hold a turn IN FLIGHT
   *  and observe what happens to a session that is genuinely busy. Omitted ⇒ the reply
   *  goes out immediately, which is what every other test in this file wants. */
  replyGate?: () => Promise<void>,
  /** Awaited before the fake child announces its dev-channel, so a test can hold a COLD
   *  SPAWN in flight — the window in which the pool holds an unresolved promise and no
   *  `ReplSession` exists yet to carry `activeTurn` / `turnSlotHeld`. Omitted ⇒ the
   *  channel is announced immediately, which is what every other test here wants. */
  readyGate?: () => Promise<void>,
): {
  host: PtyHost
  argvs: string[][]
  envs: Array<Record<string, string | undefined>>
  /** Real `PtyChild.kill()` calls. A dropped pool entry is not a dead child, so the
   *  eviction test asserts on THIS rather than on the returned counts alone. */
  kills: { n: number }
} {
  const argvs: string[][] = []
  const envs: Array<Record<string, string | undefined>> = []
  const kills = { n: 0 }
  let spawns = 0
  const host: PtyHost = {
    spawn(argv: string[], spawnOpts: PtySpawnOpts): PtyChild {
      spawns += 1
      argvs.push(argv)
      envs.push(spawnOpts.env ?? {})
      const pid = 410000 + spawns
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
      let seen = 0
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === '/health') return Response.json({ ok: true })
          if (req.method === 'POST' && url.pathname === '/message') {
            const body = (await req.json()) as { text: string; turn_id?: string }
            const n = seen
            seen += 1
            void (async () => {
              if (replyGate !== undefined) await replyGate()
              await post('/reply', { session_id: sid, text: `ok=${n} ${body.text}`, turn_id: body.turn_id })
            })()
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      void (async () => {
        // Held back when a test passes `readyGate`: the post-spawn assertion waits on
        // `/channel-ready`, so delaying it leaves the POOL holding an unresolved spawn —
        // the cold-dispatch window. Otherwise it goes out on this tick, unchanged.
        if (readyGate !== undefined) await readyGate()
        await post('/channel-ready', { session_id: sid, channel_port: server.port, pid })
        await post('/channel-bound', { session_id: sid })
      })()
      return {
        pid,
        write() {},
        resize() {},
        kill() {
          if (hasExited) return
          kills.n += 1
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
  return { host, argvs, envs, kills }
}

function opts(
  host: PtyHost,
  extra: Partial<PersistentReplSubstrateOptions>,
): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'cc-agent-acme',
    cwd: '/tmp/neutron-acme-mcp',
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    skip_permissions: true,
    user_id: 'u-1',
    project_id: 'default',
    credential_identity: 'cred-1',
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: {
      readyBudgetMs: 5000,
      readyIntervalMs: 25,
      healthBudgetMs: 5000,
      healthIntervalMs: 25,
    },
    ...extra,
  }
}

function spec(prompt: string, tools: string[] = ['Read']): AgentSpec {
  return {
    prompt,
    tools: tools.map((name) => ({ name })) as AgentSpec['tools'],
    model_preference: ['claude-opus-4-7'],
  }
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

/** A bridge advertising one tool, so `enableToolBridge` actually attaches. */
function bridge(): ReplToolBridge {
  return {
    listToolSchemas: () => [
      { name: 'doc_search', description: 'search docs', input_schema: { type: 'object' } },
    ],
    dispatch: async () => ({ ok: true }),
  }
}

function mcpConfig(argv: string[]): {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
} {
  return JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1]!, 'utf8'))
}

function allowedTools(argv: string[]): string[] {
  const i = argv.indexOf('--allowedTools')
  return i < 0 ? [] : argv[i + 1]!.split(',')
}

describe('an approved server reaches BOTH the config and the allow-list', () => {
  it('appears in mcpServers with its exact command, args and env', async () => {
    setReplToolBridge(bridge())
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, resolveExtraMcpServers: async () => [EXAMPLE] }),
    )
    await drain(sub.start(spec('hi')))

    const entry = mcpConfig(argvs[0]!).mcpServers['example-server']
    expect(entry).toBeDefined()
    // The exact argv the approval prompt described — not a normalised variant.
    expect(entry!.command).toBe('/usr/local/bin/example-mcp')
    expect(entry!.args).toEqual(['--stdio', '--region', 'eu'])
    expect(entry!.env).toEqual({ EXAMPLE_API_KEY: 'sk-not-a-real-key' })
  })

  it('gets its OWN mcp__<name> grant, alongside the tool bridge\'s', async () => {
    // The second, separable link: in the config but not the allow-list means the
    // server starts and every tool call hits a prompt nobody can answer.
    setReplToolBridge(bridge())
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, resolveExtraMcpServers: async () => [EXAMPLE] }),
    )
    await drain(sub.start(spec('hi')))

    const granted = allowedTools(argvs[0]!)
    expect(granted).toContain('mcp__neutron')
    expect(granted).toContain('mcp__example-server')
  })

  it('keeps the dev-channel sink and the tool bridge working exactly as before', async () => {
    // The regression that would break chat entirely: merging over a built-in key.
    setReplToolBridge(bridge())
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, resolveExtraMcpServers: async () => [EXAMPLE] }),
    )
    await drain(sub.start(spec('hi')))

    const names = Object.keys(mcpConfig(argvs[0]!).mcpServers)
    expect(names.some((n) => n.startsWith('neutron-'))).toBe(true) // dev-channel reply sink
    expect(names).toContain('neutron') // in-process tool bridge
    expect(names).toContain('example-server')
  })

  it('grants the allow-list for an installed server even with NO bridge tools', async () => {
    // The bridge attaches only when the registry has ≥1 tool. An empty registry must
    // not silently switch off the owner's servers, which are unrelated to it.
    setReplToolBridge({ listToolSchemas: () => [], dispatch: async () => ({}) })
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, resolveExtraMcpServers: async () => [EXAMPLE] }),
    )
    await drain(sub.start(spec('hi')))

    expect(allowedTools(argvs[0]!)).toEqual(['mcp__example-server'])
    expect(mcpConfig(argvs[0]!).mcpServers['neutron']).toBeUndefined()
  })

  it('resolving NONE leaves the spawn byte-identical to before this feature', async () => {
    setReplToolBridge(bridge())
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, resolveExtraMcpServers: async () => [] }),
    )
    await drain(sub.start(spec('hi')))

    expect(allowedTools(argvs[0]!)).toEqual(['mcp__neutron'])
    expect(Object.keys(mcpConfig(argvs[0]!).mcpServers)).toHaveLength(2)
  })

  it('refuses to let an installed server shadow a built-in name', async () => {
    // Belt and braces behind the name validator: which of the two survived a
    // collision would otherwise be decided by merge order.
    setReplToolBridge(bridge())
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, {
        enableToolBridge: true,
        resolveExtraMcpServers: async () => [{ ...EXAMPLE, name: 'neutron' }],
      }),
    )
    await drain(sub.start(spec('hi')))

    // The BRIDGE still owns `neutron`, and the impostor got no grant.
    expect(mcpConfig(argvs[0]!).mcpServers['neutron']!.command).toBe('bun')
    expect(allowedTools(argvs[0]!)).toEqual(['mcp__neutron'])
  })
})

describe('SECURITY: the untrusted substrates receive nothing', () => {
  it('an import REPL gets no server and no grant, EVEN handed the resolver', async () => {
    // `cc-import-*` runs untrusted imported content with `tools: []`. The second gate
    // in `spawn.ts` (`enableToolBridge` required) is what makes this hold even if a
    // future wiring change mistakenly passes the resolver here.
    setReplToolBridge(bridge())
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, {
        substrate_instance_id: 'cc-import-acme',
        project_id: 'import',
        resolveExtraMcpServers: async () => [EXAMPLE],
      }),
    )
    await drain(sub.start(spec('untrusted chunk', [])))

    const cfg = mcpConfig(argvs[0]!)
    expect(cfg.mcpServers['example-server']).toBeUndefined()
    expect(allowedTools(argvs[0]!)).toEqual([])
    // And the default-deny built-in surface is untouched by any of this.
    expect(argvs[0]!).toContain('--tools')
    expect(argvs[0]![argvs[0]!.indexOf('--tools') + 1]).toBe('')
  })

  it('a disposable Trident REPL gets no server and no grant, EVEN handed the resolver', async () => {
    setReplToolBridge(bridge())
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, {
        substrate_instance_id: 'cc-trident-acme',
        project_id: 'build',
        resolveExtraMcpServers: async () => [EXAMPLE],
      }),
    )
    await drain(sub.start(spec('build something', [])))

    expect(mcpConfig(argvs[0]!).mcpServers['example-server']).toBeUndefined()
    expect(allowedTools(argvs[0]!)).toEqual([])
  })

  it('the resolver is not even CALLED on an untrusted substrate', async () => {
    // Stronger than "the output is empty": an untrusted spawn must not reach into the
    // owner's credential store to decrypt secrets it can never be given.
    setReplToolBridge(bridge())
    const { host } = makeCapturingHost()
    let calls = 0
    const sub = createPersistentReplSubstrate(
      opts(host, {
        substrate_instance_id: 'cc-import-acme',
        project_id: 'import',
        resolveExtraMcpServers: async () => {
          calls += 1
          return [EXAMPLE]
        },
      }),
    )
    await drain(sub.start(spec('untrusted chunk', [])))
    expect(calls).toBe(0)
  })

  it('the config file stays owner-only, secrets and all', async () => {
    setReplToolBridge(bridge())
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, resolveExtraMcpServers: async () => [EXAMPLE] }),
    )
    await drain(sub.start(spec('hi')))

    const path = argvs[0]![argvs[0]!.indexOf('--mcp-config') + 1]!
    const { statSync } = await import('node:fs')
    // 0600: the file now carries the dev-channel token AND every installed server's
    // secrets, so any same-uid process being able to read it would be a real leak.
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('the config — SECRETS AND ALL — is gone once the session is torn down', async () => {
    setReplToolBridge(bridge())
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, resolveExtraMcpServers: async () => [EXAMPLE] }),
    )
    await drain(sub.start(spec('hi')))
    const cfgPath = argvs[0]![argvs[0]!.indexOf('--mcp-config') + 1]!
    const cfgDir = dirname(cfgPath)
    expect(existsSync(cfgPath)).toBe(true)

    await shutdownAllPersistentRepls()
    // The FILE went, and so did its 0700 directory — which used to survive every spawn
    // forever, one per session, in `tmpdir()`.
    expect(existsSync(cfgPath)).toBe(false)
    expect(existsSync(cfgDir)).toBe(false)
  })

  it('A FAILED SPAWN STRANDS NOTHING — no plaintext secrets left in tmpdir', async () => {
    // The window: the config is written, then `buildSettings` / trust-seeding / the
    // spawn itself can throw, and cleanup is owned by the child-exit handler — which
    // does not exist yet. A throw there left the MCP config, holding the dev-channel
    // token and every installed server's env VALUES, sitting in `tmpdir()` for the life
    // of the box.
    setReplToolBridge(bridge())
    const dirsBefore = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('neutron-repl-')))
    const exploding: PtyHost = {
      spawn(): PtyChild {
        throw new Error('pty host refused to spawn')
      },
    }
    const sub = createPersistentReplSubstrate(
      opts(exploding, { enableToolBridge: true, resolveExtraMcpServers: async () => [EXAMPLE] }),
    )
    await expect(drain(sub.start(spec('hi')))).rejects.toThrow()

    const leaked = readdirSync(tmpdir()).filter(
      (n) => n.startsWith('neutron-repl-') && !dirsBefore.has(n),
    )
    expect(leaked).toEqual([])
  })
})

describe('a THIRD-PARTY handshake cannot wedge the owner\'s live chat', () => {
  it('bounds the blocking MCP startup wait when an installed server is wired', async () => {
    // `MCP_CONNECTION_NONBLOCKING=false` makes `claude` AWAIT the MCP handshake before
    // accepting input. That was safe while the config held only our own two `bun`
    // scripts; an owner-installed program that accepts a connection and never completes
    // `initialize` would hold that wait open inside the post-spawn assertion's 30 s ready
    // budget, on the PRIMARY conversational REPL, and present as `channel-wedged`.
    setReplToolBridge(bridge())
    const { host, envs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, resolveExtraMcpServers: async () => [EXAMPLE] }),
    )
    await drain(sub.start(spec('hi')))

    // Still blocking — the dev-channel bind guarantee is unchanged…
    expect(envs[0]!['MCP_CONNECTION_NONBLOCKING']).toBe('false')
    // …but now BOUNDED, and well under the ready budget.
    expect(envs[0]!['MCP_TIMEOUT']).toBe(String(OWNER_MCP_STARTUP_TIMEOUT_MS))
    expect(OWNER_MCP_STARTUP_TIMEOUT_MS).toBeLessThan(30_000)
  })

  it('DIVIDES the bound across servers, because MCP_TIMEOUT is per-server', async () => {
    // The bound and the budget it was "chosen against" measure different things:
    // `MCP_TIMEOUT` gates ONE server's `initialize`, `readyBudgetMs` gates the whole
    // spawn. A flat 10 s let each of eight hung servers honour its own timeout while
    // collectively blowing the budget — and whether `claude` loads them serially is
    // not something this repo has verified, so the bound is sized for the worse case.
    setReplToolBridge(bridge())
    const { host, envs } = makeCapturingHost()
    const many: ResolvedOwnerMcpServer[] = Array.from({ length: 8 }, (_, i) => ({
      ...EXAMPLE,
      name: `example-${i}`,
    }))
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, resolveExtraMcpServers: async () => many }),
    )
    await drain(sub.start(spec('hi')))

    const perServer = Number(envs[0]!['MCP_TIMEOUT'])
    expect(perServer).toBeLessThan(OWNER_MCP_STARTUP_TIMEOUT_MS)
    // The SERIAL worst case fits the share of the ready budget the load may take.
    expect(perServer * many.length).toBeLessThanOrEqual(OWNER_MCP_STARTUP_BUDGET_MS)
  })

  it('stops dividing at a floor, and does not pretend the floor closes the gap', () => {
    // One or two servers keep exactly the bound they had, so the ordinary case is
    // untouched by the division.
    expect(ownerMcpStartupTimeoutMs(1)).toBe(OWNER_MCP_STARTUP_TIMEOUT_MS)
    expect(ownerMcpStartupTimeoutMs(2)).toBe(OWNER_MCP_STARTUP_TIMEOUT_MS)
    expect(ownerMcpStartupTimeoutMs(4)).toBe(OWNER_MCP_STARTUP_BUDGET_MS / 4)
    // At the installed maximum the floor wins, and the honest consequence is asserted
    // rather than papered over: the serial worst case CAN exceed the budget. A timeout
    // short enough to fit would fail healthy servers, which trades a rare slow spawn
    // for a permanently broken one.
    expect(ownerMcpStartupTimeoutMs(MCP_SERVERS_MAX)).toBe(OWNER_MCP_STARTUP_TIMEOUT_FLOOR_MS)
    expect(OWNER_MCP_STARTUP_TIMEOUT_FLOOR_MS * MCP_SERVERS_MAX).toBeGreaterThan(
      OWNER_MCP_STARTUP_BUDGET_MS,
    )
  })

  it('leaves the no-installed-servers spawn exactly as it was', async () => {
    // The bound is a response to third-party code being in the config. With none there,
    // the startup behaviour must not change at all.
    setReplToolBridge(bridge())
    const { host, envs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(opts(host, { enableToolBridge: true }))
    await drain(sub.start(spec('hi')))

    expect(envs[0]!['MCP_CONNECTION_NONBLOCKING']).toBe('false')
    expect(envs[0]!['MCP_TIMEOUT']).toBeUndefined()
  })
})

describe('ONE CHILD PER SESSION KEY — resolving the installed set must not reopen the spawn window', () => {
  // Two concurrent dispatches on one key de-duplicate onto a single spawn ONLY because
  // nothing suspends between `getOrSpawnSession`'s `pool.get` and its `pool.set`. This
  // feature introduced an `await` in that gap — the installed-set resolve, needed for
  // the warm-reuse fingerprint — and hoisting the `pool.get` above it did not help: the
  // second caller still read a pool the first had not written. Two `claude` children
  // then owned one transcript, and the loser was never registered in the pool, so
  // `shutdownAllPersistentRepls()` could not kill it and it outlived the process
  // holding an open MCP config full of plaintext secrets.
  //
  // The fingerprint of ZERO installed servers is `''`, so this fired for every owner on
  // every cold start, not only for one who had installed something.

  it('two CONCURRENT cold dispatches spawn exactly ONE child', async () => {
    setReplToolBridge(bridge())
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, {
        enableToolBridge: true,
        // A resolver that actually yields. The bug needed only a microtask, but a real
        // timer makes the window unmissable rather than scheduler-dependent.
        resolveExtraMcpServers: async () => {
          await Bun.sleep(5)
          return []
        },
      }),
    )
    const first = sub.start(spec('first'))
    const second = sub.start(spec('second'))
    await Promise.all([drain(first), drain(second)])

    expect(argvs).toHaveLength(1)
  })

  it('leaves NO orphan child and NO stranded secrets after shutdown', async () => {
    // The consequence half. A second child that never entered the pool survived
    // `shutdownAllPersistentRepls()` with its 0600 config — holding the dev-channel
    // token and every installed server's env VALUES — still on disk in `tmpdir()`.
    setReplToolBridge(bridge())
    const { host, argvs } = makeCapturingHost()
    const dirsBefore = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('neutron-repl-')))
    const sub = createPersistentReplSubstrate(
      opts(host, {
        enableToolBridge: true,
        resolveExtraMcpServers: async () => {
          await Bun.sleep(5)
          return [EXAMPLE]
        },
      }),
    )
    await Promise.all([drain(sub.start(spec('first'))), drain(sub.start(spec('second')))])
    const spawned = argvs.length

    await shutdownAllPersistentRepls()

    const leaked = readdirSync(tmpdir()).filter(
      (n) => n.startsWith('neutron-repl-') && !dirsBefore.has(n),
    )
    expect(leaked).toEqual([])
    // Stated separately so a future regression cannot pass this test by spawning two
    // children and cleaning both up: one owner per transcript is the invariant.
    expect(spawned).toBe(1)
  })

  it('a COLD start resolves the installed set exactly once — the spawn\'s own read', async () => {
    // The fingerprint resolve now happens inside the warm-reuse branch, which a cold
    // start never enters, so the only read is `spawnSession`'s. Two reads here would
    // mean the pre-`pool.set` await is back.
    setReplToolBridge(bridge())
    const { host } = makeCapturingHost()
    let calls = 0
    const sub = createPersistentReplSubstrate(
      opts(host, {
        enableToolBridge: true,
        resolveExtraMcpServers: async () => {
          calls += 1
          return [EXAMPLE]
        },
      }),
    )
    await drain(sub.start(spec('hi')))
    expect(calls).toBe(1)
  })

  it('two CONCURRENT dispatches after the set CHANGES replace the warm child exactly ONCE', async () => {
    // The other half of the same invariant, on the path the cold-start guard does not
    // cover. The "nothing suspends between `pool.get` and `pool.set`" property protects
    // the COLD path only. The WARM-EVICTION path suspends on purpose — at
    // `await existing`, and again at the installed-set resolve — so two dispatches
    // arriving after the owner installed something both awaited the same warm session,
    // both computed the fingerprint mismatch, and both ran evict → terminate → spawn →
    // `pool.set`. The second `pool.set` overwrote the first: TWO `claude` children
    // resuming ONE transcript, the loser orphaned OUTSIDE the pool and so invisible to
    // `shutdownAllPersistentRepls`.
    setReplToolBridge(bridge())
    const { host, argvs, kills } = makeCapturingHost()
    let installed: readonly ResolvedOwnerMcpServer[] = []
    const sub = createPersistentReplSubstrate(
      opts(host, {
        enableToolBridge: true,
        // Yields, because the await IS the window. A real timer makes it unmissable
        // rather than scheduler-dependent.
        resolveExtraMcpServers: async () => {
          await Bun.sleep(5)
          return installed
        },
      }),
    )
    await drain(sub.start(spec('cold')))
    expect(argvs).toHaveLength(1)

    // The owner installs a server, so BOTH dispatches below fail `freshMcpServers`
    // against the same warm session.
    installed = [EXAMPLE]
    await Promise.all([drain(sub.start(spec('a'))), drain(sub.start(spec('b')))])

    // ONE replacement. Three spawns here means both callers replaced the same session.
    expect(argvs).toHaveLength(2)
    // Stated separately so a future regression cannot pass by spawning two children and
    // leaving the pool tidy: the orphan was always the pool's LOSER, not its entry.
    expect(pool.size).toBe(1)
    // And the replacement really did retire the original, rather than leaking it.
    expect(kills.n).toBe(1)
  })
})

describe('a change takes effect on the next turn, and an unchanged set does not thrash', () => {
  it('the SAME installed set REUSES the warm child — no cold spawn per message', async () => {
    setReplToolBridge(bridge())
    const { host, argvs } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, resolveExtraMcpServers: async () => [EXAMPLE] }),
    )
    await drain(sub.start(spec('one')))
    await drain(sub.start(spec('two')))
    await drain(sub.start(spec('three')))
    // One spawn for three turns. A fingerprint that varied per call would show 3.
    expect(argvs).toHaveLength(1)
  })

  it('an ADDED server evicts and respawns, and the new spawn carries it', async () => {
    setReplToolBridge(bridge())
    const { host, argvs } = makeCapturingHost()
    let installed: ResolvedOwnerMcpServer[] = []
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, resolveExtraMcpServers: async () => installed }),
    )
    await drain(sub.start(spec('before')))
    expect(mcpConfig(argvs[0]!).mcpServers['example-server']).toBeUndefined()

    installed = [EXAMPLE]
    await drain(sub.start(spec('after')))
    expect(argvs).toHaveLength(2)
    expect(mcpConfig(argvs[1]!).mcpServers['example-server']).toBeDefined()
    expect(allowedTools(argvs[1]!)).toContain('mcp__example-server')
  })

  it('a REVOKED server evicts too — the child stops being able to reach it', async () => {
    setReplToolBridge(bridge())
    const { host, argvs } = makeCapturingHost()
    let installed: ResolvedOwnerMcpServer[] = [EXAMPLE]
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, resolveExtraMcpServers: async () => installed }),
    )
    await drain(sub.start(spec('before')))
    installed = []
    await drain(sub.start(spec('after')))
    expect(argvs).toHaveLength(2)
    expect(mcpConfig(argvs[1]!).mcpServers['example-server']).toBeUndefined()
    expect(allowedTools(argvs[1]!)).toEqual(['mcp__neutron'])
  })

  it('a ROTATED VALUE evicts, because a running child holds the old one', async () => {
    setReplToolBridge(bridge())
    const { host, argvs } = makeCapturingHost()
    let secret = 'sk-first'
    const sub = createPersistentReplSubstrate(
      opts(host, {
        enableToolBridge: true,
        resolveExtraMcpServers: async () => [{ ...EXAMPLE, env: { EXAMPLE_API_KEY: secret } }],
      }),
    )
    await drain(sub.start(spec('before')))
    secret = 'sk-second'
    await drain(sub.start(spec('after')))
    expect(argvs).toHaveLength(2)
    expect(mcpConfig(argvs[1]!).mcpServers['example-server']!.env['EXAMPLE_API_KEY']).toBe('sk-second')
  })
})

describe('revoking a server retires the warm child that was spawned under the old answer', () => {
  // `claude` reads `mcpServers` ONCE at startup, so a warm child cannot unlearn a
  // server. `getOrSpawnSession`'s `freshMcpServers` guard evicts a stale child — but
  // only on its NEXT DISPATCH, and a warm session can sit idle for hours. Until then the
  // revoked server's stdio subprocess is still alive holding the environment it was
  // handed, including any secret configured for it. The durable grant lapses instantly;
  // the PROCESS is what lingered.
  //
  // ── WHY THE IDLE CASE NEEDS A SETTLE, AND WHAT AN EARLIER NOTE GOT WRONG ────
  // This block previously recorded the idle-termination path as UNPROVABLE against this
  // harness, on the stated ground that a drained fake-pty session leaves its POOLED
  // PROMISE REJECTED so the eviction loop's `await` throws and skips the entry. That
  // diagnosis was wrong. The pooled promise resolves fine; what is still true the
  // instant `drain` returns is that `session.activeTurn` is STILL SET — the turn's own
  // bookkeeping is cleared after the completion event reaches the consumer, not before
  // it. So an evict issued on that exact tick correctly reads the session as BUSY and
  // poisons it, which is the `{evicted: 0, poisoned: 1}` the earlier attempt saw and
  // read as a harness defect.
  //
  // It is not one. It is the function behaving correctly on a session that is, for one
  // more tick, mid-turn. Letting the queue drain first makes the idle path directly
  // observable, and it terminates the child — which is the property that matters,
  // because the whole point is that a revoked server's stdio subprocess must not
  // outlive the grant.
  //
  // The settle is a bounded TICK LOOP, not a wall-clock sleep: what has to happen is
  // that already-queued continuations run, which is a property of the queue rather than
  // of elapsed time, so it cannot flake on a slow runner.

  it('is a no-op, and never throws, when no child is warm', async () => {
    expect(await evictWarmReplsForMcpSurfaceChange()).toEqual({ evicted: 0, poisoned: 0 })
  })

  it('TERMINATES a warm IDLE child, rather than waiting for its next dispatch', async () => {
    // The gap this closes: revoking left the subprocess alive — with the secret it was
    // handed — until the session happened to be dispatched again, which for an idle
    // session can be hours. `kills` counts real `PtyChild.kill()` calls, so this asserts
    // the CHILD DIED and not merely that a pool entry was dropped.
    setReplToolBridge(bridge())
    const { host, kills } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, resolveExtraMcpServers: async () => [EXAMPLE] }),
    )
    await drain(sub.start(spec('hi')))
    expect(kills.n).toBe(0)
    // Let the finished turn's bookkeeping settle — see the block comment above.
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0))

    // EVICTED, NOT POISONED — a poison would defer the kill to the next dispatch, which
    // is exactly the delay this function exists to remove, so the counts are asserted
    // whole rather than just `evicted >= 1`.
    //
    // WHAT THIS DOES NOT PROVE, checked rather than assumed: it is NOT a regression test
    // for the first draft's `activeTurnRoutes`-based busy check. Substituting that draft
    // back in leaves this test PASSING, because in this scenario the route entry's key
    // does recompute and the entry is duly deleted. The routes lookup is still the wrong
    // signal — it is deleted under a recomputed key while `session.activeTurn` is plain
    // identity, so only the latter is guaranteed to have been cleared — but that
    // difference is not observable here and is not claimed to be.
    expect(await evictWarmReplsForMcpSurfaceChange()).toEqual({ evicted: 1, poisoned: 0 })
    expect(kills.n).toBe(1)
  })

  it('treats a session that merely HOLDS THE TURN SLOT as busy, and does not kill its child', async () => {
    // The window `session.activeTurn` cannot see. A dispatch wins the turn mutex at
    // `acquireTurn()` and only assigns `activeTurn` much later — `await session.ready` sits
    // between them, and on the import path so does the whole `/clear` context-reset
    // interstitial, which itself awaits the REPL going idle. A revocation landing in there
    // read the session as IDLE and terminated the child a COMMITTED dispatch was about to
    // inject into, stranding the turn — precisely what this function documents itself as
    // refusing to do for a busy session.
    setReplToolBridge(bridge())
    const { host, kills } = makeCapturingHost()
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, resolveExtraMcpServers: async () => [EXAMPLE] }),
    )
    await drain(sub.start(spec('hi')))
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0))

    // Reach into the pool and take the slot WITHOUT ever setting `activeTurn` — which is
    // exactly the state a real dispatch is in for the length of that window.
    const session = await [...pool.values()][0]!
    expect(session.activeTurn).toBeUndefined()
    const release = await session.acquireTurn()
    expect(session.turnSlotHeld).toBe(1)

    // POISONED, NOT EVICTED, and the child is untouched.
    expect(await evictWarmReplsForMcpSurfaceChange()).toEqual({ evicted: 0, poisoned: 1 })
    expect(kills.n).toBe(0)
    expect(session.poisoned).toBe(true)
    // And it is marked for teardown rather than merely for respawn — see the next test.
    expect(session.retireOnIdle).toBe(true)

    release()
    expect(session.turnSlotHeld).toBe(0)
    // Idempotent: several of `start`'s early-return paths release the slot they were
    // handed, and a double decrement would read as "idle" to the check above.
    release()
    expect(session.turnSlotHeld).toBe(0)
  })

  it('spares the child of a dispatch parked BEFORE its turn slot — the window neither session field can see', async () => {
    // THE REPRODUCED FAILURE. `acquireTurn()` is called in the CALLER's continuation, after
    // `getOrSpawnSession` has already resolved — so for every await inside get-or-spawn a
    // committed dispatch has a session and neither `activeTurn` nor `turnSlotHeld`. A
    // revocation landing there read the session as idle, killed the child, and the dispatch
    // injected into a corpse: the turn failed with a drain error instead of delivering.
    //
    // PARKED WHERE THE PRODUCTION WINDOW ACTUALLY IS, not at an arbitrary await: the
    // warm-reuse branch computes the MCP freshness fingerprint by awaiting
    // `resolveExtraMcpServers`, and in the real composition that resolver reads the
    // installed list from the database and decrypts every env value through the secrets
    // store. Holding that one resolver open IS the window — which is also the answer to the
    // earlier claim that what remained here was "a handful of microtasks".
    setReplToolBridge(bridge())
    const { host, kills } = makeCapturingHost()
    let hold = false
    let release: (() => void) | undefined
    const sub = createPersistentReplSubstrate(
      opts(host, {
        enableToolBridge: true,
        resolveExtraMcpServers: async () => {
          if (hold) await new Promise<void>((r) => (release = r))
          return [EXAMPLE]
        },
      }),
    )

    // A warm IDLE child, settled — the state the evictor would otherwise be right to kill.
    await drain(sub.start(spec('first')))
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0))
    expect(kills.n).toBe(0)

    // Dispatch two, parked inside the freshness check: past the pool lookup, short of the
    // turn slot. Waited for by TICKING until the resolver is actually suspended, so the
    // test cannot pass by racing ahead of the window it means to be inside.
    hold = true
    const second = drain(sub.start(spec('second')))
    for (let i = 0; i < 400 && release === undefined; i += 1) {
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(release).toBeDefined()

    // The revocation lands exactly there. POISONED, and the child is NOT touched.
    expect(await evictWarmReplsForMcpSurfaceChange()).toEqual({ evicted: 0, poisoned: 1 })
    expect(kills.n).toBe(0)

    // Let it through. `hold` is cleared first: the poison makes the freshness guard evict
    // and respawn, and that respawn resolves the servers again — it must not park too.
    hold = false
    release!()
    // DELIVERED. `drain` throws on an error event, so awaiting it is the assertion: without
    // the committed-dispatch check this rejects with "drain error", which is the exact
    // user-visible symptom the reviewer reproduced.
    // …and delivered THIS turn's reply, not a truncated or empty one: the fake child echoes
    // the prompt, so the text proves the inject reached a live REPL on the respawned child.
    expect(await second).toContain('second')
  })

  it('retires a session poisoned mid-turn AS SOON AS that turn ends, not at some next dispatch', async () => {
    // The residual the poison left behind. A child that was BUSY when the grant was
    // revoked cannot be killed on the spot — that would strand a turn which is, correctly,
    // running under a grant that WAS in force. So it is poisoned, and `getOrSpawnSession`
    // respawns it cleanly at the NEXT DISPATCH. But nothing in this build reaps an idle
    // warm session, so "the next dispatch" is not a bound: if the owner never sends
    // another message, the revoked server's stdio child keeps running, holding the env it
    // was handed, for as long as the process lives. Unbounded, on the exact secret the
    // revocation was meant to retire.
    //
    // The turn is held IN FLIGHT by gating the fake child's reply, so the revocation lands
    // while the session is genuinely busy — the real ordering, not a hand-set flag.
    setReplToolBridge(bridge())
    let openTheGate: () => void = () => {}
    const gate = new Promise<void>((res) => {
      openTheGate = res
    })
    const { host, kills } = makeCapturingHost(() => gate)
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, resolveExtraMcpServers: async () => [EXAMPLE] }),
    )
    const inFlight = drain(sub.start(spec('hi')))

    // Wait until the turn is genuinely in flight (the session is pooled and mid-turn).
    let session: ReplSession | undefined
    for (let i = 0; i < 400 && session === undefined; i += 1) {
      const first = [...pool.values()][0]
      if (first !== undefined) {
        const s = await first
        if (s.activeTurn !== undefined || s.turnSlotHeld > 0) session = s
      }
      if (session === undefined) await new Promise((r) => setTimeout(r, 5))
    }
    expect(session).toBeDefined()

    // Revoked mid-turn: poisoned, child still alive, turn undisturbed.
    expect(await evictWarmReplsForMcpSurfaceChange()).toEqual({ evicted: 0, poisoned: 1 })
    expect(kills.n).toBe(0)

    // Let the turn finish. It must still deliver — killing it was never the goal.
    openTheGate()
    expect(await inFlight).toContain('ok=0')

    // THE ASSERTION THAT FAILS WITHOUT THE FIX: the child is dead by the time the turn
    // settles, with no second dispatch anywhere in this test.
    for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 0))
    expect(kills.n).toBe(1)
    expect(pool.size).toBe(0)
  })

  it('waits for a QUEUED dispatch too, then retires when the queue drains', async () => {
    // The eager teardown above must not become its own stranded-turn bug. A second
    // dispatch that has already passed the freshness guards and parked in
    // `acquireTurn()` is COMMITTED to this child — but it holds no `activeTurn` and, if
    // the slot count is taken only AFTER the queue wait, it holds no slot either. So the
    // active turn's release dropped the count to zero, this path read the session as
    // idle and killed the child, and the queued dispatch then resumed from `await prev`
    // into a dead REPL. Same stranded turn, opposite door.
    setReplToolBridge(bridge())
    // One gate per turn, opened in order, so the FIRST turn can settle while the second
    // is still held in flight. A single shared gate would release both at once and the
    // window this test is about would not exist.
    const gates: Array<() => void> = []
    const { host, kills } = makeCapturingHost(
      () =>
        new Promise<void>((res) => {
          gates.push(res)
        }),
    )
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, resolveExtraMcpServers: async () => [EXAMPLE] }),
    )
    const firstTurn = drain(sub.start(spec('first')))

    let session: ReplSession | undefined
    for (let i = 0; i < 400 && session === undefined; i += 1) {
      const first = [...pool.values()][0]
      if (first !== undefined) {
        const s = await first
        if (s.activeTurn !== undefined) session = s
      }
      if (session === undefined) await new Promise((r) => setTimeout(r, 5))
    }
    expect(session).toBeDefined()

    // The second dispatch: reuses the warm session, then parks behind the first turn.
    const secondTurn = drain(sub.start(spec('second')))
    for (let i = 0; i < 100 && session!.turnSlotHeld < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 1))
    }
    // A queued caller counts as busy. Reading 1 here is the defect itself.
    expect(session!.turnSlotHeld).toBe(2)
    expect(session!.activeTurn).toBeDefined()

    expect(await evictWarmReplsForMcpSurfaceChange()).toEqual({ evicted: 0, poisoned: 1 })
    expect(session!.retireOnIdle).toBe(true)

    // Let ONLY the first turn finish.
    gates.shift()!()
    expect(await firstTurn).toContain('ok=0')
    for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 0))

    // THE ASSERTION THAT FAILS WITHOUT THE FIX. The queue is not empty, so the child
    // must still be alive and still pooled for the turn that is about to run on it.
    expect(kills.n).toBe(0)
    expect(pool.size).toBe(1)

    // The teardown is DEFERRED, not cancelled: the queued turn delivers, and the revoked
    // child dies the moment nothing is left waiting on it.
    for (let i = 0; i < 200 && gates.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5))
    }
    gates.shift()!()
    expect(await secondTurn).toContain('ok=1')
    for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 0))
    expect(kills.n).toBe(1)
    expect(pool.size).toBe(0)
  })

  it('a COLD SPAWN in flight is busy too — the dispatch that asked for it keeps its child', async () => {
    // THE THIRD DOOR TO THE SAME STRANDED TURN, and the widest of the three. The two tests
    // above cover a session that exists and is busy. This is the window where the session
    // does NOT exist yet: a cold dispatch has committed, the pool holds an unresolved spawn
    // promise, and neither `activeTurn` nor `turnSlotHeld` can say so because the object
    // they live on is still being built.
    //
    // Reading busy-ness by AWAITING that promise is what broke it. The evictor's `await`
    // resumes several await-hops before the dispatch's own — it awaits the pooled promise
    // directly, while the caller unwinds through `getOrSpawnSession` and its lock — so the
    // evictor saw a brand-new session with no turn and no slot, called it idle, and killed
    // the child the dispatch was about to inject into. Measured before the fix on this very
    // harness: evicted=1, one kill, and the turn failing its drain.
    //
    // The window is not microscopic like the other two: it is open for the whole spawn,
    // which on a real box is seconds.
    setReplToolBridge(bridge())
    let openReady: () => void = () => {}
    const ready = new Promise<void>((res) => {
      openReady = res
    })
    const { host, kills } = makeCapturingHost(undefined, () => ready)
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, resolveExtraMcpServers: async () => [EXAMPLE] }),
    )
    const turn = drain(sub.start(spec('hi')))
    // Wait for the pool to hold the PENDING spawn — not for it to resolve, which is the
    // whole point. A tick loop, so it cannot flake on a slow runner.
    for (let i = 0; i < 200 && pool.size === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 1))
    }
    expect(pool.size).toBe(1)

    // The revocation lands mid-spawn. POISONED, not evicted, and nothing is killed.
    expect(await evictWarmReplsForMcpSurfaceChange()).toEqual({ evicted: 0, poisoned: 1 })
    expect(kills.n).toBe(0)

    // THE ASSERTION THAT FAILS WITHOUT THE FIX: the turn survives. Its child was spawned
    // under a grant that WAS in force when the dispatch committed, which is the same
    // bargain the busy branch strikes.
    openReady()
    expect(await turn).toContain('ok=0')

    // And it is retired the moment that turn ends — not left to some next dispatch, which
    // for an idle session is no bound at all.
    for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 0))
    const session = await [...pool.values()][0]
    expect(session?.poisoned ?? true).toBe(true)
    expect(kills.n).toBe(1)
    expect(pool.size).toBe(0)
  })

  it('retires a revoked child that NO DISPATCH is waiting on — nothing would have read the flag', async () => {
    // THE FOURTH DOOR, and the one where the deferral had no receiver at all.
    //
    // The three tests above all end with a TURN whose completion path reads
    // `retireOnIdle` and tears the child down. That is what made marking the flag a
    // sufficient answer for them. But `pendingSpawns` catches a second population with no
    // dispatch behind it: the supervision crash/wedge respawn and an admin respawn both
    // call `getOrSpawnSession` directly (`supervision.ts`), so `committedDispatches` never
    // counts them and NO TURN DRIVER EVER RUNS. The evictor set `poisoned` +
    // `retireOnIdle` on a session nobody would ever ask about, and the freshly-resolved
    // child went on running under the REVOKED configuration — env resident — until some
    // future dispatch happened to arrive. For a quiet instance that is unbounded, which is
    // the exact hazard this whole function exists to close.
    //
    // Driven the way the finding says to drive a concurrency defect: park one path (the
    // spawn, held at its ready gate) and drive the other (the revocation), rather than
    // asserting on structure. A test that read the two flags would have PASSED against
    // the bug — they were both set correctly; it was the absence of a reader that was the
    // defect.
    //
    // MUTATION: delete the self-retire branch from the `spawning || committed` callback
    // in `evictWarmReplsForMcpSurfaceChange` and this fails on `kills.n` — the child
    // survives its own revocation.
    setReplToolBridge(bridge())
    let openReady: () => void = () => {}
    const ready = new Promise<void>((res) => {
      openReady = res
    })
    const { host, kills } = makeCapturingHost(undefined, () => ready)
    const options = opts(host, {
      enableToolBridge: true,
      resolveExtraMcpServers: async () => [EXAMPLE],
    })
    // NO `substrate.start()` anywhere in this test — that is the whole point. This is the
    // supervision respawn's own call shape, which is why nothing increments
    // `committedDispatches`.
    const key = poolKeyFor(options)
    const spawning = getOrSpawnSession(key, options, spec('hi'))
    for (let i = 0; i < 200 && pool.size === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 1))
    }
    expect(pool.size).toBe(1)

    // Reported as `poisoned`: the decision is taken synchronously, and the function must
    // not await a spawn to sharpen it — awaiting is what made a deny block for the whole
    // ready budget. The counts describe the decision, not the eventual disposal.
    expect(await evictWarmReplsForMcpSurfaceChange()).toEqual({ evicted: 0, poisoned: 1 })
    expect(kills.n).toBe(0)

    openReady()
    const session = await spawning
    for (let i = 0; i < 60; i += 1) await new Promise((r) => setTimeout(r, 0))

    // THE ASSERTIONS THAT FAIL WITHOUT THE FIX. Flags still set, so a failed teardown
    // still refuses reuse...
    expect(session.poisoned).toBe(true)
    expect(session.retireOnIdle).toBe(true)
    // ...and the child is actually DEAD and out of the pool, with no dispatch in sight.
    expect(kills.n).toBe(1)
    expect(pool.size).toBe(0)
  })

  it('does NOT retire a spawn a dispatch IS waiting on — the deferral is kept where it has a reader', async () => {
    // The other half of the same branch, and the regression the fix could easily have
    // introduced. A COLD DISPATCH is also `spawning`, and it must still be spared: its
    // child was spawned under a grant that WAS in force when it committed, and killing it
    // strands the turn with a drain error. The self-retire above therefore re-reads
    // `committedDispatches` AFTER the spawn resolves, and defers when a dispatch is behind
    // it.
    //
    // MUTATION: drop the `committedDispatches` term from the self-retire's guard and this
    // fails — the turn dies instead of delivering.
    setReplToolBridge(bridge())
    let openReady: () => void = () => {}
    const ready = new Promise<void>((res) => {
      openReady = res
    })
    const { host, kills } = makeCapturingHost(undefined, () => ready)
    const sub = createPersistentReplSubstrate(
      opts(host, { enableToolBridge: true, resolveExtraMcpServers: async () => [EXAMPLE] }),
    )
    const turn = drain(sub.start(spec('hi')))
    for (let i = 0; i < 200 && pool.size === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 1))
    }
    expect(await evictWarmReplsForMcpSurfaceChange()).toEqual({ evicted: 0, poisoned: 1 })

    openReady()
    // The turn DELIVERS — it was not killed out from under itself by the new branch.
    expect(await turn).toContain('ok=0')
    // And it is retired once that turn ends, by the turn's own completion path.
    for (let i = 0; i < 60; i += 1) await new Promise((r) => setTimeout(r, 0))
    expect(kills.n).toBe(1)
    expect(pool.size).toBe(0)
  })
})
