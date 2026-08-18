/**
 * @neutronai/gateway/http — Codex subscription connect surface.
 *
 * The admin-panel "Connect Codex" flow for the trident cross-model reviewer.
 * Sibling of `project-credentials-surface.ts`, same bearer auth
 * (`AppWsAuthResolver`) and same owner-boundary rule: `owner_slug` is ALWAYS the
 * server-derived `resolved.project_slug`, never client-supplied.
 *
 * The Codex subscription is a GLOBAL, trident-wide credential (trident runs
 * across ANY project), so the PRIMARY surface is the account-wide route with NO
 * project segment — connected from the General admin UI. A per-project OVERRIDE
 * route stays for the edge case (one project needs a different subscription); an
 * override wins over the global default for that project (store resolver:
 * project → global → unset).
 *
 *   GLOBAL (primary — General admin UI):
 *   - `GET    /api/app/codex-auth`                       → global status + every seat
 *   - `POST   /api/app/codex-auth`                       → connect a seat (body: { auth, account?, label? })
 *   - `DELETE /api/app/codex-auth[?account=<slot>]`      → disconnect one seat
 *
 * MULTIPLE SEATS. The owner may connect more than one ChatGPT subscription; each
 * is a named `account` slot, and trident picks one per run, skipping any that has
 * run into its usage cap. Omitting `account` means the FIRST seat, so every client
 * written before rotation existed keeps behaving identically — and `GET` still
 * returns all of its original top-level status fields, with `accounts` / `active`
 * / `next` added alongside rather than replacing them.
 *
 * `account` is accepted on the GLOBAL route only. A per-project override is
 * deliberately outside rotation (it exists to pin one project to one
 * subscription), so naming a seat there would describe something the resolver
 * ignores — quietly, which is worse than not offering it.
 *
 *   PROJECT OVERRIDE (optional — per-project Settings):
 *   - `GET    /api/app/projects/<project_id>/codex-auth` → effective status (project→global)
 *   - `POST   /api/app/projects/<project_id>/codex-auth` → connect a project override
 *   - `DELETE /api/app/projects/<project_id>/codex-auth` → remove the project override
 *
 * The POST body carries the owner's pasted `~/.codex/auth.json`. Validation +
 * the metered-key rejection + materialization all live in `CodexCredentialService`
 * — this surface is just auth + routing + JSON. A metered `OPENAI_API_KEY` paste
 * comes back as HTTP 400 `metered_key`; a good subscription bundle returns
 * `{ ok, status: 'connected', scope }` after materializing to the scope's CODEX_HOME.
 */

import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import { ProjectCredentialValidationError } from '@neutronai/project-credentials/store.ts'
import { sanitizeProjectId } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type { CodexCredentialService, CodexTarget } from '@neutronai/trident/codex-credential.ts'
import { jsonError, jsonOk, readJsonBody, resolveBearer } from './surface-kit.ts'

export interface CodexCredentialSurfaceOptions {
  service: CodexCredentialService
  auth: AppWsAuthResolver
}

export interface CodexCredentialSurface {
  handler: (req: Request) => Promise<Response | null>
}

/** Global (account-wide) route — the primary Connect Codex surface. */
const GLOBAL_CODEX_AUTH_PATH = '/api/app/codex-auth'
/** Per-project override route. */
const PROJECT_PREFIX = '/api/app/projects/'
const PROJECT_CODEX_AUTH_PATH_RE = /^\/api\/app\/projects\/([^/]+)\/codex-auth$/

/**
 * The pool's status, for the single legacy field every existing client reads.
 *
 * `connected` if ANY seat is usable, else the best thing any seat has to say,
 * else the first seat's own answer. Preferring `connected` over `expired` is
 * deliberate: with one healthy seat and one stale one, trident runs, so
 * reporting anything else would describe a Codex that is not working when it is.
 */
function effectiveStatus<S extends string>(own: S, accounts: readonly { status: S }[]): S {
  const usable = accounts.find((a) => a.status === 'connected')
  if (usable !== undefined) return usable.status
  return accounts[0]?.status ?? own
}

export function createCodexCredentialSurface(
  opts: CodexCredentialSurfaceOptions,
): CodexCredentialSurface {
  const { service, auth } = opts
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname

      // Resolve the target scope from the path: the global route carries no
      // project segment; the project route pins the URL project id as an override.
      let target: CodexTarget
      if (pathname === GLOBAL_CODEX_AUTH_PATH) {
        target = { scope: 'global' }
      } else if (pathname.startsWith(PROJECT_PREFIX)) {
        const match = PROJECT_CODEX_AUTH_PATH_RE.exec(pathname)
        if (match === null) return null
        const project_id = sanitizeProjectId(match[1] ?? '')
        if (project_id === null) {
          return jsonError(400, 'invalid_project_id', 'project_id must be 1-128 chars from [A-Za-z0-9_.-]')
        }
        target = { scope: 'project', project_id }
      } else {
        return null
      }

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) return jsonError(401, resolved.code, resolved.message)
      // Server-derived owner boundary — construct the branded handle at the
      // point it is resolved from auth (the spec's known-good construction site).
      const owner_slug = asOwnerHandle(resolved.project_slug)

      // Which SEAT this request is about. Only meaningful on the global route —
      // a per-project override is deliberately outside rotation, so naming a seat
      // there would describe something the resolver ignores. Absent means the
      // first seat, which is what every pre-rotation client sends.
      const rawAccount = url.searchParams.get('account')
      const isGlobal = target.scope !== 'project'

      switch (req.method) {
        case 'GET': {
          // Status resolves project → global for the override route (effective
          // credential for this project); global route reports the global default.
          // The legacy top-level fields are kept verbatim so existing clients keep
          // working; `accounts` / `active` / `next` are additive.
          const status = service.status(owner_slug, target)
          if (!isGlobal) return jsonOk({ ...status })
          const { accounts, next } = service.accountsView(owner_slug)
          return jsonOk({
            ...status,
            // THE TOP-LEVEL STATUS IS ABOUT THE POOL, NOT ABOUT THE FIRST SEAT.
            // `service.status` reads the `codex` service row, which is seat
            // `default` alone — so an owner who connected only a NAMED seat got
            // `not_connected` here beside a populated `accounts` array. Every
            // pre-rotation client reads this one field: the mobile header
            // announced that cross-model review was off, and the web pane hid
            // Disconnect, while trident was resolving that named seat and
            // running reviews with it. The clients were not wrong to trust the
            // field; the field was answering a narrower question than its name.
            status: effectiveStatus(status.status, accounts),
            accounts,
            active: next?.slot ?? null,
            next: next?.slot ?? null,
            exhausted: next?.exhausted ?? false,
          })
        }
        case 'POST': {
          const body = (await readJsonBody(req)) as Record<string, unknown> | null
          if (body === null) return jsonError(400, 'malformed_json', 'expected JSON body')
          // Accept `auth` (canonical) or `auth_json` / `value` aliases.
          const pasted = body['auth'] ?? body['auth_json'] ?? body['value']
          if (!isGlobal) {
            const result = await service.connect(owner_slug, pasted, target)
            if (!result.ok) {
              return jsonError(400, result.code ?? 'invalid_auth', result.error ?? 'could not connect Codex')
            }
            return jsonOk({ status: result.status, mode: result.mode, scope: result.scope }, 201)
          }
          const requested = body['account'] ?? rawAccount ?? undefined
          const label = typeof body['label'] === 'string' ? (body['label'] as string) : null
          // A label the store refuses (over its length ceiling) is a BAD REQUEST,
          // not a server fault. The store throws a typed validation error and,
          // unmapped, it escaped as a 500 — telling the owner the instance had
          // broken when he had simply typed too long a name, and giving him
          // nothing to correct. The sibling credentials surface has always mapped
          // this; only this route had missed it.
          let result: Awaited<ReturnType<typeof service.connectAccount>>
          try {
            result = await service.connectAccount(owner_slug, pasted, {
              ...(requested === undefined || requested === null ? {} : { slot: String(requested) }),
              label,
            })
          } catch (err) {
            if (err instanceof ProjectCredentialValidationError) {
              return jsonError(400, err.code, err.message)
            }
            throw err
          }
          if (!result.ok) {
            return jsonError(400, result.code ?? 'invalid_auth', result.error ?? 'could not connect Codex')
          }
          return jsonOk(
            {
              status: result.status,
              mode: result.mode,
              scope: result.scope,
              account: result.slot,
              // So a client can say what it did rather than what it intended.
              replaced: result.replaced ?? false,
            },
            201,
          )
        }
        case 'DELETE': {
          // `?account=<slot>` removes ONE seat. An UNQUALIFIED delete removes them
          // ALL, because that is what the single "Disconnect Codex" button in the
          // shipped clients means. Removing only the first seat would leave the
          // named seats stored and still selectable by trident while telling the
          // owner Codex was disconnected.
          if (isGlobal && rawAccount !== null) {
            const { ok } = await service.removeAccount(owner_slug, rawAccount)
            if (!ok) return jsonError(404, 'codex_not_connected', 'no such Codex account to disconnect')
            return jsonOk({ disconnected: true, account: rawAccount })
          }
          if (isGlobal) {
            const { ok, removed } = await service.disconnectAllAccounts(owner_slug)
            if (!ok) return jsonError(404, 'codex_not_connected', 'no Codex credential to disconnect')
            return jsonOk({ disconnected: true, scope: target.scope, accounts: removed })
          }
          const { ok } = await service.disconnect(owner_slug, target)
          if (!ok) return jsonError(404, 'codex_not_connected', 'no Codex credential to disconnect')
          return jsonOk({ disconnected: true, scope: target.scope })
        }
        default:
          return jsonError(405, 'method_not_allowed', `method '${req.method}' not allowed on /codex-auth`)
      }
    },
  }
}
