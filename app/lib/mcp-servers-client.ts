/**
 * @neutronai/app — installable MCP servers client (mobile).
 *
 *   GET    /api/app/mcp-servers          what is installed, and where each stands
 *   POST   /api/app/mcp-servers          install or replace one
 *   DELETE /api/app/mcp-servers?name=…   uninstall
 *   POST   /api/app/mcp-servers/decision approve or deny the installed spec
 *
 * THE APPROVAL PROMPT COMES FROM THE SERVER, as `grant_prompt`, and is displayed
 * verbatim. This client never assembles it. A prompt built on the device could
 * describe a command other than the one the server hashed and would actually run,
 * which is what makes a dishonest gate worse than no gate.
 *
 * INSTALLING IS NOT APPROVING. Two calls, deliberately: `install` records what the
 * owner wants and puts it in front of him; `decide` is the affirmative act. Approving
 * is never a side effect of typing a command into a form, and never inferable from
 * silence.
 *
 * VALUES GO UP AND NEVER COME BACK. `install` sends `env` as NAME → value; every
 * response carries `env_names` only. No field on the wire returns a secret, so there
 * is nothing here to accidentally render or log.
 *
 * Wire shapes are re-declared rather than imported across the workspace boundary —
 * the app bundle stays free of gateway dependencies, as every client here does. The
 * two pure helpers at the bottom are the ones that MUST match the web twin
 * (`landing/chat-react/mcp-servers-client.ts`); a cross-client test executes both.
 */

/** Where an installed server stands with the owner. */
export type McpApprovalState = 'approved' | 'pending' | 'denied' | 'unapproved';

/** One installed server, as the server describes it. Never carries an env value. */
export interface McpServerRow {
  name: string;
  command: string;
  args: string[];
  env_names: string[];
  approval: McpApprovalState;
  /** The verbatim, server-rendered grant text. Display as-is; never rebuild it. */
  grant_prompt: string;
  /** The digest of THIS spec. Echoed back on a decision — see {@link McpServersClient.decide}. */
  grant_hash: string;
  secrets_present: boolean;
  /**
   * Approved AND usable: the assistant attaches this server the next time it starts a
   * session. NOT "a process is running right now" — the servers are attached to the
   * Claude-backed conversational session, and a project pointed at a different model
   * provider does not get them. The screen copy says so; `serverSummary` below is
   * careful not to claim otherwise.
   */
  active: boolean;
}

export interface McpServersPayload {
  servers: McpServerRow[];
  reserved_names: string[];
  max_servers: number;
}

/** What the owner typed into the form. `env` values are write-only. */
export interface McpServerDraft {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export class McpServersClientError extends Error {
  readonly code: string;
  readonly status: number;
  /**
   * The server's CURRENT list, when the failure reply carried one.
   *
   * A refused decision is the case that needs it: the server has already minted a
   * prompt for the spec that is really installed, and a screen that only learned "409"
   * would keep showing the stale one — so the owner reads a complaint about a mismatch
   * while looking at the very text that caused it. `null` when the reply had no list (a
   * 401, a network failure), where there is nothing to re-render from.
   */
  readonly servers: McpServerRow[] | null;
  constructor(
    code: string,
    message: string,
    status: number,
    servers: McpServerRow[] | null = null,
  ) {
    super(message);
    this.name = 'McpServersClientError';
    this.code = code;
    this.status = status;
    this.servers = servers;
  }
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface McpServersClientOptions {
  base_url: string;
  token: string;
  /** Injected for tests. */
  fetchImpl?: FetchImpl;
}

const PATH = '/api/app/mcp-servers';

export class McpServersClient {
  private readonly base_url: string;
  private readonly token: string;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: McpServersClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async load(): Promise<McpServersPayload> {
    return await this.req<McpServersPayload>('GET', PATH);
  }

  /** Install or replace. Throws with the server's full complaint list on 400. */
  async install(draft: McpServerDraft): Promise<McpServersPayload> {
    return await this.req<McpServersPayload>('POST', PATH, draft);
  }

  async remove(name: string): Promise<McpServersPayload> {
    return await this.req<McpServersPayload>('DELETE', `${PATH}?name=${encodeURIComponent(name)}`);
  }

  /**
   * Record the owner's decision on the spec he was SHOWN.
   *
   * `grant_hash` comes from the row that rendered the prompt, and the server refuses
   * the decision unless it still describes the installed spec. Without it an Approve
   * pressed on a screen that had gone stale (the server edited from the browser, or
   * left open in the background) would have been applied to the NEW command, sight
   * unseen.
   */
  async decide(
    name: string,
    decision: 'approve' | 'deny',
    grant_hash: string,
  ): Promise<McpServersPayload> {
    return await this.req<McpServersPayload>('POST', `${PATH}/decision`, {
      name,
      decision,
      grant_hash,
    });
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    let payload: string | undefined;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base_url}${path}`, {
        method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
      });
    } catch (err) {
      throw new McpServersClientError(
        'network',
        err instanceof Error ? err.message : 'request failed',
        0,
      );
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const code =
        typeof json?.['code'] === 'string' ? (json['code'] as string) : `http_${res.status}`;
      const message =
        typeof json?.['message'] === 'string'
          ? (json['message'] as string)
          : `request failed (${res.status})`;
      const servers = Array.isArray(json?.['servers']) ? (json['servers'] as McpServerRow[]) : null;
      throw new McpServersClientError(code, message, res.status, servers);
    }
    return (json ?? {}) as T;
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
 * would then honestly describe the wrong command. Both quote styles are honoured, and
 * an UNTERMINATED quote is kept as the rest of the line rather than dropped: refusing
 * to guess where the owner meant to close it.
 *
 * A QUOTE ONLY QUOTES AT THE START OF A SEGMENT. Anywhere else it is an ordinary
 * character. That is what makes `/srv/it's/server.js` survive as typed — under the
 * earlier "a quote anywhere opens a quote" rule the apostrophe opened a quoted run and
 * the character vanished, yielding `/srv/its/server.js`: a DIFFERENT path, accepted
 * silently, and then faithfully described by an approval prompt for a command the
 * owner never wrote. The prompt renders and the hash covers whatever this returns, so
 * the failure was not a wrong grant — it was a wrong VALUE reaching a correct grant,
 * which is worse, because nothing downstream can detect it.
 *
 * There is deliberately no escape syntax. A shell-style backslash would be a second
 * quoting language to get wrong, and the one case it buys (a literal quote at the
 * start of a path segment) does not occur in an MCP server command line.
 *
 * MUST MATCH `landing/chat-react/mcp-servers-client.ts#splitCommandLine`.
 */
export function splitCommandLine(line: string): { command: string; args: string[] } {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if ((ch === '"' || ch === "'") && !started) {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        parts.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) parts.push(current);
  const command = parts.length > 0 ? parts[0]! : '';
  return { command, args: parts.slice(1) };
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
 * THE APPROVED LABEL DOES NOT SAY "RUNNING", and that is a correction rather than a
 * style choice. It used to read "Approved and running with your assistant", which
 * claimed more than the code does twice over: the server is attached when the
 * conversational session next STARTS (nothing is running while the assistant is idle),
 * and it is attached to the Claude-backed session only — a project configured for
 * another model provider never sees it (`gateway/wiring/build-llm-call-substrate.ts`
 * takes its non-Claude branch before any of this wiring). Overstating a grant is the
 * failure this whole feature was built to avoid, so the label states the fact that is
 * actually true and the screen copy carries the provider caveat.
 *
 * MUST MATCH `landing/chat-react/mcp-servers-client.ts#serverSummary`.
 */
export function serverSummary(row: McpServerRow): { label: string; needs_owner: boolean } {
  if (row.approval === 'pending') return { label: 'Waiting for your approval', needs_owner: true };
  if (row.approval === 'denied') return { label: 'You declined this one', needs_owner: true };
  if (row.approval === 'unapproved') {
    return { label: 'Not approved — review the request below', needs_owner: false };
  }
  if (!row.secrets_present) {
    return { label: 'Approved, but a stored value is missing — save it again', needs_owner: false };
  }
  return { label: 'Approved — your assistant starts it with its next session', needs_owner: false };
}

/**
 * Parse the environment box: one `NAME=value` per line.
 *
 * A value may itself contain `=` (tokens do), so only the FIRST `=` splits.
 *
 * A NON-EMPTY LINE WITH NO `=` IS AN ERROR, not a line to skip. Both clients used to
 * drop it silently, which meant a mistyped `EXAMPLE_API_KEY sk-…` installed a server
 * with NO variables — and, because the reply only lists the names that were saved, the
 * missing one looked like a display quirk rather than the reason the server would never
 * start. The names are the one part of the grant the owner is asked to check, so a line
 * he intended as a variable must never disappear on the way to the prompt.
 *
 * Reports EVERY bad line, quoting only the part before any `=` (there is none) capped
 * short — enough to identify the line, never enough to dump a pasted secret into a UI
 * string that might be logged.
 *
 * MUST MATCH `landing/chat-react/mcp-servers-client.ts#parseEnvLines`.
 */
export function parseEnvLines(text: string): { env: Record<string, string>; errors: string[] } {
  const env: Record<string, string> = {};
  const errors: string[] = [];
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      errors.push(`line ${i + 1} is not NAME=value: "${trimmed.slice(0, 24)}"`);
      continue;
    }
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return { env, errors };
}
