import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js'
import { interpretSinkToolResponse, type SinkToolResponse } from './tools-bridge-response.ts'

interface ToolCallConfig {
  port: number
  token: string
  sessionId: string
}

/** Build the same handler registered by the stdio bridge, with an injectable HTTP transport. */
export function createToolCallHandler(config: ToolCallConfig, fetchImpl: typeof fetch = fetch) {
  // --- Helper: POST to the substrate reply-sink (same loopback as dev-channel) ---

  /**
   * SINGLE attempt — NO retry. Tool calls are NON-idempotent: a write tool
   * (reminder_create, note, dispatch_agent, …) ran by the sink handler must not
   * be re-executed if the loopback connection drops AFTER the handler ran but
   * BEFORE the response is read (fetch would reject and a retry would double-write).
   * `/tool-call` carries no idempotency key, so a failed POST surfaces as an
   * `isError` tool_result the model can retry DELIBERATELY (vs. a silent duplicate).
   * This is the deliberate divergence from the dev-channel's retried `/reply`
   * (which is idempotent — turn-id correlated, and a stale re-post is rejected).
   *
   * RETURNS THE STATUS ALONGSIDE THE BODY. Returning only the text made every
   * refusal look like a success whose body simply lacked the keys the caller
   * looked for — see `tools-bridge-response.ts` for what that cost.
   */
  async function postToSink(path: string, body: Record<string, unknown>): Promise<SinkToolResponse> {
    const resp = await fetchImpl(`http://127.0.0.1:${config.port}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.token ? { 'X-Sink-Token': config.token } : {}),
      },
      body: JSON.stringify(body),
    })
    return { status: resp.status, body: await resp.text() }
  }

  return async (req: CallToolRequest) => {
    const toolName = req.params.name
    const args = req.params.arguments ?? {}
    try {
      const resp = await postToSink('/tool-call', {
        session_id: config.sessionId,
        tool_name: toolName,
        args,
        call_id: `${config.sessionId}:${toolName}`,
      })
      // THE HTTP STATUS IS PART OF THE ANSWER. It used to be discarded here, and
      // that is how a 401 from a sink that no longer knows this child reached the
      // model as a bare `null` — the same thing a tool with nothing to report says.
      return interpretSinkToolResponse(resp)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      process.stderr.write(`neutron-tools-bridge: tool ${toolName} failed: ${msg}\n`)
      return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true }
    }
  }
}
