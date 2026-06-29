/**
 * Open single-owner Claude-Max OAuth install-token handoff.
 *
 * AUTH-CORRECTION (Ryan-locked 2026-06-28): a fresh Open install's FIRST chat
 * screen is the Claude-Max-auth handoff — a copy-paste terminal one-liner that
 * installs the `claude` CLI, runs `claude setup-token`, captures the
 * `sk-ant-oat…` OAuth token, and POSTs it back so the page can auto-advance into
 * onboarding. This REPLACES the dead 503 "Authenticate Claude" page that only
 * printed manual instructions. The Keychain fast-path (#101,
 * `open/ambient-claude-auth.ts`) stays as a save-a-step optimisation — when the
 * box already has an ambient `claude` login, `resolveOpenLlmPool` resolves it
 * and this gate never renders. The handoff is the DEFAULT (no token + no
 * Keychain — the case every managed tenant and every Linux box hits).
 *
 * This is a faithful but SIMPLIFIED port of the managed monorepo flow
 * (`neutron-old/identity/oauth/install-token-{handoff,store,page,script}.ts`).
 * The managed flow is a TWO-service architecture (identity service + signup
 * landing proxy) that needs an HMAC shared-secret on `/complete` because the
 * bash callback crosses the public internet. Open is SINGLE-SERVICE +
 * single-owner on `127.0.0.1`: the page, the `.sh` script, the callback, and
 * the chat surface are all the SAME localhost process, so the unguessable
 * `signup_id` (a 128-bit UUID minted at `initiate`) is a sufficient capability
 * and no shared secret is needed. Managed wires its own HMAC handler at the
 * same paths.
 *
 * Endpoints (mounted ahead of the `/chat` gate via `installTokenHandler`):
 *   POST /oauth/max/install-token/initiate          → mint signup_id + one-liner
 *   GET  /oauth/max/install-token/<signup_id>.sh     → the bash installer script
 *   POST /oauth/max/install-token/complete           → {signup_id, token} → persist
 *   GET  /oauth/max/install-token/state?signup_id=   → poll status
 *
 * Why a restart (not a live env mutation): the Open composer resolves the LLM
 * substrate ONCE at boot (`resolveOpenLlmPool(env)` → the whole substrate is
 * gated on a non-null pool). A box that boots with no credential has NO
 * substrate object, so mutating `process.env` live would clear the gate but
 * leave chat LLM-less. So `/complete` persists the token to `.env` and asks the
 * supervisor (launchd `KeepAlive` / systemd `Restart=always`) to respawn the
 * process — which re-reads `.env` and builds a LIVE substrate. The page detects
 * the restarted, now-authenticated process by polling `GET /chat` for the
 * 503 → (restart window) → 200 transition.
 */

import { createHash, randomUUID } from 'node:crypto'

/** A well-formed Claude Code OAuth setup-token: `sk-ant-oat01-<base64url>`. */
const SETUP_TOKEN_RE = /^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{32,}$/

/** A v4-ish UUID, the shape `randomUUID()` mints (the install capability). */
const SIGNUP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 10 minutes — matches the managed monorepo's `DEFAULT_TTL_MS`. */
const DEFAULT_TTL_MS = 10 * 60 * 1_000

export type InstallTokenStatus = 'pending' | 'completed' | 'expired'

export interface InstallTokenRow {
  signup_id: string
  status: InstallTokenStatus
  created_at_ms: number
  expires_at_ms: number
  completed_at_ms: number | null
}

/**
 * In-memory single-owner handoff store. The whole flow completes inside one
 * page session (mint → run → callback → restart), so there is no need for a DB
 * row that survives the restart — after the respawn the box is authenticated
 * and the gate is gone. Read-time eviction (no background purge), and a
 * transactional `markCompleted` for idempotency under a retried callback.
 */
export class InstallTokenStore {
  private readonly rows = new Map<string, InstallTokenRow>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(opts?: { ttlMs?: number; now?: () => number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS
    this.now = opts?.now ?? Date.now
  }

  create(signup_id: string): InstallTokenRow {
    const created = this.now()
    const row: InstallTokenRow = {
      signup_id,
      status: 'pending',
      created_at_ms: created,
      expires_at_ms: created + this.ttlMs,
      completed_at_ms: null,
    }
    this.rows.set(signup_id, row)
    return row
  }

  /** Read with read-time eviction: a pending row past its TTL reads as expired. */
  get(signup_id: string): InstallTokenRow | null {
    const row = this.rows.get(signup_id)
    if (row === undefined) return null
    if (row.status === 'pending' && row.expires_at_ms < this.now()) {
      return { ...row, status: 'expired' }
    }
    return { ...row }
  }

  /** Idempotent: returns the row on the first transition, null on a replay. */
  markCompleted(signup_id: string): InstallTokenRow | null {
    const row = this.rows.get(signup_id)
    if (row === undefined) return null
    if (row.status !== 'pending') return null
    if (row.expires_at_ms < this.now()) return null
    row.status = 'completed'
    row.completed_at_ms = this.now()
    return { ...row }
  }
}

export interface OpenInstallTokenDeps {
  /**
   * Persist the captured OAuth token durably so the NEXT boot resolves it.
   * Production writes `CLAUDE_CODE_OAUTH_TOKEN=<token>` into the code-dir
   * `.env` (Bun auto-loads it at startup). Injected so tests can assert without
   * touching the filesystem.
   */
  persistToken: (token: string) => Promise<void> | void
  /**
   * Ask the supervisor to respawn this process so the composer re-resolves the
   * substrate with the freshly-persisted token. Production schedules
   * `process.exit(0)` shortly after the response flushes (launchd/systemd
   * respawn). Injected so the in-process test harness can spy without killing
   * the test runner.
   */
  requestRestart: () => void
  /** Test seam: deterministic clock. */
  now?: () => number
  /** Test seam: deterministic signup_id minting. */
  genSignupId?: () => string
  /** Override the handoff TTL (default 10 min). */
  ttlMs?: number
}

export interface OpenInstallTokenHandler {
  /** Bun.serve-shaped: returns a Response on a matched route, else null. */
  handle: (req: Request) => Promise<Response | null>
  /** Exposed for tests. */
  store: InstallTokenStore
}

const ROUTE_PREFIX = '/oauth/max/install-token'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Render the copy-paste bash installer. Minimal deps (bash/curl/uname/grep/
 * tee/mktemp) — no node/npm/brew/sudo. Installs `claude` from claude.ai,
 * runs `claude setup-token` (interactive OAuth browser hop), captures the
 * token from stdout, and POSTs `{signup_id, token}` to the local callback.
 */
export function renderInstallTokenScript(input: {
  signup_id: string
  callback_url: string
}): string {
  // signup_id is a UUID (validated upstream) and callback_url is a same-origin
  // URL we built — both safe to embed in single quotes.
  return `#!/usr/bin/env bash
# Neutron — Claude Code one-liner installer (signup_id=${input.signup_id}).
# Installs the official 'claude' CLI, runs 'claude setup-token', captures the
# Anthropic OAuth token, and hands it back to your local Neutron so chat can run.
# No Node.js, npm, Homebrew, or sudo required.
set -euo pipefail

SIGNUP_ID='${input.signup_id}'
CALLBACK_URL='${input.callback_url}'

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) printf 'Unsupported OS: %s\\n' "$(uname -s)" >&2; exit 1 ;;
esac

export PATH="$HOME/.local/bin:$PATH"

if ! command -v claude >/dev/null 2>&1; then
  printf '==> Installing Claude Code…\\n'
  if ! curl -fsSL https://claude.ai/install.sh | bash; then
    printf 'ERROR: claude install failed.\\n' >&2; exit 1
  fi
  export PATH="$HOME/.local/bin:$PATH"
fi

printf '\\n==> Connecting your Anthropic account…\\n'
printf '    A browser window opens — sign in to Claude, then return here.\\n\\n'

TMPFILE="$(mktemp -t neutron-claude-XXXXXX)"
trap 'rm -f "$TMPFILE"' EXIT

if ! claude setup-token 2>&1 | tee "$TMPFILE"; then
  printf 'ERROR: claude setup-token did not complete.\\n' >&2; exit 1
fi

TOKEN="$(grep -oE 'sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]+' "$TMPFILE" | tail -n 1 || true)"
if [ -z "$TOKEN" ]; then
  printf 'ERROR: could not capture an Anthropic token from setup-token output.\\n' >&2; exit 1
fi

printf '\\n==> Activating your Neutron workspace…\\n'
HTTP=$(curl -fsS -o /dev/null -w '%{http_code}' \\
  -X POST "$CALLBACK_URL" \\
  -H 'Content-Type: application/json' \\
  --data "{\\"signup_id\\":\\"$SIGNUP_ID\\",\\"token\\":\\"$TOKEN\\"}" || echo '000')

case "$HTTP" in
  200|204) printf '\\n✓ Done. Return to your browser — Neutron is restarting and will continue automatically.\\n' ;;
  410) printf '\\nERROR: this install link expired. Reload the page and run the new command.\\n' >&2; exit 1 ;;
  400|401|403) printf '\\nERROR: Anthropic rejected the token. Run the command again.\\n' >&2; exit 1 ;;
  *) printf '\\nERROR: activation failed (HTTP %s). Try again.\\n' "$HTTP" >&2; exit 1 ;;
esac
`
}

/**
 * Build the Open install-token route handler. Pure except for the injected
 * `persistToken` / `requestRestart` side effects, so the route logic is fully
 * unit-testable.
 */
export function buildOpenInstallTokenHandler(deps: OpenInstallTokenDeps): OpenInstallTokenHandler {
  const now = deps.now ?? Date.now
  const genSignupId = deps.genSignupId ?? randomUUID
  const store = new InstallTokenStore({ now, ...(deps.ttlMs !== undefined ? { ttlMs: deps.ttlMs } : {}) })
  // Restart is scheduled at most once per process (a retried callback must not
  // queue a second exit).
  let restartScheduled = false

  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url)
    const path = url.pathname
    if (!path.startsWith(ROUTE_PREFIX)) return null

    // POST /initiate — mint a signup_id + the one-liner for THIS origin.
    if (path === `${ROUTE_PREFIX}/initiate` && req.method === 'POST') {
      const signup_id = genSignupId()
      const row = store.create(signup_id)
      const scriptUrl = `${url.origin}${ROUTE_PREFIX}/${signup_id}.sh`
      return json({
        signup_id,
        command: `curl -fsSL ${scriptUrl} | bash`,
        script_url: scriptUrl,
        expires_at_ms: row.expires_at_ms,
      })
    }

    // GET /<signup_id>.sh — render the installer for a pending handoff.
    if (req.method === 'GET' && path.endsWith('.sh') && path.startsWith(`${ROUTE_PREFIX}/`)) {
      const signup_id = path.slice(`${ROUTE_PREFIX}/`.length, -'.sh'.length)
      if (!SIGNUP_ID_RE.test(signup_id)) return new Response('not found', { status: 404 })
      const row = store.get(signup_id)
      if (row === null) return new Response('# install link not found\n', { status: 404 })
      if (row.status !== 'pending') return new Response('# install link expired\n', { status: 410 })
      const script = renderInstallTokenScript({
        signup_id,
        callback_url: `${url.origin}${ROUTE_PREFIX}/complete`,
      })
      return new Response(script, {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      })
    }

    // POST /complete — validate, persist, mark done, request restart.
    if (path === `${ROUTE_PREFIX}/complete` && req.method === 'POST') {
      let parsed: { signup_id?: unknown; token?: unknown }
      try {
        parsed = (await req.json()) as { signup_id?: unknown; token?: unknown }
      } catch {
        return json({ error: 'invalid_json' }, 400)
      }
      const signup_id = typeof parsed.signup_id === 'string' ? parsed.signup_id : ''
      const token = typeof parsed.token === 'string' ? parsed.token : ''
      if (!SIGNUP_ID_RE.test(signup_id)) return json({ error: 'invalid_signup_id' }, 400)
      // Shape validation only — Open's substrate is the `claude` CLI, which
      // validates the token itself at spawn; the box never calls
      // api.anthropic.com directly, so a network probe would couple it to an
      // endpoint it otherwise never touches. (Managed's handler probes.)
      if (!SETUP_TOKEN_RE.test(token)) return json({ error: 'invalid_token' }, 400)

      const row = store.get(signup_id)
      if (row === null) return json({ error: 'not_found' }, 404)
      if (row.status === 'expired') return json({ error: 'expired' }, 410)
      if (row.status === 'completed') return json({ status: 'already_completed' }, 200)

      await deps.persistToken(token)
      const marked = store.markCompleted(signup_id)
      if (marked === null) {
        // Lost a race to a concurrent callback — the token is already persisted,
        // so this is success either way (idempotent).
        return json({ status: 'already_completed' }, 200)
      }
      if (!restartScheduled) {
        restartScheduled = true
        deps.requestRestart()
      }
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
    }

    // GET /state?signup_id= — poll status (nice messaging; the page's real
    // navigation trigger is the /chat 503→200 transition across the restart).
    if (path === `${ROUTE_PREFIX}/state` && req.method === 'GET') {
      const signup_id = url.searchParams.get('signup_id') ?? ''
      if (!SIGNUP_ID_RE.test(signup_id)) return json({ error: 'invalid_signup_id' }, 400)
      const row = store.get(signup_id)
      if (row === null) return json({ status: 'not_found' }, 404)
      return json({ status: row.status, expires_at_ms: row.expires_at_ms })
    }

    return null
  }

  return { handle, store }
}

/** Stable export for the gate page's CSP — sha256(inlineScript), base64. */
export function sha256Base64(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('base64')
}
