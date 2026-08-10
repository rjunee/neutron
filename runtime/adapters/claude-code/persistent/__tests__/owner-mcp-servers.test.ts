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

import { afterEach, describe, expect, it } from 'bun:test'
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
import {
  createPersistentReplSubstrate,
  getReplSinkInfo,
  setReplToolBridge,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
  type ReplToolBridge,
} from '../persistent-repl-substrate.ts'

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
function makeCapturingHost(): {
  host: PtyHost
  argvs: string[][]
  envs: Array<Record<string, string | undefined>>
} {
  const argvs: string[][] = []
  const envs: Array<Record<string, string | undefined>> = []
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
            void post('/reply', { session_id: sid, text: `ok=${seen} ${body.text}`, turn_id: body.turn_id })
            seen += 1
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid })
      void post('/channel-bound', { session_id: sid })
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
  return { host, argvs, envs }
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
