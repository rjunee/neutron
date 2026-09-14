/**
 * @neutronai/gateway — the owner's GitHub connect surface (ISSUES: the coding loop).
 *
 * The last piece of the chain. `github/device-flow.ts` owns the protocol,
 * `github/connect.ts` the order, `github/credential.ts` the storage, and
 * `trident/git-mode.ts` hands the token to every host command. All of that is
 * merged and deployed; none of it could be STARTED, because nothing exposed the
 * flow to the owner.
 *
 * ── WHY START/STATUS AND NOT ONE CALL ────────────────────────────────────────
 *
 * Device flow is the one OAuth shape that cannot complete inside a request. The
 * server asks GitHub for a code, the OWNER types it into a browser, and only then
 * does polling succeed — which can take a minute or several. So:
 *
 *   POST → ask GitHub for a code, return the `user_code` + `verification_uri`
 *          IMMEDIATELY, and keep polling in the background until the owner
 *          approves (or the code expires).
 *   DELETE → remove the saved token and cancel the pending connection locally.
 *            Already-running commands keep their copy; upstream revocation is separate.
 *   GET  → what is the state right now: connected, awaiting the owner (with the
 *          code to show him again), or nothing started.
 *
 * A single blocking call would hold a request open for minutes and give the owner
 * nothing to act on in the meantime, which is the same as not shipping it.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────
 *
 * The `device_code` never leaves this module. It is the bearer half of the
 * exchange — anyone holding it can complete the flow and receive the token — so
 * `github/connect.ts` hands the presenter a type that structurally omits it, and
 * the GET response reports only the short `user_code` a human types. Nor is the
 * TOKEN ever returned: the only legitimate reader is the host-command runner,
 * through the secrets store.
 *
 * A failed flow stores nothing, so `readGitHubToken` keeps answering "not
 * connected" rather than handing a build a credential that cannot authenticate.
 */

import { asOwnerHandle, type OwnerHandle } from '@neutronai/persistence/index.ts'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { connectGitHub, type PresentableGrant } from '@neutronai/github/connect.ts'
import { deleteGitHubToken, readGitHubToken } from '@neutronai/github/credential.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { jsonError, jsonOk, resolveBearer } from './surface-kit.ts'

const GITHUB_AUTH_PATH = '/api/app/github-auth'

/** What the owner is shown while a flow is in flight. Never the `device_code`. */
interface PendingFlow {
  user_code: string
  verification_uri: string
  expires_at_ms: number
}

export interface GitHubConnectSurfaceOptions {
  secrets: SecretsStore
  auth: AppWsAuthResolver
  /**
   * The deployment's GitHub OAuth App client id, or null when none is configured.
   * Not a secret — a client id appears in every authorize URL — but device flow
   * cannot produce a code without one, so its absence is reported as a named
   * error rather than a generic failure.
   */
  client_id: string | null
  /** Injected in tests. */
  now?: () => number
  /** Injected in tests so the flow can be driven without real HTTP. */
  connect?: typeof connectGitHub
  /** Observability. */
  log?: (event: string, detail: Record<string, unknown>) => void
}

export interface GitHubConnectSurface {
  handler: (req: Request) => Promise<Response | null>
}

export function createGitHubConnectSurface(
  opts: GitHubConnectSurfaceOptions,
): GitHubConnectSurface {
  const now = opts.now ?? ((): number => Date.now())
  const run = opts.connect ?? connectGitHub
  const log = opts.log ?? ((): void => undefined)

  // One flow at a time, per owner. A second START while one is live returns the
  // SAME code rather than minting a rival: two live device codes for one account
  // means the owner can approve the one the server stopped polling, which
  // presents as "I approved it and nothing happened".
  const pending = new Map<string, PendingFlow>()

  // Requests and credential writes share a per-owner queue. A DELETE waits for
  // a write already executing, and invalidates every later write from that flow.
  const queues = new Map<OwnerHandle, Promise<unknown>>()
  const exclusive = <T>(owner: OwnerHandle, action: () => Promise<T>): Promise<T> => {
    const result = (queues.get(owner) ?? Promise.resolve()).then(action, action)
    queues.set(owner, result)
    return result.finally(() => {
      if (queues.get(owner) === result) queues.delete(owner)
    })
  }
  const active = new Map<OwnerHandle, { cancel: () => void; reply: () => Promise<Response> }>()

  const livePending = (owner: OwnerHandle): PendingFlow | null => {
    const p = pending.get(owner)
    if (p === undefined) return null
    if (p.expires_at_ms <= now()) {
      pending.delete(owner)
      active.get(owner)?.cancel()
      active.delete(owner)
      return null
    }
    return p
  }

  return {
    handler: async (req) => {
      const url = new URL(req.url)
      if (url.pathname !== GITHUB_AUTH_PATH) return null

      const resolved = await resolveBearer(req, opts.auth)
      if ('code' in resolved) return jsonError(401, resolved.code, resolved.message)
      const owner = asOwnerHandle(resolved.project_slug)

      const response = await exclusive(owner, async () => {
        if (req.method === 'DELETE') {
          active.get(owner)?.cancel()
          const cancelled = active.delete(owner)
          pending.delete(owner)
          const removed = await deleteGitHubToken(opts.secrets, owner)
          return jsonOk({ status: 'not_connected', removed, cancelled })
        }

        if (req.method === 'GET') {
          const token = await readGitHubToken(opts.secrets, owner)
          if (token !== null) return jsonOk({ status: 'connected' })
          const p = livePending(owner)
          if (p !== null) {
            return jsonOk({
              status: 'awaiting_owner',
              user_code: p.user_code,
              verification_uri: p.verification_uri,
              expires_in_seconds: Math.max(0, Math.round((p.expires_at_ms - now()) / 1000)),
            })
          }
          return jsonOk({ status: 'not_connected' })
        }

        if (req.method !== 'POST') {
          return jsonError(405, 'method_not_allowed', 'use GET for status, POST to connect or DELETE to disconnect')
        }

        if (await readGitHubToken(opts.secrets, owner) !== null) {
          // Idempotent: re-connecting an already-connected account would mint a code
          // for no reason and invite the owner to authorise something twice.
          return jsonOk({ status: 'connected' })
        }
        const existing = livePending(owner)
        if (existing !== null) {
          return jsonOk({
            status: 'awaiting_owner',
            user_code: existing.user_code,
            verification_uri: existing.verification_uri,
            expires_in_seconds: Math.max(0, Math.round((existing.expires_at_ms - now()) / 1000)),
          })
        }

        const starting = active.get(owner)
        if (starting !== undefined) return starting.reply

        if (opts.client_id === null || opts.client_id.length === 0) {
          return jsonError(
            503,
            'github_client_id_unset',
            'NEUTRON_GITHUB_CLIENT_ID is not configured on this instance, so a device code cannot be requested',
          )
        }

        // The code has to reach the caller BEFORE polling starts, and polling has to
        // outlive this request. So the presenter resolves a promise this handler
        // awaits, while `connectGitHub` continues in the background.
        let settle: ((g: PresentableGrant) => void) | null = null
        const shown = new Promise<PresentableGrant>((resolve) => {
          settle = resolve
        })

        let cancel!: () => void
        const cancelled = new Promise<Response>((resolve) => {
          cancel = () => resolve(jsonError(409, 'github_connect_cancelled', 'GitHub connection was cancelled'))
        })
        let reply!: Promise<Response>
        const identity = {
          cancel,
          // Each concurrent start gets its own consumable response body.
          reply: () => reply.then(async (response) => new Response(await response.clone().text(), {
            status: response.status,
            headers: response.headers,
          })),
        }
        active.set(owner, identity)
        const finish = (): void => {
          if (active.get(owner) === identity) {
            active.delete(owner)
            pending.delete(owner)
          }
        }
        const flow = run({
          client_id: opts.client_id,
          store: {
            put: (input) => exclusive(owner, async () => {
              if (active.get(owner) !== identity) {
                throw new Error('GitHub connection was cancelled')
              }
              return opts.secrets.put(input)
            }),
          },
          owner_handle: owner,
          present: async (grant): Promise<void> => {
            if (active.get(owner) !== identity) throw new Error('GitHub connection was cancelled')
            pending.set(owner, {
              user_code: grant.user_code,
              verification_uri: grant.verification_uri,
              expires_at_ms: now() + grant.expires_in_seconds * 1000,
            })
            // Codes only. A journal line is a durable artifact and the device_code is
            // bearer material.
            log('github_device_code_issued', {
              user_code: grant.user_code,
              expires_in_seconds: grant.expires_in_seconds,
            })
            settle?.(grant)
          },
          deps: {
            fetchImpl: globalThis.fetch as never,
            now: () => Date.now(),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          },
        })

        // Background completion. The request has already answered by then; the token
        // (or the failure) lands in the store, which is what every later read uses.
        // The RAW promise plus an `onError`, not a pre-swallowed one: a `.catch` before
        // the wrapper would hide the rejection from the counter that exists to make
        // exactly this kind of detached work observable.
        fireAndForget(
          'github_device_flow',
          flow.then((result) => {
            finish()
            log(
              result.connected ? 'github_connected' : 'github_connect_failed',
              result.connected ? {} : { reason: result.reason },
            )
          }),
          (err: unknown) => {
            finish()
            // A presenter or storage fault, not a device-flow outcome. Never a token.
            log('github_connect_error', {
              error: err instanceof Error ? err.message : String(err),
            })
          },
        )

        // If the very first call to GitHub fails, `present` never runs and `shown`
        // never settles — so race it against the flow's own rejection rather than
        // hanging the request.
        reply = Promise.race([cancelled, (async () => {
          const outcome = await Promise.race([
            shown.then((g) => ({ kind: 'shown' as const, g })),
            flow.then((r) => ({ kind: 'done' as const, r })),
          ])

          if (outcome.kind === 'done') {
            if (outcome.r.connected) return jsonOk({ status: 'connected' })
            return jsonError(502, 'github_device_code_failed', `could not start device flow: ${outcome.r.reason}`)
          }

          return jsonOk({
            status: 'awaiting_owner',
            user_code: outcome.g.user_code,
            verification_uri: outcome.g.verification_uri,
            expires_in_seconds: outcome.g.expires_in_seconds,
          })
        })()])
        return identity.reply
      })
      return typeof response === 'function' ? response() : response
    },
  }
}
