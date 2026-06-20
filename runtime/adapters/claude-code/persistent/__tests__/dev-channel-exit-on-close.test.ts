// ISSUES #217 — the dev-channel must EXIT when its MCP stdio transport
// closes (parent `claude` REPL gone).
//
// THE BUG: the dev-channel runs a loopback HTTP server (the substrate's
// /message inject surface). When the spawning `claude` died — wedge-respawn
// kill, PTY hangup on gateway exit, crash — the stdio pipes ended but the
// HTTP server kept the bun process alive FOREVER. This was the dominant
// prod leak class: 132 ppid=1 dev-channel orphans accumulated in ~100 min
// of respawn churn alone (632 total / ~19 GB across releases, 2026-06-11).
// A bridge whose claude is gone can never serve a turn again (the substrate
// spawns a FRESH dev-channel per REPL incarnation), so exit-on-close is
// unconditionally correct.
//
// The test spawns the REAL dev-channel.ts as a subprocess, waits for the
// MCP transport to connect, closes its stdin (exactly what parent death
// does to the pipe), and asserts the process exits promptly with code 0.
// Pre-fix this test hangs to the timeout.

import { describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEV_CHANNEL = join(__dirname, '..', 'dev-channel.ts')

async function readUntil(
  stream: ReadableStream<Uint8Array>,
  marker: string,
  timeoutMs: number,
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((res) =>
          setTimeout(() => res({ done: true, value: undefined }), remaining),
        ),
      ])
      if (chunk.value !== undefined) buf += decoder.decode(chunk.value, { stream: true })
      if (buf.includes(marker)) return buf
      if (chunk.done) break
    }
  } finally {
    reader.releaseLock()
  }
  return buf
}

describe('dev-channel — exit on MCP transport close (ISSUES #217)', () => {
  test('closing stdin (parent claude gone) exits the process instead of orphaning it to the HTTP server', async () => {
    const proc = Bun.spawn({
      cmd: ['bun', DEV_CHANNEL],
      env: {
        ...process.env,
        // Unreachable sink: the /channel-ready announce fails (caught +
        // logged) — proves exit-on-close does not depend on a live sink.
        SINK_PORT: '59999',
        SINK_TOKEN: '',
        SESSION_ID: 'test-session-217',
        CHANNEL_NAME: 'test-channel-217',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    try {
      // Wait until the MCP transport is connected (the close handlers are
      // wired synchronously right after this line is emitted).
      const seen = await readUntil(proc.stderr, 'MCP connected', 10_000)
      expect(seen).toContain('MCP connected')

      // Parent-death simulation: end the stdio pipe.
      proc.stdin.end()

      // Pre-fix: the loopback HTTP server keeps the event loop alive and
      // this await outlives the test timeout. Post-fix: prompt exit 0.
      const exitCode = await Promise.race([
        proc.exited,
        new Promise<'hung'>((res) => setTimeout(() => res('hung'), 8_000)),
      ])
      expect(exitCode).toBe(0)
    } finally {
      proc.kill('SIGKILL')
    }
  }, 20_000)
})
