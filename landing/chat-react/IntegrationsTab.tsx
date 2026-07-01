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
 * Loading / error / empty states mirror the sibling `DocumentsTab`. No feature
 * flag — the tab is always live when present in the resolved tab set.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import type { BootstrapConfig } from './config.ts'
import {
  IntegrationsClient,
  type ApiKeyIntegration,
  type OAuthAccountIntegration,
} from './integrations-client.ts'

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

/** An archived project row the Admin tab lists with a Restore button
 *  (archived-projects sprint). Mirrors the server `ArchivedProjectItem`. */
interface ArchivedProject {
  id: string
  name: string
  emoji: string
  archived_at: string
}

function oauthSubtitle(acc: OAuthAccountIntegration): string {
  if (!acc.connected) return 'Not connected'
  if (acc.email !== null && acc.email.length > 0) return acc.email
  return 'Connected'
}

export function IntegrationsTab({
  config,
  fetchImpl,
}: {
  /** Present for API-shape parity with the other builtin tabs; unused (the
   *  integrations surface is per-instance, not per-project). */
  projectId?: string
  config: BootstrapConfig
  /** Injected in tests; defaults to the global fetch inside IntegrationsClient. */
  fetchImpl?: FetchImpl
}): React.JSX.Element {
  const client = useMemo(
    () =>
      new IntegrationsClient(
        fetchImpl !== undefined
          ? { base_url: config.origin, token: config.token, fetchImpl }
          : { base_url: config.origin, token: config.token },
      ),
    [config.origin, config.token, fetchImpl],
  )

  const [oauth, setOauth] = useState<OAuthAccountIntegration[]>([])
  const [apiKeys, setApiKeys] = useState<ApiKeyIntegration[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Per-slot draft input + in-flight / per-slot error state, keyed by label.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [rowError, setRowError] = useState<Record<string, string>>({})

  // ── archived projects (archived-projects sprint) ──
  const [archived, setArchived] = useState<ArchivedProject[]>([])
  const [archivedLoading, setArchivedLoading] = useState(true)
  const [archivedError, setArchivedError] = useState<string | null>(null)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const doFetch: FetchImpl = useMemo(
    () => fetchImpl ?? ((input, init) => fetch(input, init)),
    [fetchImpl],
  )

  const loadArchived = useCallback((): void => {
    setArchivedLoading(true)
    setArchivedError(null)
    void doFetch(`${config.origin}/api/app/projects/archived`, {
      method: 'GET',
      headers: { authorization: `Bearer ${config.token}` },
    })
      .then(async (res) => {
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
          // Drop it from the archived list; the rail picks it back up live off
          // the `projects_changed` frame the restore endpoint fans.
          setArchived((prev) => prev.filter((p) => p.id !== id))
          setRestoringId(null)
        })
        .catch((err: unknown) => {
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
        if (cancelled) return
        setOauth(res.oauth)
        setApiKeys(res.api_keys)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
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
          setBusy((m) => ({ ...m, [label]: false }))
          setDrafts((m) => ({ ...m, [label]: '' }))
          setApiKeys((keys) =>
            keys.map((k) => (k.label === label ? { ...k, connected: true } : k)),
          )
        })
        .catch((err: unknown) => {
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
          setBusy((m) => ({ ...m, [label]: false }))
          setDrafts((m) => ({ ...m, [label]: '' }))
          setApiKeys((keys) =>
            keys.map((k) => (k.label === label ? { ...k, connected: false } : k)),
          )
        })
        .catch((err: unknown) => {
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

        {loading ? (
          <div className="cdoc-empty">Loading…</div>
        ) : (
          <>
            {/* ── OAuth accounts ── */}
            <section className="cint-section" aria-label="Connected accounts">
              <h3 className="cint-section-title">Connected accounts</h3>
              {oauth.length === 0 ? (
                <div className="cdoc-empty">No OAuth accounts are configured.</div>
              ) : (
                <ul className="cint-list">
                  {oauth.map((acc) => (
                    <li key={acc.label} className="cint-row">
                      <div className="cint-row-main">
                        <span className="cint-row-label">{acc.label}</span>
                        <span className="cint-row-sub">{oauthSubtitle(acc)}</span>
                        {acc.scopes.length > 0 ? (
                          <span className="cint-row-scopes">{acc.scopes.join(', ')}</span>
                        ) : null}
                      </div>
                      <span
                        className={`cint-badge${acc.connected ? ' cint-badge-on' : ''}`}
                        aria-label={acc.connected ? 'Connected' : 'Not connected'}
                      >
                        {acc.connected ? 'Connected' : 'Not connected'}
                      </span>
                    </li>
                  ))}
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
