/**
 * dev-channel-pty-bind.e2e.test.ts — REAL-PTY end-to-end proof that the
 * dev-channel MCP binds and `reply()` round-trips when `claude` is spawned under
 * a real Bun PTY (`Bun.spawn({terminal})`), exactly as the substrate does.
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
import { BunTerminalHost } from '../bun-terminal-host.ts'
import { ensureClaudeTrust } from '../ensure-claude-trust.ts'

const OPT_IN = process.env['NEUTRON_PTY_E2E'] === '1'
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

    const host = new BunTerminalHost()
    const chunks: Buffer[] = []
    let dismissed = false
    let child: { writeKey?: (k: 'enter') => void; kill: (s?: string) => void } | null = null
    child = host.spawn(argv, {
      cwd: cfgDir,
      env: { ...(process.env as Record<string, string>), MCP_CONNECTION_NONBLOCKING: 'false' },
      cols: 120,
      rows: 40,
      onData: (b) => {
        chunks.push(Buffer.from(b))
        if (dismissed) return
        // Dismiss the --dangerously-load-development-channels disclaimer the same
        // way the substrate's output scanner does (normalize ANSI + whitespace).
        const norm = Buffer.concat(chunks)
          .toString('utf8')
          // eslint-disable-next-line no-control-regex
          .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
          .replace(/\s+/g, '')
        if (/forlocalchanneldevelopment|usingthisforlocaldevelopment/i.test(norm)) {
          dismissed = true
          setTimeout(() => child?.writeKey?.('enter'), 400)
        }
      },
    })

    try {
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
    } finally {
      child?.kill('SIGTERM')
      sink.stop(true)
    }
  }, 90_000)
})
