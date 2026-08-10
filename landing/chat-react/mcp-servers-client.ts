/**
 * landing/chat-react — installable MCP servers client (web).
 *
 *   GET    /api/app/mcp-servers          what is installed, and where each stands
 *   POST   /api/app/mcp-servers          install or replace one
 *   DELETE /api/app/mcp-servers?name=…   uninstall
 *   POST   /api/app/mcp-servers/decision approve or deny the installed spec
 *
 * THE TWIN of `app/lib/mcp-servers-client.ts`. Written twice rather than shared,
 * following the convention every client here already follows: the browser bundle
 * stays free of workspace dependencies, so wire shapes are re-declared. What must NOT
 * diverge are the two pure helpers below — they encode product decisions, not
 * transport, and a web copy that quietly disagreed with the phone would give the same
 * owner two different answers about which programs his assistant may start.
 * `gateway/__tests__/mcp-servers-client-parity.test.ts` executes both side by side.
 *
 * THE APPROVAL PROMPT COMES FROM THE SERVER, as `grant_prompt`, and is displayed
 * VERBATIM. Neither client assembles it. A prompt built client-side could describe a
 * command other than the hashed one the server would actually run, which is the exact
 * failure mode that makes a gate worse than no gate.
 *
 * VALUES GO UP AND NEVER COME BACK. `install` sends `env` as NAME → value; every
 * response carries `env_names` only. There is no field on the wire that returns a
 * secret, so there is nothing here to accidentally render.
 */

/** Where an installed server stands with the owner. */
export type McpApprovalState = 'approved' | 'pending' | 'denied' | 'unapproved'

/** One installed server, as the server describes it. Never carries an env value. */
export interface McpServerRow {
  name: string
  command: string
  args: string[]
  env_names: string[]
  approval: McpApprovalState
  /** The verbatim, server-rendered grant text. Display as-is; never rebuild it. */
  grant_prompt: string
  secrets_present: boolean
  /** Approved AND usable — i.e. this server is wired into the agent's session. */
  active: boolean
}

export interface McpServersPayload {
  servers: McpServerRow[]
  reserved_names: string[]
  max_servers: number
}

/** What the owner typed into the form. `env` values are write-only. */
export interface McpServerDraft {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

export class McpServersClientError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'McpServersClientError'
    this.code = code
    this.status = status
  }
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export interface McpServersClientOptions {
  base_url: string
  token: string
  fetchImpl?: FetchImpl
}

const PATH = '/api/app/mcp-servers'

export class WebMcpServersClient {
  private readonly base_url: string
  private readonly token: string
  private readonly fetchImpl: FetchImpl

  constructor(opts: McpServersClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  async load(): Promise<McpServersPayload> {
    return await this.req<McpServersPayload>('GET', PATH)
  }

  /** Install or replace. Throws with the server's full complaint list on 400. */
  async install(draft: McpServerDraft): Promise<McpServersPayload> {
    return await this.req<McpServersPayload>('POST', PATH, draft)
  }

  async remove(name: string): Promise<McpServersPayload> {
    return await this.req<McpServersPayload>('DELETE', `${PATH}?name=${encodeURIComponent(name)}`)
  }

  /** Record the owner's decision on the CURRENTLY installed spec. */
  async decide(name: string, decision: 'approve' | 'deny'): Promise<McpServersPayload> {
    return await this.req<McpServersPayload>('POST', `${PATH}/decision`, { name, decision })
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` }
    let payload: string | undefined
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    let res: Response
    try {
      res = await this.fetchImpl(`${this.base_url}${path}`, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
      })
    } catch (err) {
      throw new McpServersClientError(
        'network',
        err instanceof Error ? err.message : 'request failed',
        0,
      )
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!res.ok) {
      const code = typeof json?.['code'] === 'string' ? (json['code'] as string) : `http_${res.status}`
      const message =
        typeof json?.['message'] === 'string'
          ? (json['message'] as string)
          : `request failed (${res.status})`
      throw new McpServersClientError(code, message, res.status)
    }
    return (json ?? {}) as T
  }
}

/**
 * Split a command line the owner typed into a command plus its args.
 *
 * The form takes ONE line because that is how MCP servers are documented and how the
 * owner already has them on his clipboard; splitting it here is what turns that paste
 * into the `command` + `args` the server validates and the approval prompt itemises.
 *
 * QUOTED SEGMENTS SURVIVE AS ONE ARG. `--flag "two words"` is one argument, not two,
 * because splitting it would silently change what runs — and the approval prompt
 * would then honestly describe the wrong command. Both quote styles are honoured, a
 * quote can appear inside a segment, and an UNTERMINATED quote is kept as the rest of
 * the line rather than dropped: refusing to guess where the owner meant to close it,
 * while never discarding characters he typed.
 *
 * MUST MATCH `app/lib/mcp-servers-client.ts#splitCommandLine`.
 */
export function splitCommandLine(line: string): { command: string; args: string[] } {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        parts.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) parts.push(current)
  const command = parts.length > 0 ? parts[0]! : ''
  return { command, args: parts.slice(1) }
}

/**
 * The one-line summary a row shows, and whether it needs the owner's attention.
 *
 * `needs_owner` is what drives every "act on this" affordance in both UIs, so the rule
 * lives here once. It is TRUE for `pending` (he has not answered) and for `denied`
 * (he said no, and the row still sits in his list) — and FALSE for `unapproved`,
 * which is the state a row lands in when its command was edited after approval: the
 * server has already re-asked, so the pending row is what he acts on, not this one.
 *
 * An APPROVED server whose secrets are missing is called out rather than shown as
 * running, because "approved" and "actually starting" are different facts and the
 * difference is invisible from chat.
 *
 * MUST MATCH `app/lib/mcp-servers-client.ts#serverSummary`.
 */
export function serverSummary(row: McpServerRow): { label: string; needs_owner: boolean } {
  if (row.approval === 'pending') return { label: 'Waiting for your approval', needs_owner: true }
  if (row.approval === 'denied') return { label: 'You declined this one', needs_owner: true }
  if (row.approval === 'unapproved') {
    return { label: 'Not approved — review the request below', needs_owner: false }
  }
  if (!row.secrets_present) {
    return { label: 'Approved, but a stored value is missing — save it again', needs_owner: false }
  }
  return { label: 'Approved and running with your assistant', needs_owner: false }
}
