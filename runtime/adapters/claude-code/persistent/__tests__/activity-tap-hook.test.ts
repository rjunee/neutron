/**
 * I/O-contract test for the ACTIVITY INSPECTOR's Pre/PostToolUse tool tap.
 *
 * Runs the hook as a real subprocess against a throwaway loopback HTTP server (same
 * shape as `todo-sync-hook.test.ts`), asserting it forwards the tool name + a
 * summarised detail to `/activity` with the shared token and the baked session id +
 * phase — and that every degenerate input path exits 0 while POSTing nothing, since
 * an inspector tap must never perturb the agent's turn.
 *
 * This tap is where the panel's real content comes from: the persistent-REPL
 * adapter's event stream carries NO tool events at all (its 1:1 bridge emits one
 * whole-reply `token` and nothing else), so without this hook the panel could only
 * ever say "alive", never "running Bash".
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import { renderToolArgs, renderToolResult, summarizeToolInput } from '../hooks/activity-tap.ts'

const HOOK = join(import.meta.dir, '..', 'hooks', 'activity-tap.ts')

interface Received {
  path: string
  token: string | null
  body: Record<string, unknown>
}

let server: ReturnType<typeof Bun.serve>
let received: Received[] = []

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      let body: Record<string, unknown> = {}
      try {
        body = (await req.json()) as Record<string, unknown>
      } catch {
        /* ignore */
      }
      received.push({
        path: url.pathname,
        token: req.headers.get('X-Sink-Token'),
        body,
      })
      return Response.json({ status: 'ok' })
    },
  })
})

afterAll(() => server.stop(true))

async function runHook(
  env: Record<string, string>,
  stdin: string,
): Promise<{ exitCode: number }> {
  const proc = Bun.spawn(['bun', HOOK], {
    env: { ...process.env, ...env },
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await proc.exited
  return { exitCode }
}

function baseEnv(phase: string): Record<string, string> {
  return {
    SINK_PORT: String(server.port),
    SINK_TOKEN: 'tok-abc',
    SESSION_ID: 'sess-xyz',
    TAP_PHASE: phase,
  }
}

describe('activity-tap hook', () => {
  it('forwards a PRE tool call with the baked session id, phase and token', async () => {
    received = []
    const { exitCode } = await runHook(
      baseEnv('pre'),
      JSON.stringify({
        session_id: 'ignored-stdin-id',
        tool_name: 'Bash',
        tool_input: { command: 'a-command --flag' },
      }),
    )
    expect(exitCode).toBe(0)
    expect(received).toHaveLength(1)
    expect(received[0]?.path).toBe('/activity')
    expect(received[0]?.token).toBe('tok-abc')
    // SESSION_ID comes from ENV, not stdin, so it always matches the sink's
    // registration regardless of CC payload drift.
    expect(received[0]?.body).toEqual({
      session_id: 'sess-xyz',
      phase: 'pre',
      tool_name: 'Bash',
      detail: 'a-command --flag',
      // `args` is the expanded view's content. A `pre` row carries no `result` key
      // at all — nothing has returned yet.
      args: 'a-command --flag',
    })
  })

  it('forwards a POST tool call (the finish half of the started/finished pair)', async () => {
    received = []
    const { exitCode } = await runHook(
      baseEnv('post'),
      JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/a/b/c.ts' } }),
    )
    expect(exitCode).toBe(0)
    expect(received[0]?.body['phase']).toBe('post')
    expect(received[0]?.body['tool_name']).toBe('Read')
    expect(received[0]?.body['detail']).toBe('/a/b/c.ts')
  })

  it('forwards what the tool RETURNED on the post phase', async () => {
    // The whole gap this closes: the first build never read `tool_response`, so a
    // finished tool row could not say one word about its output.
    received = []
    await runHook(
      baseEnv('post'),
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'a-command' },
        tool_response: { stdout: 'first output line\nsecond output line', stderr: '' },
      }),
    )
    expect(received[0]?.body['result']).toBe('first output line\nsecond output line')
  })

  it('forwards the reply tool ARGUMENT — the agent\'s own words', async () => {
    // `dev-channel-impl.ts` registers `reply` with a single `text` argument holding
    // the complete response. `text` was absent from the pick list, which is why the
    // assistant turn rendered as a bare unreadable id with no content.
    received = []
    await runHook(
      baseEnv('pre'),
      JSON.stringify({
        tool_name: `mcp__neutron-${'ab'.repeat(16)}__reply`,
        tool_input: { text: 'a synthesised assistant sentence' },
      }),
    )
    expect(received[0]?.body['detail']).toBe('a synthesised assistant sentence')
    expect(received[0]?.body['args']).toBe('a synthesised assistant sentence')
  })

  it('POSTs NOTHING and exits 0 when the sink env is absent (unwired REPL)', async () => {
    received = []
    const { exitCode } = await runHook(
      { TAP_PHASE: 'pre' },
      JSON.stringify({ tool_name: 'Bash', tool_input: {} }),
    )
    expect(exitCode).toBe(0)
    expect(received).toHaveLength(0)
  })

  it('POSTs NOTHING and exits 0 on an unknown TAP_PHASE', async () => {
    received = []
    const { exitCode } = await runHook(
      baseEnv('sideways'),
      JSON.stringify({ tool_name: 'Bash', tool_input: {} }),
    )
    expect(exitCode).toBe(0)
    expect(received).toHaveLength(0)
  })

  it('POSTs NOTHING and exits 0 on unparseable stdin or a missing tool name', async () => {
    received = []
    expect((await runHook(baseEnv('pre'), '{not json')).exitCode).toBe(0)
    expect((await runHook(baseEnv('pre'), JSON.stringify({ tool_input: {} }))).exitCode).toBe(0)
    expect(received).toHaveLength(0)
  })

  it('exits 0 even when the sink is unreachable (fail-soft transport)', async () => {
    // A dead sink must not become a failed tool call.
    const { exitCode } = await runHook(
      { SINK_PORT: '1', SINK_TOKEN: 't', SESSION_ID: 's', TAP_PHASE: 'pre' },
      JSON.stringify({ tool_name: 'Bash', tool_input: {} }),
    )
    expect(exitCode).toBe(0)
  })
})

describe('summarizeToolInput', () => {
  it('picks the field that identifies WHICH call this is, by tool shape', () => {
    expect(summarizeToolInput({ file_path: '/x/y.ts' })).toBe('/x/y.ts')
    expect(summarizeToolInput({ command: 'bun test' })).toBe('bun test')
    expect(summarizeToolInput({ pattern: 'foo.*bar' })).toBe('foo.*bar')
    expect(summarizeToolInput({ url: 'https://example.com/a' })).toBe('https://example.com/a')
    expect(summarizeToolInput({ query: 'how do I' })).toBe('how do I')
  })

  it('prefers a path over a command when a tool carries both', () => {
    expect(summarizeToolInput({ file_path: '/a.ts', command: 'rm -rf /' })).toBe('/a.ts')
  })

  // REWRITTEN CONTRACT (2026-07-30). This previously asserted `''` for unrecognised
  // args, on the reasoning that they "are frequently large and occasionally
  // sensitive". Large is handled by the cap; sensitive is not a reason to blank the
  // row, because the only destination is the OWNER's own authenticated panel showing
  // his own session. The blank was a real cost: every MCP tool whose argument key is
  // not in the pick list rendered with no hint of what it was called with.
  it('falls back to a compact key=value render for unrecognised args', () => {
    expect(summarizeToolInput({ some_key: 'some-value', nested: { a: 1 } })).toBe(
      'some_key=some-value nested={"a":1}',
    )
  })

  it('still returns empty for genuinely empty input', () => {
    expect(summarizeToolInput(undefined)).toBe('')
    expect(summarizeToolInput({})).toBe('')
  })

  it('flattens whitespace and truncates to a bounded length', () => {
    const out = summarizeToolInput({ command: `a\n\nb   ${'c'.repeat(400)}` })
    expect(out.length).toBeLessThanOrEqual(160)
    expect(out).not.toContain('\n')
    expect(out.endsWith('…')).toBe(true)
  })

  it('ignores non-string and empty values instead of stringifying them', () => {
    expect(summarizeToolInput({ file_path: 123, command: 'ok' })).toBe('ok')
    expect(summarizeToolInput({ file_path: '', command: 'ok' })).toBe('ok')
  })
})

describe('renderToolArgs — the expanded call', () => {
  it('renders a lone string argument as itself, not as JSON', () => {
    // A shell line or a prompt is its own best rendering; JSON quoting only makes
    // it harder to read.
    expect(renderToolArgs({ command: 'a-command --flag\nsecond line' })).toBe(
      'a-command --flag\nsecond line',
    )
  })

  it('pretty-prints a multi-field argument object, preserving structure', () => {
    const out = renderToolArgs({ path: '/a/b.ts', limit: 20 })
    expect(out).toContain('"path"')
    expect(out).toContain('\n')
  })

  it('is empty for empty input and bounded for huge input', () => {
    expect(renderToolArgs(undefined)).toBe('')
    expect(renderToolArgs({})).toBe('')
    const big = renderToolArgs({ command: 'x'.repeat(9_000) })
    expect(big.length).toBeLessThanOrEqual(2_000)
    expect(big.endsWith('…')).toBe(true)
  })
})

describe('renderToolResult — what came back', () => {
  it('handles a plain string result', () => {
    expect(renderToolResult('an output string')).toBe('an output string')
  })

  it('handles the MCP content-block form', () => {
    expect(
      renderToolResult({ content: [{ type: 'text', text: 'block one' }, { type: 'text', text: 'block two' }] }),
    ).toBe('block one\nblock two')
  })

  it('handles the Bash stdout/stderr form, joining both', () => {
    expect(renderToolResult({ stdout: 'out line', stderr: 'err line' })).toBe('out line\nerr line')
  })

  it('handles the Read file-content form', () => {
    expect(renderToolResult({ file: { filePath: '/a.ts', content: 'file body' } })).toBe('file body')
  })

  it('falls through to JSON for an UNKNOWN shape rather than showing nothing', () => {
    // An unfamiliar object is still the answer to "what did it return?"; guessing
    // wrong costs nothing while showing nothing costs the whole feature.
    const out = renderToolResult({ some_field: 'some-value', count: 3 })
    expect(out).toContain('some_field')
    expect(out).toContain('some-value')
  })

  it('is empty for nothing, and bounded for huge output', () => {
    expect(renderToolResult(undefined)).toBe('')
    expect(renderToolResult(null)).toBe('')
    const big = renderToolResult({ stdout: 'y'.repeat(9_000) })
    expect(big.length).toBeLessThanOrEqual(2_000)
    expect(big.endsWith('…')).toBe(true)
  })
})
