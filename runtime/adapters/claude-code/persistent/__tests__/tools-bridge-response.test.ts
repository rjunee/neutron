/**
 * tools-bridge-response.test.ts — `null` and "it failed" must not share a return.
 *
 * The defect this pins, measured on the live box: a warm REPL child that
 * outlived a gateway restart kept posting a credential minted by the dead
 * incarnation. The new sink refused every `/tool-call` with
 * `HTTP 401 {"status":"unauthorized"}` — verified against the running sink — and
 * the bridge rendered that as the bare text `null`, with NO `isError`. Three
 * `work_board_start` calls in a row therefore read to the agent as "the tool ran
 * and there was nothing to do", while no run row and no capability verdict were
 * ever created, because `McpServer.dispatch` was never reached.
 *
 * Every case below asserts the two halves that matter: that a refusal is an
 * `isError` carrying a REASON, and that the plain-`null` rendering survives ONLY
 * for a call the sink actually dispatched.
 */

import { describe, it, expect } from 'bun:test'
import { createToolCallHandler } from '../tools-bridge-handler.ts'
import { interpretSinkToolResponse } from '../tools-bridge-response.ts'

function textOf(r: { content: { type: 'text'; text: string }[] }): string {
  return r.content.map((c) => c.text).join('')
}

describe('interpretSinkToolResponse — a refusal is never `null`', () => {
  // THE EXACT WIRE THE LIVE SINK ANSWERED (curl against the running sink at the
  // time of the report): HTTP 401 with a body carrying no `ok` and no `error`.
  it('the pre-fix live wire — 401 {"status":"unauthorized"} — is an isError with a reason', () => {
    const r = interpretSinkToolResponse({ status: 401, body: '{"status":"unauthorized"}' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).not.toBe('null')
    expect(textOf(r)).toContain('401')
    expect(textOf(r)).toContain('unauthorized')
  })

  it('the post-fix sink wire carries the actionable reason through verbatim', () => {
    const r = interpretSinkToolResponse({
      status: 401,
      body: JSON.stringify({
        status: 'unauthorized',
        ok: false,
        error: 'unauthorized: this session presented a credential no live REPL session holds.',
      }),
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('no live REPL session holds')
  })

  it('400 {"status":"bad-json"} is an isError, not `null`', () => {
    const r = interpretSinkToolResponse({ status: 400, body: '{"status":"bad-json"}' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('bad-json')
  })

  for (const [status, body, needle] of [
    [403, '{"ok":false,"error":"tool bridge not granted"}', 'tool bridge not granted'],
    [503, '{"ok":false,"error":"no tool bridge wired"}', 'no tool bridge wired'],
    [400, '{"ok":false,"error":"tool_name required"}', 'tool_name required'],
  ] as [number, string, string][]) {
    it(`HTTP ${status} keeps its reason (${needle})`, () => {
      const r = interpretSinkToolResponse({ status, body })
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain(needle)
    })
  }

  it('THE STATUS IS AUTHORITATIVE: a 500 that claims ok:true is indeterminate', () => {
    // Nothing between the child and the sink is trusted to be the sink. A proxy,
    // a wrong process on the loopback port, or a future route that forgets to
    // fail its status can all answer a success-shaped body; the transport said
    // the call did not succeed, and that wins.
    const r = interpretSinkToolResponse({
      status: 500,
      body: '{"ok":true,"result":{"run_id":"r-1"}}',
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toStartWith('error: tool dispatch outcome indeterminate (HTTP 500)')
    expect(textOf(r)).not.toContain('dispatch refused')
  })

  it('a non-JSON 401 is classified as a refusal before parsing', () => {
    const r = interpretSinkToolResponse({ status: 401, body: '<html>unauthorized</html>' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toStartWith('error: tool dispatch refused (HTTP 401)')
    expect(textOf(r)).toContain('<html>unauthorized</html>')
  })

  it('a non-JSON 500 is indeterminate rather than a parse error or refusal', () => {
    const r = interpretSinkToolResponse({ status: 500, body: '<html>server failed</html>' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toStartWith('error: tool dispatch outcome indeterminate (HTTP 500)')
    expect(textOf(r)).not.toContain('non-JSON')
    expect(textOf(r)).not.toContain('dispatch refused')
  })

  it('a 200 that does not positively claim success is UNKNOWN, not `null`', () => {
    // A route that never learned the tool-call contract, or a future guard that
    // answers 200 with a bare status word. Absence of `ok:true` is not consent.
    const r = interpretSinkToolResponse({ status: 200, body: '{"status":"forbidden"}' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).not.toBe('null')
    expect(textOf(r)).toContain('forbidden')
  })

  it('a 200 ok:false (the handler threw) keeps the handler message', () => {
    const r = interpretSinkToolResponse({
      status: 200,
      body: '{"ok":false,"error":"handler exploded"}',
    })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('error: handler exploded')
  })

  it('a 200 ok:false without an error string still does not report success', () => {
    const r = interpretSinkToolResponse({ status: 200, body: '{"ok":false}' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toStartWith('error: tool dispatch did not report success (HTTP 200)')
  })

  it('a 2xx non-JSON body is a parse fault, named with its status', () => {
    const r = interpretSinkToolResponse({ status: 200, body: '<html>bad gateway</html>' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('non-JSON')
    expect(textOf(r)).toContain('200')
  })

  it('a JSON array body is an unexpected shape, not a result', () => {
    const r = interpretSinkToolResponse({ status: 200, body: '[1,2,3]' })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toContain('unexpected response shape')
  })

  it('a very long unexpected body is truncated rather than echoed whole', () => {
    const r = interpretSinkToolResponse({ status: 500, body: 'x'.repeat(5000) })
    expect(r.isError).toBe(true)
    expect(textOf(r).length).toBeLessThan(600)
    expect(textOf(r)).toContain('…')
  })
})

describe('the executable bridge handler uses this mapping', () => {
  // Invoke the handler factory used by the stdio bridge, including its HTTP transport.
  for (const fixture of [
    { status: 401, body: { status: 'unauthorized' }, isError: true, text: 'unauthorized' },
    { status: 500, body: { ok: true, result: 'must not be treated as success' }, isError: true, text: 'indeterminate' },
    { status: 200, body: { ok: true, result: 'hello' }, isError: undefined, text: 'hello' },
    { status: 200, body: { ok: true }, isError: undefined, text: 'null' },
  ]) {
    it(`carries HTTP ${fixture.status} (${fixture.text}) through the bridge handler`, async () => {
      const requests: { path: string; method: string; token: string | null; body: unknown }[] = []
      const fetchImpl = (async (url, init) => {
        const req = new Request(String(url), init)
        requests.push({
          path: new URL(req.url).pathname,
          method: req.method,
          token: req.headers.get('X-Sink-Token'),
          body: await req.json(),
        })
        return Response.json(fixture.body, { status: fixture.status })
      }) as typeof fetch
      const handler = createToolCallHandler({
        port: 12345,
        token: 'test-credential',
        sessionId: 'test-session',
      }, fetchImpl)
      const result = await handler({ method: 'tools/call', params: { name: 'test_tool', arguments: { value: 7 } } })
      expect(requests).toEqual([{
        path: '/tool-call',
        method: 'POST',
        token: 'test-credential',
        body: {
          session_id: 'test-session',
          tool_name: 'test_tool',
          args: { value: 7 },
          call_id: 'test-session:test_tool',
        },
      }])
      expect(result.isError).toBe(fixture.isError)
      if (fixture.isError) {
        expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining(fixture.text) }])
      } else {
        expect(result.content).toEqual([{ type: 'text', text: fixture.text }])
      }
    })
  }
})

describe('interpretSinkToolResponse — a dispatched call is unchanged', () => {
  it('renders a structured result as pretty JSON', () => {
    const r = interpretSinkToolResponse({
      status: 200,
      body: JSON.stringify({ ok: true, result: { ok: true, run_id: 'r-1', status: 'dispatched' } }),
    })
    expect(r.isError).toBeUndefined()
    expect(JSON.parse(textOf(r))).toEqual({ ok: true, run_id: 'r-1', status: 'dispatched' })
  })

  it('passes a string result through verbatim', () => {
    const r = interpretSinkToolResponse({ status: 200, body: '{"ok":true,"result":"hello"}' })
    expect(r.isError).toBeUndefined()
    expect(textOf(r)).toBe('hello')
  })

  it('a handler that returned NOTHING is the ONLY source of a bare `null`', () => {
    const r = interpretSinkToolResponse({ status: 200, body: '{"ok":true}' })
    expect(r.isError).toBeUndefined()
    expect(textOf(r)).toBe('null')
  })

  it('an ok:false refusal carrying ok=false REASON still beats the tool-returned error envelope', () => {
    // `work_board_start`'s own refusals ride the 200/ok:true path as a RESULT
    // (`{ok:false, error:...}` inside `result`), so they stay readable data.
    const r = interpretSinkToolResponse({
      status: 200,
      body: JSON.stringify({
        ok: true,
        result: { ok: false, error: 'No Plan item "x" on this project\'s board.' },
      }),
    })
    expect(r.isError).toBeUndefined()
    expect(JSON.parse(textOf(r)).error).toContain('No Plan item')
  })
})
