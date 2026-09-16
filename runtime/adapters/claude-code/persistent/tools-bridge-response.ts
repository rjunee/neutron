/**
 * tools-bridge-response.ts — how a reply-sink `/tool-call` answer becomes an MCP
 * `CallToolResult` for the spawned agent.
 *
 * SPLIT OUT OF `tools-bridge-impl.ts` SO IT CAN BE TESTED. The impl module is a
 * process entry point: it connects a `StdioServerTransport` at import time, so a
 * unit test cannot import it to exercise the mapping. The mapping is the half
 * that was wrong, so it lives here, as a pure function of (HTTP status, body).
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE — `null` and "it failed" MUST NOT SHARE A
 * RETURN. A tool result of bare `null` reads to the model as "the tool ran and
 * had nothing to say", which is indistinguishable from "nothing to do". Before
 * this split the bridge produced exactly that for a call that never ran:
 *
 *   - `postToSink` returned only `await resp.text()`, discarding `resp.status`,
 *     so an HTTP 401/400/500 was indistinguishable from a 200;
 *   - the error branch keyed ONLY on `ok === false || error !== undefined`, and
 *     the sink's two pre-route guards answer `{"status":"unauthorized"}` /
 *     `{"status":"bad-json"}` — neither key present;
 *   - so the success branch ran, found no `result` key, and coalesced it to the
 *     literal text `null`, with no `isError`.
 *
 * MEASURED, not hypothesised: a warm REPL child that outlives a gateway restart
 * keeps posting a credential minted by the dead incarnation. The new sink's
 * credential→session map has never seen it, so EVERY tool call it makes is
 * refused 401 — and every one of them surfaced to the agent as `null`. A build
 * dispatch that cannot start must say why.
 *
 * So: every non-dispatch outcome is an `isError` result carrying a reason, and a
 * bare `null` can now only come back from a call the sink actually dispatched.
 */

/** What the bridge learned from one POST to the sink's `/tool-call` route. */
export interface SinkToolResponse {
  /** The HTTP status. NOT optional — dropping it is how the bug happened. */
  status: number
  /** The raw response body. */
  body: string
}

/**
 * The MCP `CallToolResult` shape the bridge hands back to the spawned agent.
 *
 * The index signature is REQUIRED, not decorative: the SDK's request-handler
 * return type is an open `{ [x: string]: unknown }` union, which an exact
 * interface does not satisfy. The inline object literals this replaced matched it
 * by freshness; a named type has to say so.
 */
export interface BridgeToolResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  isError?: true
}

/** Cap on how much of an unexpected body is echoed into a tool result. */
const MAX_BODY_ECHO = 400

function truncate(text: string): string {
  const flat = text.trim()
  return flat.length > MAX_BODY_ECHO ? `${flat.slice(0, MAX_BODY_ECHO)}…` : flat
}

function fail(text: string): BridgeToolResult {
  return { content: [{ type: 'text', text: `error: ${text}` }], isError: true }
}

function ok(text: string): BridgeToolResult {
  return { content: [{ type: 'text', text }] }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A human-readable reason from whatever the sink chose to say. */
function reasonFrom(parsed: Record<string, unknown>, body: string): string {
  const error = parsed['error']
  if (typeof error === 'string' && error.trim() !== '') return error
  const status = parsed['status']
  if (typeof status === 'string' && status.trim() !== '') return status
  return truncate(body)
}

/**
 * Map one sink answer onto a tool result.
 *
 * Ordered so that EVERY outcome in which the tool did not demonstrably run is an
 * `isError` with a reason, and the plain-`null` rendering is reachable only from
 * `HTTP 2xx` + `ok: true` — i.e. a call the sink dispatched, whose handler
 * genuinely returned nothing.
 */
export function interpretSinkToolResponse(resp: SinkToolResponse): BridgeToolResult {
  const httpOk = resp.status >= 200 && resp.status < 300
  if (!httpOk) {
    const reason = truncate(resp.body)
    if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
      return fail(`tool dispatch refused (HTTP ${resp.status}): ${reason}`)
    }
    return fail(`tool dispatch outcome indeterminate (HTTP ${resp.status}): ${reason}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(resp.body)
  } catch {
    // The sink always answers JSON; a non-JSON body is an infra fault (a proxy
    // error page, a truncated response, a different server on the port).
    return fail(`tool bridge got a non-JSON response (HTTP ${resp.status}): ${truncate(resp.body)}`)
  }
  if (!isPlainObject(parsed)) {
    return fail(`tool bridge got an unexpected response shape (HTTP ${resp.status}): ${truncate(resp.body)}`)
  }
  const error = parsed['error']
  if (typeof error === 'string' && error.trim() !== '') return fail(error)
  if (parsed['ok'] !== true) {
    // A 2xx that does not positively claim success. `ok: false` with no message,
    // or a body from a route that never learned this contract — either way the
    // dispatch is UNKNOWN, which is not the same answer as `null`.
    return fail(
      `tool dispatch did not report success (HTTP ${resp.status}): ${reasonFrom(parsed, resp.body)}`,
    )
  }
  // Dispatched. Return the structured result as a JSON text block so the model
  // gets the full payload (arrays/objects) it can reason over, not a lossy
  // summary. A handler that returned nothing renders as `null` — and now ONLY a
  // handler that returned nothing can.
  const result = parsed['result']
  if (result === undefined) return ok('null')
  if (typeof result === 'string') return ok(result)
  return ok(JSON.stringify(result, null, 2))
}
