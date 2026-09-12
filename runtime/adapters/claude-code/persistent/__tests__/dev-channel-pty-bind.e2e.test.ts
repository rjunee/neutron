/**
 * dev-channel-pty-bind.e2e.test.ts — REAL-PTY end-to-end proof that the
 * dev-channel MCP binds and `reply()` round-trips when `claude` is spawned under
 * a real PTY, exactly as the substrate does — which since herdr step 2b means a
 * real `herdr` PANE (`HerdrHost`, below), NOT the `Bun.spawn({terminal})` this
 * originally used. The file name still says PTY because a herdr pane IS one; what
 * changed is who allocates it.
 *
 * THIS IS THE REGRESSION GUARD for the 2026-06-26 P0: the prior post-spawn
 * assertion fast-failed every PTY spawn as `channel-wedged` by scanning the PTY
 * ring for "no MCP server configured with that name" — a benign warning claude
 * 2.1.186 ALWAYS prints for an `--mcp-config`-provided development-channel server,
 * even when the channel is fully wired. A plain `claude -p` repro never showed it
 * (print mode skips the channel-status TUI render), so the bug only reproduced
 * under the interactive PTY. This test reproduces UNDER THE PTY and asserts the
 * TRUE bind signal (`mcp.oninitialized` → `/channel-bound`) fires and a real turn
 * completes — NOT a fake-host smoke test, NOT `claude -p`.
 *
 * OPT-IN: needs a real `claude` binary + working credentials, so it is skipped
 * unless `NEUTRON_PTY_E2E=1`. CI (no creds) skips; a dev machine runs it with
 *   NEUTRON_PTY_E2E=1 bun test dev-channel-pty-bind.e2e.test.ts
 */

import { describe, it, expect } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { buildReplArgv } from '../build-repl-argv.ts'
import { buildSettings } from '../build-settings.ts'
import { HerdrHost } from '../herdr-host.ts'
import type { PtyChild } from '../pty-host.ts'
import { ensureClaudeTrust } from '../ensure-claude-trust.ts'
import { withCapturedStderr } from './capture-stderr.ts'

// herdr is the REPL container now, so this needs a live herdr server as well as a
// real `claude`. Both are opt-in facts about the machine, and neither is present
// in CI — the test stays visible-but-skipped rather than silently passing.
const OPT_IN =
  process.env['NEUTRON_PTY_E2E'] === '1' &&
  (process.env['HERDR_SOCKET_PATH'] ?? '') !== ''
const CLAUDE_BIN =
  process.env['CLAUDE_BIN'] ??
  [join(process.env['HOME'] ?? '', '.local/bin/claude'), '/usr/local/bin/claude'].find((p) =>
    existsSync(p),
  ) ??
  'claude'
const HERE = import.meta.dir
const PERSIST = join(HERE, '..')
const DEV_CHANNEL = join(PERSIST, 'dev-channel.ts')
const PROMPT_FILE = join(PERSIST, 'repl-agent-base.md')

// bun's `describe.skipIf` keeps the test visible-but-skipped in CI.
describe.skipIf(!OPT_IN)('dev-channel binds under a REAL PTY (P0 regression guard)', () => {
  it('handshakes (/channel-bound) and round-trips a reply despite the benign TUI warning', async () => {
    const channelName = `neutron-${randomBytes(4).toString('hex')}`
    const sessionId = crypto.randomUUID()
    const cfgDir = mkdtempSync(join(tmpdir(), 'neutron-pty-e2e-'))
    const mcpConfigPath = join(cfgDir, 'mcp.json')
    const settingsPath = join(cfgDir, 'settings.json')

    let channelPort = 0
    let bound = false
    let reply: string | undefined
    const sink = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const u = new URL(req.url)
        let body: Record<string, unknown> = {}
        try {
          body = (await req.json()) as Record<string, unknown>
        } catch {
          /* ignore */
        }
        if (u.pathname === '/channel-ready') channelPort = Number(body['channel_port'] ?? 0)
        if (u.pathname === '/channel-bound') bound = true
        if (u.pathname === '/reply') reply = String(body['text'] ?? '')
        return Response.json({ ok: true })
      },
    })

    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          [channelName]: {
            command: 'bun',
            args: [DEV_CHANNEL],
            env: {
              SINK_PORT: String(sink.port),
              SINK_TOKEN: 'e2e-token',
              SESSION_ID: sessionId,
              CHANNEL_NAME: channelName,
            },
          },
        },
      }),
    )
    buildSettings({ settingsPath })
    // Pre-seed first-run trust + bypass-permissions for the cwd exactly as the
    // substrate does, so claude doesn't block on the trust dialog before loading
    // the dev-channel MCP (the dev-channel disclaimer below has no config seed, so
    // it is still dismissed via the output scanner — same as the substrate).
    ensureClaudeTrust({ cwd: cfgDir })

    const argv = buildReplArgv({
      claudeBin: CLAUDE_BIN,
      sessionId,
      resume: false,
      channelName,
      mcpConfigPath,
      settingsPath,
      appendSystemPromptFile: PROMPT_FILE,
      model: 'claude-opus-4-8',
      addDir: cfgDir,
      tools: [],
      skipPermissions: true,
    })

    // CAPTURE STDERR so the readiness handshake can be ASSERTED, not assumed. This is
    // the only live boundary test that can prove the production wiring order is the one
    // exercised here; the unit test proves the warning fires when the call is missing,
    // and this proves the real caller is on the right side of it.
    //
    // THE SPAWN IS INSIDE THE CAPTURE'S SCOPE, and that is the whole point of using the
    // helper. The hand-rolled version installed the override, then awaited
    // `host.spawn`, then restored in a `finally` that began AFTER the spawn — so a
    // protocol mismatch, an unreachable socket or a pane that never reports a pid left
    // `process.stderr.write` monkey-patched for the rest of the process. The worst
    // possible shape: the one test that can see a real server fails, and its failure
    // silently degrades every test that runs after it.
    let dismissed = false
    // A HOLDER, not a `let`. The spawn happens inside the capture callback, and TS's
    // control-flow analysis does not see an assignment made in a closure — a plain
    // `let child: PtyChild | null = null` narrows to `never` by the `finally` that has
    // to kill it. The object survives the analysis and the cleanup keeps its type.
    const spawned: { child?: PtyChild } = {}
    try {
      await withCapturedStderr(
        async (hostErr) => {
          const host = new HerdrHost()
          spawned.child = await host.spawn(argv, {
            cwd: cfgDir,
            env: { ...(process.env as Record<string, string>), MCP_CONNECTION_NONBLOCKING: 'false' },
            // A RENDERED SCREEN, not a chunk — see `pty-host.ts`. Each delivery is the
            // pane's whole current screen, so the disclaimer check runs against the
            // screen instead of an accumulation of chunks.
            onScreen: (screen) => {
              if (dismissed) return
              // Dismiss the --dangerously-load-development-channels disclaimer the same
              // way the substrate's output scanner does (normalize ANSI + whitespace).
              const norm = screen
                // eslint-disable-next-line no-control-regex
                .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
                .replace(/\s+/g, '')
              if (/forlocalchanneldevelopment|usingthisforlocaldevelopment/i.test(norm)) {
                dismissed = true
                setTimeout(() => spawned.child?.writeKey?.('enter'), 400)
              }
            },
          })

          // RELEASE THE OUTPUT GATE — the readiness handshake the production caller performs
          // in `spawn.ts` once its consumers are wired. Without it the host waits out
          // `HERDR_OUTPUT_GATE_MAX_MS` (5 s), emits its "WIRING BUG" warning, and only then
          // begins polling: every one of these live proofs was silently taking the fail-open
          // path and NORMALISING it. The guard is well-tested and its real callers were all
          // on the wrong side of it.
          spawned.child.beginOutput?.()

            // Wait for the dev-channel to report its port (transport attached).
            for (let i = 0; i < 60 && channelPort === 0; i++) await Bun.sleep(500)
            expect(channelPort).toBeGreaterThan(0)

            // The TRUE bind signal: claude completed the MCP handshake. This is what the
            // old TUI-string detector got wrong — it fired even though THIS fires too.
            for (let i = 0; i < 40 && !bound; i++) await Bun.sleep(500)
            expect(bound).toBe(true)

            // And a real turn round-trips through the channel's reply tool.
            const r = await fetch(`http://127.0.0.1:${channelPort}/message`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Sink-Token': 'e2e-token' },
              body: JSON.stringify({ text: 'Reply with exactly the word PONG.', turn_id: '1:1' }),
            })
            expect(r.status).toBe(200)
            for (let i = 0; i < 60 && reply === undefined; i++) await Bun.sleep(500)
            expect(reply).toBeDefined()
            expect(reply).toContain('PONG')
            // NO FAIL-OPEN WARNING. `beginOutput()` was called, so the gate was released by
            // the caller and never by the 5 s timer — the timely path, which is the one
            // production takes. Asserted at the END so the whole run is covered, not just
            // the moment after spawn.
            expect(hostErr.filter((e) => e.includes('beginOutput() was not called'))).toEqual([])
        },
        // Tee: a 90 s live proof a human is watching must still print as it runs.
        { tee: true },
      )
    } finally {
      spawned.child?.kill('SIGTERM')
      sink.stop(true)
    }
  }, 90_000)
})
