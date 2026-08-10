/**
 * @neutronai/gateway/http — the installed-MCP-servers settings surface.
 *
 * Backs the Settings "MCP servers" section on BOTH clients: what is installed, what
 * the assistant is allowed to start, the exact prompt for anything still waiting on
 * the owner, and the controls that change any of it.
 *
 *   - `GET    /api/app/mcp-servers`          → the whole picture
 *   - `POST   /api/app/mcp-servers`          → install or replace ({ name, command, args, env })
 *   - `DELETE /api/app/mcp-servers?name=…`   → uninstall
 *   - `POST   /api/app/mcp-servers/decision` → approve or deny ({ name, decision })
 *
 * Every route answers with the SAME `{ servers }` object, so a client never has to
 * guess what a mutation did — it re-renders from the reply. That convention comes
 * from `voice-transcription-surface.ts`, and so does the scoping: MACHINE-SCOPED,
 * not per-project (one installed set serves every project on this box), so the paths
 * carry no project segment.
 *
 * ── THE ENV VALUES ARE WRITE-ONLY ───────────────────────────────────────────
 * A response carries `env_names` and never a value — not even a masked or
 * last-four slice. This repo's convention is to OMIT secret material from responses
 * rather than partially reveal it (`gateway/transcription/openai-key-store.ts`), and
 * an error message here describes the SHAPE of a problem without echoing the value,
 * because an error body is a log line waiting to happen. A name IS echoed: it is not
 * a secret, and the owner needs to know which row is wrong.
 *
 * ── APPROVAL IS AN AFFIRMATIVE ACT, ON A SPECIFIC COMMAND ───────────────────
 * Installing does not approve. `POST /decision` is the only thing that approves, it
 * carries an explicit `decision`, and the store resolves the grant whose hash
 * matches the CURRENTLY installed spec — so a decision can never land on a command
 * other than the one the prompt described. Approval cannot be inferred from silence,
 * from an unrelated request, or from the act of typing a command into a form.
 *
 * ── THE TWO PATHS, AND WHY THE MATCH IS EXACT ───────────────────────────────
 * `/api/app/mcp-servers` is a PREFIX of `/api/app/mcp-servers/decision`. The match
 * below is string EQUALITY per path, never `startsWith`, because a prefix match here
 * would answer a decision POST with the collection handler — a 200 carrying the
 * wrong body, which no client can detect. Both directions are pinned by
 * `__tests__/app-mcp-servers-surface.test.ts`.
 */

import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type { OwnerMcpServerStore } from '@neutronai/gateway/mcp-servers/store.ts'
import { MCP_SERVERS_MAX, RESERVED_MCP_SERVER_NAMES } from '@neutronai/runtime/mcp-servers.ts'
import { jsonError, jsonOk, readJsonBody, resolveBearer } from './surface-kit.ts'

export interface McpServersSurfaceOptions {
  auth: AppWsAuthResolver
  store: OwnerMcpServerStore
}

export interface McpServersSurface {
  handler: (req: Request) => Promise<Response | null>
}

const PATH = '/api/app/mcp-servers'
const DECISION_PATH = `${PATH}/decision`

export function createAppMcpServersSurface(opts: McpServersSurfaceOptions): McpServersSurface {
  const { auth, store } = opts

  const payload = async (): Promise<object> => ({
    servers: await store.list(),
    /** The names Neutron's own plumbing occupies, so a client can say so up front. */
    reserved_names: [...RESERVED_MCP_SERVER_NAMES],
    max_servers: MCP_SERVERS_MAX,
  })

  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      if (pathname !== PATH && pathname !== DECISION_PATH) return null

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) return jsonError(401, resolved.code, resolved.message)

      if (pathname === DECISION_PATH) {
        if (req.method !== 'POST') {
          return jsonError(
            405,
            'method_not_allowed',
            `method '${req.method}' not allowed on ${DECISION_PATH}`,
          )
        }
        const body = (await readJsonBody(req)) as Record<string, unknown> | null
        const decision = body?.['decision']
        if (decision !== 'approve' && decision !== 'deny') {
          // No default. A missing/garbled decision must never resolve to "approve",
          // and resolving it to "deny" would silently discard an approval the owner
          // did make.
          return jsonError(400, 'invalid_decision', "decision must be 'approve' or 'deny'")
        }
        const result = await store.decide(body?.['name'], decision)
        if (!result.ok) {
          return jsonError(409, 'decision_stale', result.error ?? 'the decision could not be applied')
        }
        return jsonOk(await payload())
      }

      switch (req.method) {
        case 'GET':
          return jsonOk(await payload())

        case 'POST': {
          const body = (await readJsonBody(req)) as Record<string, unknown> | null
          const result = await store.install(body)
          if (!result.ok) {
            // Every problem, joined — the owner is the only one who can fix a bad
            // value and a form that reports one fault at a time is a form nobody
            // finishes.
            return jsonError(400, 'invalid_mcp_server', result.errors.join('; '))
          }
          return jsonOk(await payload())
        }

        case 'DELETE': {
          const name = url.searchParams.get('name')
          if (name === null || name.trim().length === 0) {
            return jsonError(400, 'missing_name', 'name is required — pass ?name=<server>')
          }
          const result = await store.remove(name)
          if (!result.removed) {
            return jsonError(404, 'not_installed', `no MCP server named '${name}' is installed`)
          }
          return jsonOk(await payload())
        }

        default:
          return jsonError(405, 'method_not_allowed', `method '${req.method}' not allowed on ${PATH}`)
      }
    },
  }
}
