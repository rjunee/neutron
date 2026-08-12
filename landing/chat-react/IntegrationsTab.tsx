/**
 * landing/chat-react — web ADMIN / INTEGRATIONS tab content.
 *
 * The owner-facing surface for the global "Admin" tab: see which OAuth accounts
 * (Google) are connected and manage standalone BYO API-key slots. Renders as
 * the builtin `admin` tab inside `ProjectShell` (dispatched on
 * `mount.target === 'admin'`).
 *
 * ── Backed by an already-wired surface ─────────────────────────────────────
 * Reads `GET /api/cores/integrations` and mutates via
 * `POST/DELETE /api/cores/api-keys/<label>` through {@link IntegrationsClient}.
 * NO plaintext secret ever comes back from the GET — each slot only carries a
 * `connected` boolean, so the tab reflects connection state and lets the owner
 * paste a new value (write-only) or clear a stored one.
 *
 * ── Two different key stores, deliberately (ISSUES #486) ────────────────────
 * "API keys" above is the CORE-DECLARED slot list: a fixed set of
 * `byo_api_key` labels a Core's manifest asked for. "Shared credentials" below
 * is the free-form credential store (`project-credentials/`), where the owner
 * names the service themselves — and it is the ONE place the instance-wide
 * defaults are authored. A project's Settings tab shows them, labelled
 * inherited, but can no longer write them: a global write from inside one
 * project changed every project, which is the defect this section closes by
 * moving the authoring to the surface that is actually global-scoped.
 *
 * ── Google accounts are MANAGED here, not just displayed ────────────────────
 * The OAuth section used to be a viewer: a "Connected"/"Not connected" badge
 * and nothing to click, so the owner could not connect Google from the web at
 * all (the mobile client had the full flow). It now drives the same two routes
 * the mobile client uses:
 *
 *   - CONNECT does an AUTHENTICATED `GET /api/cores/oauth/google/start` through
 *     {@link IntegrationsClient} and then navigates to the returned
 *     `authorize_url`. It is NOT a link to `/start`: that route is bearer-gated
 *     and a browser navigation carries no Authorization header, so an `href`
 *     would 401. `authorize_url` is the public `accounts.google.com` consent
 *     URL and needs no credential.
 *   - DISCONNECT confirms, then `POST .../disconnect/<label>` with the row's
 *     FULL label, and reloads the list.
 *
 * ── GitHub is connected here too, and it is a DIFFERENT SHAPE (#551) ───────
 * Same defect, one service along: the whole GitHub device-flow backend was
 * merged and composed (`gateway/http/github-connect-surface.ts`), and no client
 * on any surface called it — so a codegen run that could not push said so, and
 * the only remedy anyone could name was a shell command on a machine the owner
 * may have no terminal on.
 *
 * The Google rows above drive an OAuth REDIRECT. GitHub is a DEVICE flow, so it
 * is NOT bolted onto that path: Connect POSTs to start, the short `user_code`
 * is displayed large with a one-press Copy and the `verification_uri` as a real
 * link, and the tab then POLLS the status route until it answers `connected`
 * and re-renders as connected. Typing that code into another device IS the
 * interaction — the owner is often reading it off a phone — so the code, not the
 * button, is the thing the layout is built around. The `device_code` is never
 * part of any of this; the surface does not return it.
 *
 * Rows are GROUPED BY SERVICE (see `integrations-oauth-view.ts`) because a
 * service can hold several accounts: the server returns one row per connected
 * account under a composite `<service>#<account_key>` label, so each account
 * gets its own Disconnect, and a service that already has one keeps an "Add
 * another account" action — otherwise the second and third Google account could
 * never be added. Connect always sends the bare SERVICE label; the composite
 * one is not manifest-declared and `/start` would reject it.
 *
 * Loading / error / empty states mirror the sibling `DocumentsTab`. No feature
 * flag — the tab is always live when present in the resolved tab set.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { BootstrapConfig } from './config.ts'
import {
  IntegrationsClient,
  type ApiKeyIntegration,
  type OAuthAccountIntegration,
} from './integrations-client.ts'
import {
  groupOAuthAccounts,
  oauthAccountStatus,
} from './integrations-oauth-view.ts'
import { WebCodexCredentialClient, type CodexStatus } from './codex-credential-client.ts'
import {
  WebGitHubConnectClient,
  type GitHubConnectState,
} from './github-connect-client.ts'
import { copyTextToClipboard } from './Markdown.tsx'
import { WebProjectCredentialsClient, type Rec } from './project-credentials-client.ts'
import { ThemeControl } from './ThemeToggle.tsx'

/** How often the tab re-reads the GitHub status while a device code is on screen.
 *  GitHub's own device-flow guidance is a 5s floor; shorter risks `slow_down`.
 *  Injected in tests, which cannot wait five seconds to watch a flow finish. */
const GITHUB_POLL_MS = 5_000

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

/** Hand the browser off to Google's consent page. Injected in tests so the
 *  hand-off is OBSERVABLE — a Connect that fetches `/start` and then fails to
 *  navigate is exactly the "built but never wired" defect this seam catches. */
type NavigateImpl = (url: string) => void

/** Destructive-action confirmation. Injected in tests (`window.confirm` is a
 *  blocking browser modal with no headless equivalent). */
type ConfirmImpl = (message: string) => boolean

/** An archived project row the Admin tab lists with a Restore button
 *  (archived-projects sprint). Mirrors the server `ArchivedProjectItem`. */
interface ArchivedProject {
  id: string
  name: string
  emoji: string
  archived_at: string
}

/** Busy/error map key for a service's connect (or add-another) action. */
function connectKey(service: string): string {
  return `connect:${service}`
}

/** Busy/error map key for one account's disconnect action. */
function disconnectKey(label: string): string {
  return `disconnect:${label}`
}

export function IntegrationsTab({
  config,
  fetchImpl,
  navigate,
  confirmImpl,
  githubPollMs,
}: {
  /** Present for API-shape parity with the other builtin tabs; unused (the
   *  integrations surface is per-instance, not per-project). */
  projectId?: string
  config: BootstrapConfig
  /** Injected in tests; defaults to the global fetch inside IntegrationsClient. */
  fetchImpl?: FetchImpl
  /** Injected in tests; defaults to a real top-level browser navigation. */
  navigate?: NavigateImpl
  /** How often to re-poll the GitHub device flow. Injected in tests so a flow
   *  can be watched through to `connected` without a five-second wait. */
  githubPollMs?: number
  /** Injected in tests; defaults to `window.confirm`. */
  confirmImpl?: ConfirmImpl
}): React.JSX.Element {
  // ── Unmount safety (#380 sweep) ─────────────────────────────────────────────
  // Mirrors the DocumentsTab fix: a fetch that SETTLES after this tab unmounts
  // (project switch / tab close) must not run its `.then`/`.catch` and setState
  // on a gone component. In a real concurrent-browser commit that
  // setState-after-unmount surfaces as React's teardown-phase invariant, which
  // bypasses every error boundary and blanks the WHOLE root (main.tsx now adds a
  // root-recovery net, but stopping the setState at the source is the real fix).
  // `mountedRef` bails every continuation once unmounted; `abortRef` cancels
  // in-flight READS (GET) on unmount — a write (POST/DELETE the user just fired)
  // is NEVER aborted so it still reaches the server, its continuation relying on
  // the `mountedRef` guard to skip setState-after-unmount.
  const mountedRef = useRef(true)
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    mountedRef.current = true
    abortRef.current = new AbortController()
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  // Thread the pane's abort signal into READS only (GET); unmount aborts them.
  const withSignal: FetchImpl = useMemo(() => {
    const base: FetchImpl = fetchImpl ?? ((input, init) => fetch(input, init))
    return (input, init) => {
      const ctrl = abortRef.current
      const isRead = (init?.method ?? 'GET') === 'GET'
      return base(input, ctrl !== null && isRead ? { ...init, signal: ctrl.signal } : init)
    }
  }, [fetchImpl])

  const client = useMemo(
    () => new IntegrationsClient({ base_url: config.origin, token: config.token, fetchImpl: withSignal }),
    [config.origin, config.token, withSignal],
  )

  const [oauth, setOauth] = useState<OAuthAccountIntegration[]>([])
  const [apiKeys, setApiKeys] = useState<ApiKeyIntegration[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // ── Codex cross-model review (GLOBAL, trident-wide credential) ──
  // The PRIMARY place to connect Codex: it's an account-wide credential the
  // trident reviewer uses across ANY project (not a per-project setting). A
  // per-project override lives in that project's Settings tab.
  const codexClient = useMemo(
    () => new WebCodexCredentialClient({ base_url: config.origin, token: config.token, fetchImpl: withSignal }),
    [config.origin, config.token, withSignal],
  )
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null)
  const [codexAuth, setCodexAuth] = useState('')
  const [codexBusy, setCodexBusy] = useState(false)
  const [codexError, setCodexError] = useState<string | null>(null)

  const loadCodex = useCallback((): void => {
    void codexClient
      .statusGlobal()
      .then((s) => {
        if (!mountedRef.current) return
        setCodexStatus(s)
      })
      .catch(() => {
        if (!mountedRef.current) return
        setCodexStatus({ status: 'not_connected' })
      })
  }, [codexClient])

  useEffect(() => loadCodex(), [loadCodex])

  const connectCodex = useCallback((): void => {
    if (codexAuth.trim().length === 0) return
    setCodexBusy(true)
    setCodexError(null)
    void codexClient
      .connectGlobal(codexAuth.trim())
      .then((s) => {
        if (!mountedRef.current) return
        setCodexStatus(s)
        setCodexAuth('')
        setCodexBusy(false)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        setCodexBusy(false)
        setCodexError(err instanceof Error ? err.message : 'failed to connect Codex')
      })
  }, [codexClient, codexAuth])

  const disconnectCodex = useCallback((): void => {
    setCodexBusy(true)
    setCodexError(null)
    void codexClient
      .disconnectGlobal()
      .then(() => {
        if (!mountedRef.current) return
        setCodexStatus({ status: 'not_connected' })
        setCodexBusy(false)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        setCodexBusy(false)
        setCodexError(err instanceof Error ? err.message : 'failed to disconnect Codex')
      })
  }, [codexClient])

  // ── GitHub (GLOBAL, device flow) ──────────────────────────────────────────
  // The credential every build needs to push a branch and open a pull request.
  // Not a redirect flow: the owner is shown a short code, types it at GitHub on
  // whatever device has a keyboard, and this tab polls until the token lands.
  const githubClient = useMemo(
    () =>
      new WebGitHubConnectClient({
        base_url: config.origin,
        token: config.token,
        fetchImpl: withSignal,
      }),
    [config.origin, config.token, withSignal],
  )
  const [github, setGithub] = useState<GitHubConnectState | null>(null)
  const [githubBusy, setGithubBusy] = useState(false)
  const [githubError, setGithubError] = useState<string | null>(null)
  const [githubCopied, setGithubCopied] = useState(false)
  const githubPoll = githubPollMs ?? GITHUB_POLL_MS

  const loadGitHub = useCallback((): void => {
    void githubClient
      .status()
      .then((s) => {
        if (!mountedRef.current) return
        setGithub(s)
      })
      .catch(() => {
        // An unreachable server is displayed as "not connected" and NOTHING is
        // written — the same rule the Codex row follows. It must never look like
        // a credential the owner has to supply again.
        if (!mountedRef.current) return
        setGithub({ status: 'not_connected' })
      })
  }, [githubClient])

  useEffect(() => loadGitHub(), [loadGitHub])

  /**
   * Poll while a code is on screen — the half that makes this a flow rather than
   * a wall of instructions. The owner approves on ANOTHER device, so nothing
   * about this tab changes when it succeeds unless it asks; without this the
   * connected state would arrive only on a manual Refresh, which reads as "I did
   * what you said and nothing happened".
   *
   * Keyed on the STATUS, not on the state object: each poll returns a fresh
   * `awaiting_owner` (its `expires_in_seconds` ticks down), and depending on the
   * object would tear down and re-arm the timer on every tick.
   */
  const githubStatus = github?.status ?? null
  useEffect(() => {
    if (githubStatus !== 'awaiting_owner') return
    const id = window.setInterval(() => {
      void githubClient
        .status()
        .then((s) => {
          if (!mountedRef.current) return
          setGithub(s)
        })
        .catch(() => {
          // A dropped poll is not a failed flow; keep the code on screen and try
          // again on the next tick.
        })
    }, githubPoll)
    return () => window.clearInterval(id)
  }, [githubStatus, githubClient, githubPoll])

  const connectGitHub = useCallback((): void => {
    if (githubBusy) return
    setGithubBusy(true)
    setGithubError(null)
    setGithubCopied(false)
    void githubClient
      .start()
      .then((s) => {
        if (!mountedRef.current) return
        setGithubBusy(false)
        setGithub(s)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        setGithubBusy(false)
        // The gateway's message is shown verbatim: "no client id is configured"
        // and "GitHub refused the request" need different things from the owner.
        setGithubError(err instanceof Error ? err.message : 'failed to start the GitHub connect flow')
      })
  }, [githubClient, githubBusy])

  const copyGitHubCode = useCallback((code: string): void => {
    void copyTextToClipboard(code).then((ok) => {
      if (!ok || !mountedRef.current) return
      setGithubCopied(true)
      window.setTimeout(() => {
        if (mountedRef.current) setGithubCopied(false)
      }, 1500)
    })
  }, [])

  // ── Shared credentials (GLOBAL scope — the instance-wide defaults) ──
  // The ONLY authoring surface for them: a project's Settings tab reads them
  // and says so, but writes only its own (ISSUES #486).
  const credsClient = useMemo(
    () =>
      new WebProjectCredentialsClient({
        base_url: config.origin,
        token: config.token,
        fetchImpl: withSignal,
      }),
    [config.origin, config.token, withSignal],
  )
  const [globalCreds, setGlobalCreds] = useState<Rec[]>([])
  const [credsLoading, setCredsLoading] = useState(true)
  const [credsError, setCredsError] = useState<string | null>(null)
  const [credService, setCredService] = useState('')
  const [credToken, setCredToken] = useState('')
  const [credLabel, setCredLabel] = useState('')
  const [credSaving, setCredSaving] = useState(false)
  const [credBusyService, setCredBusyService] = useState<string | null>(null)

  const loadGlobalCreds = useCallback((): void => {
    setCredsLoading(true)
    setCredsError(null)
    void credsClient
      .listGlobal()
      .then((rows) => {
        if (!mountedRef.current) return
        setGlobalCreds(rows)
        setCredsLoading(false)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        setGlobalCreds([])
        setCredsLoading(false)
        setCredsError(err instanceof Error ? err.message : 'failed to load shared credentials')
      })
  }, [credsClient])

  useEffect(() => loadGlobalCreds(), [loadGlobalCreds])

  const addGlobalCred = useCallback((): void => {
    const svc = credService.trim()
    const tok = credToken
    if (svc.length === 0 || tok.length === 0 || credSaving) return
    setCredSaving(true)
    setCredsError(null)
    const lbl = credLabel.trim()
    void credsClient
      .setGlobal({ service: svc, token: tok, ...(lbl.length > 0 ? { label: lbl } : {}) })
      .then(() => {
        if (!mountedRef.current) return
        setCredSaving(false)
        setCredService('')
        setCredToken('')
        setCredLabel('')
        loadGlobalCreds()
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        setCredSaving(false)
        setCredsError(err instanceof Error ? err.message : 'failed to save credential')
      })
  }, [credsClient, credService, credToken, credLabel, credSaving, loadGlobalCreds])

  const removeGlobalCred = useCallback(
    (service: string): void => {
      if (credBusyService !== null) return
      setCredBusyService(service)
      setCredsError(null)
      void credsClient
        .removeGlobal(service)
        .then(() => {
          if (!mountedRef.current) return
          setCredBusyService(null)
          loadGlobalCreds()
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return
          setCredBusyService(null)
          setCredsError(err instanceof Error ? err.message : 'failed to delete credential')
        })
    },
    [credsClient, credBusyService, loadGlobalCreds],
  )

  // Per-slot draft input + in-flight / per-slot error state, keyed by label.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [rowError, setRowError] = useState<Record<string, string>>({})

  // ── Google account connect / disconnect ──
  // Kept in their OWN maps (not the api-key `busy`/`rowError` ones) so a service
  // label can never collide with an api-key slot label, and namespaced by action
  // so one account's disconnect spinner is independent of its service's connect.
  const [oauthBusy, setOauthBusy] = useState<Record<string, boolean>>({})
  const [oauthError, setOauthError] = useState<Record<string, string>>({})

  // ── archived projects (archived-projects sprint) ──
  const [archived, setArchived] = useState<ArchivedProject[]>([])
  const [archivedLoading, setArchivedLoading] = useState(true)
  const [archivedError, setArchivedError] = useState<string | null>(null)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  // The archived list GET / restore POST go through the same abort-threading
  // wrapper so the GET is cancelled on unmount (restore is a POST — never aborted).
  const doFetch: FetchImpl = withSignal

  const loadArchived = useCallback((): void => {
    setArchivedLoading(true)
    setArchivedError(null)
    void doFetch(`${config.origin}/api/app/projects/archived`, {
      method: 'GET',
      headers: { authorization: `Bearer ${config.token}` },
    })
      .then(async (res) => {
        if (!mountedRef.current) return
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json().catch(() => null)) as { archived?: unknown } | null
        const list = Array.isArray(data?.archived) ? data.archived : []
        setArchived(
          list.filter(
            (p): p is ArchivedProject =>
              typeof p === 'object' &&
              p !== null &&
              typeof (p as ArchivedProject).id === 'string' &&
              typeof (p as ArchivedProject).name === 'string',
          ),
        )
        setArchivedLoading(false)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        setArchived([])
        setArchivedLoading(false)
        setArchivedError(err instanceof Error ? err.message : 'failed to load archived projects')
      })
  }, [doFetch, config.origin, config.token])

  useEffect(() => loadArchived(), [loadArchived])

  const restoreProject = useCallback(
    (id: string): void => {
      if (restoringId !== null) return
      setRestoringId(id)
      setArchivedError(null)
      void doFetch(`${config.origin}/api/app/projects/${encodeURIComponent(id)}/restore`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.token}` },
      })
        .then(async (res) => {
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { message?: string } | null
            throw new Error(body?.message ?? `HTTP ${res.status}`)
          }
          if (!mountedRef.current) return
          // Drop it from the archived list; the rail picks it back up live off
          // the `projects_changed` frame the restore endpoint fans.
          setArchived((prev) => prev.filter((p) => p.id !== id))
          setRestoringId(null)
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return
          setRestoringId(null)
          setArchivedError(err instanceof Error ? err.message : 'failed to restore project')
        })
    },
    [doFetch, config.origin, config.token, restoringId],
  )

  const load = useCallback((): (() => void) => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void client
      .getStatus()
      .then((res) => {
        if (cancelled || !mountedRef.current) return
        setOauth(res.oauth)
        setApiKeys(res.api_keys)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled || !mountedRef.current) return
        setOauth([])
        setApiKeys([])
        setLoading(false)
        setError(err instanceof Error ? err.message : 'failed to load integrations')
      })
    return () => {
      cancelled = true
    }
  }, [client])

  useEffect(() => load(), [load])

  const oauthGroups = useMemo(() => groupOAuthAccounts(oauth), [oauth])

  const doNavigate: NavigateImpl = useMemo(
    () => navigate ?? ((url: string): void => { window.location.assign(url) }),
    [navigate],
  )
  const doConfirm: ConfirmImpl = useMemo(
    () => confirmImpl ?? ((message: string): boolean => window.confirm(message)),
    [confirmImpl],
  )

  /**
   * Start a grant for a SERVICE and hand the browser to Google.
   *
   * Two-step ON PURPOSE: `/start` is bearer-gated, so the authenticated fetch
   * has to happen here and only the `authorize_url` it returns — the public
   * Google consent page — is safe to navigate to. Rendering `/start` as a link
   * would 401. Used by BOTH the first Connect and "Add another account": the
   * service label is what `/start` accepts either way, and Google's
   * `prompt=consent` lets the owner pick a different account on the re-grant.
   */
  const connectOAuth = useCallback(
    (service: string): void => {
      const key = connectKey(service)
      setOauthBusy((m) => ({ ...m, [key]: true }))
      setOauthError((m) => ({ ...m, [key]: '' }))
      void client
        .oauthStart([service])
        .then((res) => {
          if (!mountedRef.current) return
          setOauthBusy((m) => ({ ...m, [key]: false }))
          if (!res.ok || typeof res.authorize_url !== 'string' || res.authorize_url.length === 0) {
            setOauthError((m) => ({
              ...m,
              [key]: 'could not start the Google consent flow — try again',
            }))
            return
          }
          doNavigate(res.authorize_url)
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return
          setOauthBusy((m) => ({ ...m, [key]: false }))
          setOauthError((m) => ({
            ...m,
            [key]: err instanceof Error ? err.message : 'failed to start the connect flow',
          }))
        })
    },
    [client, doNavigate],
  )

  /**
   * Revoke ONE account. `label` is the row's full (possibly composite) label,
   * so a service holding three accounts drops exactly the one asked for. On
   * success the whole list reloads — the account row disappears and, when it
   * was the last one, the service falls back to its not-connected placeholder.
   */
  const disconnectOAuth = useCallback(
    (label: string, title: string): void => {
      if (!doConfirm(`Disconnect ${title}? Tools that depend on it stop working until you reconnect.`)) {
        return
      }
      const key = disconnectKey(label)
      setOauthBusy((m) => ({ ...m, [key]: true }))
      setOauthError((m) => ({ ...m, [key]: '' }))
      void client
        .oauthDisconnect(label)
        .then(() => {
          if (!mountedRef.current) return
          setOauthBusy((m) => ({ ...m, [key]: false }))
          load()
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return
          setOauthBusy((m) => ({ ...m, [key]: false }))
          setOauthError((m) => ({
            ...m,
            [key]: err instanceof Error ? err.message : 'failed to disconnect',
          }))
        })
    },
    [client, doConfirm, load],
  )

  const saveKey = useCallback(
    (label: string): void => {
      const value = (drafts[label] ?? '').trim()
      if (value.length === 0) {
        setRowError((m) => ({ ...m, [label]: 'Enter a key value first.' }))
        return
      }
      setBusy((m) => ({ ...m, [label]: true }))
      setRowError((m) => ({ ...m, [label]: '' }))
      void client
        .setApiKey(label, value)
        .then(() => {
          if (!mountedRef.current) return
          setBusy((m) => ({ ...m, [label]: false }))
          setDrafts((m) => ({ ...m, [label]: '' }))
          setApiKeys((keys) =>
            keys.map((k) => (k.label === label ? { ...k, connected: true } : k)),
          )
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return
          setBusy((m) => ({ ...m, [label]: false }))
          setRowError((m) => ({
            ...m,
            [label]: err instanceof Error ? err.message : 'failed to save key',
          }))
        })
    },
    [client, drafts],
  )

  const clearKey = useCallback(
    (label: string): void => {
      setBusy((m) => ({ ...m, [label]: true }))
      setRowError((m) => ({ ...m, [label]: '' }))
      void client
        .deleteApiKey(label)
        .then(() => {
          if (!mountedRef.current) return
          setBusy((m) => ({ ...m, [label]: false }))
          setDrafts((m) => ({ ...m, [label]: '' }))
          setApiKeys((keys) =>
            keys.map((k) => (k.label === label ? { ...k, connected: false } : k)),
          )
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return
          setBusy((m) => ({ ...m, [label]: false }))
          setRowError((m) => ({
            ...m,
            [label]: err instanceof Error ? err.message : 'failed to clear key',
          }))
        })
    },
    [client],
  )

  return (
    <div className="cint" aria-label="Integrations">
      <div className="cint-scroll">
        <header className="cint-head">
          <div className="cint-title">Integrations</div>
          <button type="button" className="cdoc-btn" disabled={loading} onClick={() => load()}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </header>

        {error !== null ? <div className="cdoc-comments-error">{error}</div> : null}

        {/* ── Appearance (FIX #350) ── the light/dark control lives here now
            (moved out of the tab bar, deduped across viewports). Independent of
            the integrations fetch, so it's always available. */}
        <section className="cint-section" aria-label="Appearance">
          <h3 className="cint-section-title">Appearance</h3>
          <div className="cint-row">
            <div className="cint-row-main">
              <span className="cint-row-label">Theme</span>
              <span className="cint-row-sub">Light, dark, or follow your system setting.</span>
            </div>
            <ThemeControl />
          </div>
        </section>

        {/* ── GitHub (#551) ── OUTSIDE the integrations fetch on purpose. This is
            the credential a blocked build is waiting on, and it must not be
            hidden behind an unrelated `/api/cores/integrations` round trip —
            "the owner can reach it" is the whole point of this section. */}
        <section
          className="cint-section"
          aria-label="GitHub"
          data-github-status={github?.status ?? 'loading'}
        >
          <h3 className="cint-section-title">GitHub</h3>
          <p className="cint-row-sub cint-row-wrap">
            Lets a build <strong>push a branch and open a pull request</strong> as you. Without
            it, code generation runs and then has nowhere to put the result.
          </p>

          {githubError !== null ? <div className="cdoc-comments-error">{githubError}</div> : null}

          {github === null ? (
            <div className="cdoc-empty">Checking…</div>
          ) : github.status === 'connected' ? (
            <div className="cint-row">
              <div className="cint-row-main">
                <span className="cint-row-label">GitHub</span>
                <span className="cint-row-sub">Builds can push and open pull requests.</span>
              </div>
              <span className="cint-badge cint-badge-on" aria-label="Connected">
                Connected
              </span>
            </div>
          ) : github.status === 'awaiting_owner' ? (
            /* THE CODE IS THE INTERACTION, so it is the biggest thing here.
               Copy first (one press, then paste), the link second, and the tab
               keeps polling so the owner never has to come back and refresh. */
            <div className="cint-device">
              <div className="cint-device-code" aria-label="Your GitHub device code">
                {github.user_code}
              </div>
              <div className="cint-key-actions">
                <button
                  type="button"
                  className="cdoc-btn cdoc-btn-primary cint-github-copy"
                  aria-label={githubCopied ? 'Code copied' : 'Copy code'}
                  onClick={() => copyGitHubCode(github.user_code)}
                >
                  {githubCopied ? 'Copied' : 'Copy code'}
                </button>
                <a
                  className="cdoc-btn cint-github-open"
                  href={github.verification_uri}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Open GitHub
                </a>
              </div>
              <p className="cint-row-sub cint-row-wrap">
                Enter this code at <code>{github.verification_uri}</code> — on this device or any
                other. This page finishes on its own once you approve; nothing else to do here.
              </p>
            </div>
          ) : (
            <div className="cint-row">
              <div className="cint-row-main">
                <span className="cint-row-label">GitHub</span>
                <span className="cint-row-sub">
                  Not connected — builds cannot push or open pull requests.
                </span>
              </div>
              <button
                type="button"
                className="cdoc-btn cdoc-btn-primary cint-github-connect"
                aria-label="Connect GitHub"
                disabled={githubBusy}
                onClick={connectGitHub}
              >
                {githubBusy ? 'Starting…' : 'Connect GitHub'}
              </button>
            </div>
          )}
        </section>

        {loading ? (
          <div className="cdoc-empty">Loading…</div>
        ) : (
          <>
            {/* ── OAuth accounts ── one block per SERVICE, one row per account. */}
            <section className="cint-section" aria-label="Connected accounts">
              <h3 className="cint-section-title">Connected accounts</h3>
              {oauthGroups.length === 0 ? (
                <div className="cdoc-empty">No OAuth accounts are configured.</div>
              ) : (
                <ul className="cint-list">
                  {oauthGroups.map((group) => {
                    const cKey = connectKey(group.service)
                    const connectBusy = oauthBusy[cKey] === true
                    const connectErr = oauthError[cKey]
                    return (
                      <li key={group.service} className="cint-row cint-row-oauth">
                        <div className="cint-row-main">
                          <span className="cint-row-label">{group.title}</span>
                          {group.coreSlugs.length > 0 ? (
                            <span className="cint-row-scopes">
                              Used by {group.coreSlugs.join(', ')}
                            </span>
                          ) : null}
                        </div>

                        <ul className="cint-account-list">
                          {group.accounts.map((acc) => {
                            const dKey = disconnectKey(acc.label)
                            const discBusy = oauthBusy[dKey] === true
                            const discErr = oauthError[dKey]
                            return (
                              <li
                                key={acc.label}
                                className="cint-account"
                                data-oauth-label={acc.label}
                              >
                                <div className="cint-row-main">
                                  <span className="cint-row-sub">{oauthAccountStatus(acc)}</span>
                                  {acc.scopes.length > 0 ? (
                                    <span className="cint-row-scopes">
                                      {acc.scopes.join(', ')}
                                    </span>
                                  ) : null}
                                </div>
                                <span
                                  className={`cint-badge${acc.connected ? ' cint-badge-on' : ''}`}
                                  aria-label={acc.connected ? 'Connected' : 'Not connected'}
                                >
                                  {acc.connected ? 'Connected' : 'Not connected'}
                                </span>
                                {acc.connected ? (
                                  <button
                                    type="button"
                                    className="cdoc-btn"
                                    aria-label={`Disconnect ${group.title}${
                                      acc.email !== null && acc.email.length > 0
                                        ? ` (${acc.email})`
                                        : ''
                                    }`}
                                    disabled={discBusy}
                                    onClick={() => disconnectOAuth(acc.label, group.title)}
                                  >
                                    {discBusy ? 'Disconnecting…' : 'Disconnect'}
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="cdoc-btn cdoc-btn-primary"
                                    aria-label={`Connect ${group.title}`}
                                    disabled={connectBusy}
                                    onClick={() => connectOAuth(group.service)}
                                  >
                                    {connectBusy ? 'Connecting…' : 'Connect'}
                                  </button>
                                )}
                                {discErr !== undefined && discErr.length > 0 ? (
                                  <div className="cdoc-comments-error">{discErr}</div>
                                ) : null}
                              </li>
                            )
                          })}
                        </ul>

                        {/* A service with accounts still needs a way to add the
                            NEXT one — the owner runs several Google accounts. */}
                        {group.connectedCount > 0 ? (
                          <div className="cint-key-actions">
                            <button
                              type="button"
                              className="cdoc-btn"
                              aria-label={`Add another ${group.title} account`}
                              disabled={connectBusy}
                              onClick={() => connectOAuth(group.service)}
                            >
                              {connectBusy ? 'Connecting…' : 'Add another account'}
                            </button>
                          </div>
                        ) : null}
                        {connectErr !== undefined && connectErr.length > 0 ? (
                          <div className="cdoc-comments-error">{connectErr}</div>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            {/* ── API keys ── */}
            <section className="cint-section" aria-label="API keys">
              <h3 className="cint-section-title">API keys</h3>
              {apiKeys.length === 0 ? (
                <div className="cdoc-empty">No API-key integrations are configured.</div>
              ) : (
                <ul className="cint-list">
                  {apiKeys.map((k) => {
                    const isBusy = busy[k.label] === true
                    const err = rowError[k.label]
                    return (
                      <li key={k.label} className="cint-row cint-row-key">
                        <div className="cint-row-main">
                          <span className="cint-row-label">
                            {k.name}
                            {k.required ? <span className="cint-required"> required</span> : null}
                          </span>
                          <span
                            className={`cint-badge${k.connected ? ' cint-badge-on' : ''}`}
                            aria-label={k.connected ? 'Key stored' : 'No key stored'}
                          >
                            {k.connected ? 'Stored' : 'Not set'}
                          </span>
                          {k.install_prompt.length > 0 ? (
                            <span className="cint-row-sub">{k.install_prompt}</span>
                          ) : null}
                        </div>
                        <div className="cint-key-actions">
                          <input
                            type="password"
                            className="cint-key-input"
                            aria-label={`${k.name} key`}
                            placeholder={k.connected ? 'Enter a new key to rotate…' : 'Paste key…'}
                            value={drafts[k.label] ?? ''}
                            disabled={isBusy}
                            onChange={(e) =>
                              setDrafts((m) => ({ ...m, [k.label]: e.target.value }))
                            }
                          />
                          <button
                            type="button"
                            className="cdoc-btn cdoc-btn-primary"
                            disabled={isBusy || (drafts[k.label] ?? '').trim().length === 0}
                            onClick={() => saveKey(k.label)}
                          >
                            {isBusy ? 'Saving…' : 'Save'}
                          </button>
                          <button
                            type="button"
                            className="cdoc-btn"
                            disabled={isBusy || !k.connected}
                            onClick={() => clearKey(k.label)}
                          >
                            Clear
                          </button>
                        </div>
                        {err !== undefined && err.length > 0 ? (
                          <div className="cdoc-comments-error">{err}</div>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            {/* ── Shared credentials (GLOBAL scope) ──────────────────────────
                The instance-wide defaults every project inherits, authored HERE
                and nowhere else. A project's Settings tab lists them read-only
                and points back at this section (ISSUES #486). */}
            <section className="cint-section" aria-label="Shared credentials">
              <h3 className="cint-section-title">Shared credentials</h3>
              <p className="cint-row-sub">
                API keys and tokens <strong>every</strong> project can use. A project that
                stores its own key for the same service uses that one instead. The value is
                encrypted on your server and never shown again after you save it.
              </p>

              {credsError !== null ? (
                <div className="cdoc-comments-error">{credsError}</div>
              ) : null}

              {credsLoading ? (
                <div className="cdoc-empty">Loading…</div>
              ) : globalCreds.length === 0 ? (
                <div className="cdoc-empty">No shared credentials yet.</div>
              ) : (
                <ul className="cint-list" aria-label="Shared credentials">
                  {globalCreds.map((rec) => (
                    <li key={rec.service} className="cint-row cint-row-key" data-cred-service={rec.service}>
                      <div className="cint-row-main">
                        <span className="cint-row-label">{rec.service}</span>
                        {rec.label !== null && rec.label.length > 0 ? (
                          <span className="cint-row-sub">{rec.label}</span>
                        ) : null}
                      </div>
                      <div className="cint-key-actions">
                        <button
                          type="button"
                          className="cdoc-btn"
                          aria-label={`Remove shared ${rec.service} credential`}
                          disabled={credBusyService === rec.service}
                          onClick={() => removeGlobalCred(rec.service)}
                        >
                          {credBusyService === rec.service ? 'Removing…' : 'Remove'}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <form
                className="cset-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  addGlobalCred()
                }}
              >
                <div className="cint-key-actions">
                  <input
                    className="cint-key-input"
                    aria-label="Service"
                    placeholder="Service — e.g. openai, github"
                    value={credService}
                    disabled={credSaving}
                    onChange={(e) => setCredService(e.target.value)}
                  />
                  <input
                    type="password"
                    className="cint-key-input"
                    aria-label="Shared credential value"
                    autoComplete="off"
                    placeholder="Paste the secret…"
                    value={credToken}
                    disabled={credSaving}
                    onChange={(e) => setCredToken(e.target.value)}
                  />
                  <input
                    className="cint-key-input"
                    aria-label="Label (optional)"
                    placeholder="Label (optional)"
                    value={credLabel}
                    disabled={credSaving}
                    onChange={(e) => setCredLabel(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="cdoc-btn cdoc-btn-primary"
                    disabled={
                      credSaving || credService.trim().length === 0 || credToken.length === 0
                    }
                  >
                    {credSaving ? 'Saving…' : 'Add shared credential'}
                  </button>
                </div>
              </form>
            </section>

            {/* ── Codex cross-model review (GLOBAL, trident-wide) ── */}
            <section className="cint-section" aria-label="Codex cross-model review">
              <h3 className="cint-section-title">Codex cross-model review</h3>
              <p className="cint-row-sub">
                Connect a ChatGPT <strong>subscription</strong> so trident builds get an independent
                GPT-5 (Codex) review alongside Claude, across <strong>every</strong> project. This is
                an account-wide credential. Run <code>codex login</code> on your machine, then paste
                the contents of <code>~/.codex/auth.json</code> below. A metered
                <code> OPENAI_API_KEY</code> is rejected — subscription only. (Need a different
                subscription for one project? Set a per-project override in that project’s Settings.)
              </p>
              <p className="cset-codex-status" data-status={codexStatus?.status ?? 'not_connected'}>
                {codexStatus?.status === 'connected'
                  ? '✓ Connected'
                  : codexStatus?.status === 'expired'
                    ? '⚠ Token expired — re-connect'
                    : '○ Not connected'}
                {codexStatus?.detail !== undefined ? ` — ${codexStatus.detail}` : ''}
              </p>
              {codexError !== null ? <div className="cdoc-comments-error">{codexError}</div> : null}
              {codexStatus?.status === 'connected' || codexStatus?.status === 'expired' ? (
                <div className="cint-key-actions">
                  <button type="button" className="cdoc-btn" disabled={codexBusy} onClick={disconnectCodex}>
                    {codexBusy ? 'Working…' : 'Disconnect Codex'}
                  </button>
                </div>
              ) : null}
              <form
                className="cset-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  connectCodex()
                }}
              >
                <label className="cint-row-label" htmlFor="cint-codex-auth">
                  Paste ~/.codex/auth.json
                </label>
                <textarea
                  id="cint-codex-auth"
                  className="cint-key-input cset-codex-textarea"
                  rows={4}
                  placeholder='{ "tokens": { "access_token": "…", "refresh_token": "…" }, "last_refresh": "…" }'
                  value={codexAuth}
                  onChange={(e) => setCodexAuth(e.target.value)}
                />
                <div className="cint-key-actions">
                  <button
                    type="submit"
                    className="cdoc-btn cdoc-btn-primary"
                    disabled={codexBusy || codexAuth.trim().length === 0}
                  >
                    {codexBusy ? 'Connecting…' : 'Connect Codex'}
                  </button>
                </div>
              </form>
            </section>

            {/* ── Archived projects ── */}
            <section className="cint-section" aria-label="Archived projects">
              <h3 className="cint-section-title">Archived projects</h3>
              {archivedError !== null ? (
                <div className="cdoc-comments-error">{archivedError}</div>
              ) : null}
              {archivedLoading ? (
                <div className="cdoc-empty">Loading…</div>
              ) : archived.length === 0 ? (
                <div className="cdoc-empty">No archived projects.</div>
              ) : (
                <ul className="cint-list" aria-label="Archived projects">
                  {archived.map((p) => {
                    const isBusy = restoringId === p.id
                    return (
                      <li key={p.id} className="cint-row cint-row-archived">
                        <div className="cint-row-main">
                          <span className="cint-row-label">
                            {p.emoji.length > 0 ? `${p.emoji} ` : ''}
                            {p.name}
                          </span>
                          {p.archived_at.length > 0 ? (
                            <span className="cint-row-sub">Archived {p.archived_at.slice(0, 10)}</span>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          className="cdoc-btn cdoc-btn-primary"
                          disabled={isBusy}
                          onClick={() => restoreProject(p.id)}
                        >
                          {isBusy ? 'Restoring…' : 'Restore'}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
