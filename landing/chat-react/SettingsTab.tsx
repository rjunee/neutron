/**
 * landing/chat-react — web SETTINGS tab content (per-project settings).
 *
 * The owner-facing per-project settings surface: manage the project's stored
 * credentials (API keys / tokens the agent's tools use), rename the project, and
 * see who's on it. Renders as the builtin `settings` tab inside `ProjectShell`,
 * the sibling of `DocumentsTab` / `WorkBoardTab`.
 *
 * Three sections:
 *
 *   1. Credentials — this project's credentials + the global (inherited)
 *      defaults, an add form, and a per-row delete. The API returns METADATA
 *      only (never the secret), so we render "a key exists for <service>", never
 *      a token value.
 *   2. Project — the project name (rename via the settings PATCH). The emoji
 *      control is a SEAM: there's no emoji column yet, so it renders DISABLED
 *      with a note that it ships with the rail emoji work — no invented backend.
 *   3. Collaborators — DISPLAY-ONLY + M2-gated: the owner row + a disabled
 *      Invite/Remove affordance. NO write calls (sharing lands in M2).
 *
 * Auth + base URL mirror the sibling tabs: the app-ws bearer token
 * (`config.token`) + the page origin (`config.origin`). Credential I/O goes
 * through `WebProjectCredentialsClient`; the rename hits the project-settings
 * PATCH directly (a single field, no dedicated client).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { BootstrapConfig } from './config.ts'
import {
  WebProjectCredentialsClient,
  type CredentialScope,
  type Rec,
} from './project-credentials-client.ts'
import { WebCodexCredentialClient, type CodexStatus } from './codex-credential-client.ts'

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

/** The owner/member rows the settings GET returns (subset we render). */
interface ProjectMemberView {
  user_id: string
  name: string
  role: 'owner' | 'member'
}

export function SettingsTab({
  projectId,
  config,
  fetchImpl,
}: {
  projectId: string
  config: BootstrapConfig
  /** Injected in tests; defaults to the global fetch inside the clients. */
  fetchImpl?: FetchImpl
}): React.JSX.Element {
  // ── Unmount safety (#380 sweep) ─────────────────────────────────────────────
  // A credential/settings/codex fetch that SETTLES after this tab unmounts
  // (project switch / tab close) must not run its continuation + setState on a
  // gone component — in a real browser commit that setState-after-unmount is the
  // teardown-phase fiber invariant that bypasses every error boundary and blanks
  // the whole root (main.tsx now adds a root-recovery net; this stops it at the
  // source). `mountedRef` bails every continuation once unmounted; `abortRef`
  // cancels in-flight READS (GET) on unmount — a write (PATCH/POST/DELETE the
  // user just fired) is NEVER aborted so it still reaches the server.
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
    () => new WebProjectCredentialsClient({ base_url: config.origin, token: config.token, fetchImpl: withSignal }),
    [config.origin, config.token, withSignal],
  )

  // Raw fetch for the project-settings GET/PATCH (a single `name` field — no
  // dedicated client). Shares the abort-threading wrapper (GET aborted on
  // unmount; the PATCH is a write — never aborted).
  const doFetch: FetchImpl = withSignal

  // Codex connect client (Part B — trident cross-model reviewer credential).
  const codexClient = useMemo(
    () => new WebCodexCredentialClient({ base_url: config.origin, token: config.token, fetchImpl: withSignal }),
    [config.origin, config.token, withSignal],
  )

  // ── credentials ──
  const [projectCreds, setProjectCreds] = useState<Rec[]>([])
  const [globalCreds, setGlobalCreds] = useState<Rec[]>([])
  const [credsLoading, setCredsLoading] = useState(true)
  const [credsError, setCredsError] = useState<string | null>(null)

  // Add-credential form.
  const [service, setService] = useState('')
  const [token, setToken] = useState('')
  const [scope, setScope] = useState<CredentialScope>('project')
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)

  // Per-row delete guard so a double-click can't fire two deletes.
  const [busyKey, setBusyKey] = useState<string | null>(null)

  // ── codex connect (Part B) ──
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null)
  const [codexAuth, setCodexAuth] = useState('')
  const [codexBusy, setCodexBusy] = useState(false)
  const [codexError, setCodexError] = useState<string | null>(null)

  const loadCodex = useCallback((): void => {
    void codexClient
      .status(projectId)
      .then((s) => {
        if (!mountedRef.current) return
        setCodexStatus(s)
      })
      .catch(() => {
        if (!mountedRef.current) return
        setCodexStatus({ status: 'not_connected' })
      })
  }, [codexClient, projectId])

  const connectCodex = useCallback((): void => {
    if (codexAuth.trim().length === 0) return
    setCodexBusy(true)
    setCodexError(null)
    void codexClient
      .connect(projectId, codexAuth.trim())
      // The POST reply carries {status, mode, scope} but NOT `override_present`
      // (which gates "Remove override"), so re-fetch the effective status after
      // saving so the remove affordance appears immediately, no reload needed.
      .then(() => codexClient.status(projectId))
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
  }, [codexClient, projectId, codexAuth])

  const disconnectCodex = useCallback((): void => {
    setCodexBusy(true)
    setCodexError(null)
    void codexClient
      .disconnect(projectId)
      // Removing a project override must reflect the EFFECTIVE status, not a hard
      // `not_connected`: if a global default exists the project falls back to it
      // (connected, scope=global). Re-fetch rather than assume.
      .then(() => codexClient.status(projectId))
      .then((s) => {
        if (!mountedRef.current) return
        setCodexStatus(s)
        setCodexBusy(false)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        setCodexBusy(false)
        setCodexError(err instanceof Error ? err.message : 'failed to disconnect Codex')
      })
  }, [codexClient, projectId])

  // ── project name ──
  const [name, setName] = useState('')
  const [nameLoaded, setNameLoaded] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)

  // ── project emoji (rail-redesign) ──
  const [emoji, setEmoji] = useState('')
  const [emojiDraft, setEmojiDraft] = useState('')
  const [savingEmoji, setSavingEmoji] = useState(false)
  const [emojiError, setEmojiError] = useState<string | null>(null)

  // ── archive (archived-projects sprint) ──
  const [confirmingArchive, setConfirmingArchive] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [archived, setArchived] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)

  // ── collaborators (display-only) ──
  const [members, setMembers] = useState<ProjectMemberView[]>([])

  const loadCreds = useCallback((): void => {
    setCredsLoading(true)
    setCredsError(null)
    void client
      .list(projectId)
      .then((list) => {
        if (!mountedRef.current) return
        setProjectCreds(list.project)
        setGlobalCreds(list.global)
        setCredsLoading(false)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        setProjectCreds([])
        setGlobalCreds([])
        setCredsLoading(false)
        setCredsError(err instanceof Error ? err.message : 'failed to load credentials')
      })
  }, [client, projectId])

  const loadSettings = useCallback((): void => {
    setNameLoaded(false)
    void doFetch(`${config.origin}/api/app/projects/${encodeURIComponent(projectId)}/settings`, {
      method: 'GET',
      headers: { authorization: `Bearer ${config.token}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (!mountedRef.current) return
        const project = (data as { project?: { name?: unknown; emoji?: unknown; members?: unknown } } | null)
          ?.project
        const pName = typeof project?.name === 'string' ? project.name : ''
        setName(pName)
        setNameDraft(pName)
        const pEmoji = typeof project?.emoji === 'string' ? project.emoji : ''
        setEmoji(pEmoji)
        setEmojiDraft(pEmoji)
        const rawMembers = Array.isArray(project?.members) ? project.members : []
        setMembers(
          rawMembers.filter(
            (m): m is ProjectMemberView =>
              typeof m === 'object' &&
              m !== null &&
              typeof (m as ProjectMemberView).name === 'string' &&
              ((m as ProjectMemberView).role === 'owner' || (m as ProjectMemberView).role === 'member'),
          ),
        )
        setNameLoaded(true)
      })
      .catch(() => {
        if (!mountedRef.current) return
        // Leave the name blank + fall back to the owner placeholder; the rename
        // input still works (the PATCH is the source of truth).
        setNameLoaded(true)
      })
  }, [doFetch, config.origin, config.token, projectId])

  // Reset + load whenever the project changes. A stale credential list / name
  // from project A must never linger under project B's id.
  useEffect(() => {
    setProjectCreds([])
    setGlobalCreds([])
    setService('')
    setToken('')
    setScope('project')
    setLabel('')
    setBusyKey(null)
    setNameError(null)
    setEmojiError(null)
    setConfirmingArchive(false)
    setArchiving(false)
    setArchived(false)
    setArchiveError(null)
    setMembers([])
    loadCreds()
    loadSettings()
    loadCodex()
  }, [loadCreds, loadSettings, loadCodex, projectId])

  const addCredential = useCallback((): void => {
    const svc = service.trim()
    const tok = token
    if (svc.length === 0 || tok.length === 0 || saving) return
    setSaving(true)
    setCredsError(null)
    const lbl = label.trim()
    void client
      .set(projectId, { service: svc, token: tok, scope, ...(lbl.length > 0 ? { label: lbl } : {}) })
      .then(() => {
        if (!mountedRef.current) return
        setSaving(false)
        setService('')
        setToken('')
        setLabel('')
        loadCreds()
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        setSaving(false)
        setCredsError(err instanceof Error ? err.message : 'failed to save credential')
      })
  }, [client, projectId, service, token, scope, label, saving, loadCreds])

  const removeCredential = useCallback(
    (rec: Rec): void => {
      const key = `${rec.scope}:${rec.service}`
      if (busyKey !== null) return
      setBusyKey(key)
      setCredsError(null)
      void client
        .remove(projectId, rec.service, rec.scope)
        .then(() => {
          if (!mountedRef.current) return
          setBusyKey(null)
          loadCreds()
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return
          setBusyKey(null)
          setCredsError(err instanceof Error ? err.message : 'failed to delete credential')
        })
    },
    [client, projectId, busyKey, loadCreds],
  )

  const saveName = useCallback((): void => {
    const next = nameDraft.trim()
    if (next.length === 0 || next === name || renaming) return
    setRenaming(true)
    setNameError(null)
    void doFetch(`${config.origin}/api/app/projects/${encodeURIComponent(projectId)}/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ name: next }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { message?: string } | null
          throw new Error(body?.message ?? `HTTP ${res.status}`)
        }
        if (!mountedRef.current) return
        setName(next)
        setNameDraft(next)
        setRenaming(false)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        setRenaming(false)
        setNameError(err instanceof Error ? err.message : 'failed to rename project')
      })
  }, [doFetch, config.origin, config.token, projectId, nameDraft, name, renaming])

  const saveEmoji = useCallback((): void => {
    const next = emojiDraft.trim()
    if (next.length === 0 || next === emoji || savingEmoji) return
    setSavingEmoji(true)
    setEmojiError(null)
    void doFetch(`${config.origin}/api/app/projects/${encodeURIComponent(projectId)}/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ emoji: next }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { message?: string } | null
          throw new Error(body?.message ?? `HTTP ${res.status}`)
        }
        // Read back the server-normalised emoji so the field reflects what was
        // actually stored. The live rail refreshes off the `projects_changed`
        // frame the surface fans on this rail-visible PATCH (onRailFieldChanged).
        if (!mountedRef.current) return
        const data = (await res.json().catch(() => null)) as { project?: { emoji?: unknown } } | null
        const saved = typeof data?.project?.emoji === 'string' ? data.project.emoji : next
        setEmoji(saved)
        setEmojiDraft(saved)
        setSavingEmoji(false)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        setSavingEmoji(false)
        setEmojiError(err instanceof Error ? err.message : 'failed to set emoji')
      })
  }, [doFetch, config.origin, config.token, projectId, emojiDraft, emoji, savingEmoji])

  const archiveProject = useCallback((): void => {
    if (archiving || archived) return
    setArchiving(true)
    setArchiveError(null)
    void doFetch(`${config.origin}/api/app/projects/${encodeURIComponent(projectId)}/archive`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}` },
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { message?: string } | null
          throw new Error(body?.message ?? `HTTP ${res.status}`)
        }
        if (!mountedRef.current) return
        // The project now drops out of the rail live (the server fans a
        // `projects_changed`). We flip to an "archived" notice; navigation away
        // is driven by the rail refresh + the shell's project selection.
        setArchiving(false)
        setArchived(true)
        setConfirmingArchive(false)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        setArchiving(false)
        setArchiveError(err instanceof Error ? err.message : 'failed to archive project')
      })
  }, [doFetch, config.origin, config.token, projectId, archiving, archived])

  const ownerRow =
    members.find((m) => m.role === 'owner') ?? { user_id: config.userId, name: 'You (owner)', role: 'owner' as const }

  return (
    <div className="cset">
      {/* ── Credentials ── */}
      <section className="cset-section" aria-label="Credentials">
        <h2 className="cset-h">Credentials</h2>
        <p className="cset-sub">
          API keys and tokens this project’s agent uses. Stored securely — the
          value is never shown again after you save it.
        </p>

        {credsError !== null ? <div className="cset-error">{credsError}</div> : null}

        {credsLoading ? (
          <div className="cset-empty">Loading…</div>
        ) : projectCreds.length === 0 && globalCreds.length === 0 ? (
          <div className="cset-empty">No credentials set for this project yet.</div>
        ) : (
          <ul className="cset-cred-ul" aria-label="Stored credentials">
            {projectCreds.map((rec) => (
              <CredentialRow
                key={`project:${rec.service}`}
                rec={rec}
                inherited={false}
                busy={busyKey === `project:${rec.service}`}
                onRemove={() => removeCredential(rec)}
              />
            ))}
            {globalCreds.map((rec) => (
              <CredentialRow
                key={`global:${rec.service}`}
                rec={rec}
                inherited
                busy={busyKey === `global:${rec.service}`}
                onRemove={() => removeCredential(rec)}
              />
            ))}
          </ul>
        )}

        <form
          className="cset-cred-form"
          onSubmit={(e) => {
            e.preventDefault()
            addCredential()
          }}
        >
          <div className="cset-field">
            <label className="cset-label" htmlFor="cset-service">
              Service
            </label>
            <input
              id="cset-service"
              className="cset-input"
              placeholder="e.g. openai, github"
              value={service}
              onChange={(e) => setService(e.target.value)}
            />
          </div>
          <div className="cset-field">
            <label className="cset-label" htmlFor="cset-token">
              Token
            </label>
            <input
              id="cset-token"
              className="cset-input"
              type="password"
              placeholder="Paste the secret"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="cset-field">
            <label className="cset-label" htmlFor="cset-label">
              Label <span className="cset-optional">(optional)</span>
            </label>
            <input
              id="cset-label"
              className="cset-input"
              placeholder="A note to recognise it"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <fieldset className="cset-field cset-scope">
            <legend className="cset-label">Scope</legend>
            <label className="cset-radio">
              <input
                type="radio"
                name="cset-scope"
                checked={scope === 'project'}
                onChange={() => setScope('project')}
              />
              This project
            </label>
            <label className="cset-radio">
              <input
                type="radio"
                name="cset-scope"
                checked={scope === 'global'}
                onChange={() => setScope('global')}
              />
              Global default
            </label>
          </fieldset>
          <div className="cset-form-actions">
            <button
              type="submit"
              className="cset-btn cset-btn-primary"
              disabled={saving || service.trim().length === 0 || token.length === 0}
            >
              {saving ? 'Saving…' : 'Add credential'}
            </button>
          </div>
        </form>
      </section>

      {/* ── Codex review OVERRIDE (optional — the primary/global connect lives
          in the General → Admin tab; this only overrides it for THIS project) ── */}
      <section className="cset-section" aria-label="Codex review override">
        <h2 className="cset-h">Codex review — project override</h2>
        <p className="cset-sub">
          <strong>Optional / advanced.</strong> Codex is normally connected once, account-wide, in
          <strong> General → Admin → Codex cross-model review</strong>, and the trident reviewer
          uses that global credential. You can store a <em>project-scoped</em> override here; the
          credential resolver prefers it over the global default wherever this project’s id is in
          play (project → global → unset). Run <code>codex login</code>, then paste that
          subscription’s <code>~/.codex/auth.json</code>. A metered <code>OPENAI_API_KEY</code> is
          rejected — subscription only.
          <br />
          <small>
            Note: the trident review loop is instance-scoped, so builds currently use the global
            credential; a stored override takes effect for the trident review once builds are
            project-scoped.
          </small>
        </p>
        <p className="cset-codex-status" data-status={codexStatus?.status ?? 'not_connected'}>
          {codexStatus?.status === 'connected'
            ? codexStatus.scope === 'project'
              ? '✓ Connected (project override)'
              : codexStatus.override_present === true
                ? '⚠ Override expired — using the global default'
                : '✓ Connected (using the global default)'
            : codexStatus?.status === 'expired'
              ? '⚠ Token expired — re-connect'
              : codexStatus?.override_present === true
                ? '○ Override set but not usable — using the global default'
                : '○ Not connected'}
          {codexStatus?.detail !== undefined ? ` — ${codexStatus.detail}` : ''}
        </p>
        {codexError !== null ? <p className="cset-error">{codexError}</p> : null}
        {/* Show removal whenever a project-override ROW exists — including an
            expired one the resolver skipped (which masks itself behind the global
            default), so a stale override is never un-removable. */}
        {codexStatus?.override_present === true ? (
          <div className="cset-form-actions">
            <button
              type="button"
              className="cset-btn"
              disabled={codexBusy}
              onClick={disconnectCodex}
            >
              {codexBusy ? 'Working…' : 'Remove override'}
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
          <label className="cset-label" htmlFor="cset-codex-auth">
            Paste ~/.codex/auth.json (project override)
          </label>
          <textarea
            id="cset-codex-auth"
            className="cset-input cset-codex-textarea"
            rows={4}
            placeholder='{ "tokens": { "access_token": "…", "refresh_token": "…" }, "last_refresh": "…" }'
            value={codexAuth}
            onChange={(e) => setCodexAuth(e.target.value)}
          />
          <div className="cset-form-actions">
            <button
              type="submit"
              className="cset-btn cset-btn-primary"
              disabled={codexBusy || codexAuth.trim().length === 0}
            >
              {codexBusy ? 'Saving…' : 'Save project override'}
            </button>
          </div>
        </form>
      </section>

      {/* ── Project ── */}
      <section className="cset-section" aria-label="Project">
        <h2 className="cset-h">Project</h2>

        <div className="cset-field">
          <label className="cset-label" htmlFor="cset-name">
            Name
          </label>
          <div className="cset-inline">
            <input
              id="cset-name"
              className="cset-input"
              value={nameDraft}
              placeholder={nameLoaded ? '' : 'Loading…'}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveName()
              }}
            />
            <button
              type="button"
              className="cset-btn cset-btn-primary"
              disabled={renaming || nameDraft.trim().length === 0 || nameDraft.trim() === name}
              onClick={saveName}
            >
              {renaming ? 'Saving…' : 'Rename'}
            </button>
          </div>
          {nameError !== null ? <div className="cset-error">{nameError}</div> : null}
        </div>

        {/* Emoji — the rail glyph for this project. Editable (rail-redesign);
            defaults to a deterministic pick from the name until changed. */}
        <div className="cset-field">
          <label className="cset-label" htmlFor="cset-emoji">
            Emoji
          </label>
          <div className="cset-inline">
            <input
              id="cset-emoji"
              className="cset-input cset-input-emoji"
              value={emojiDraft}
              placeholder={nameLoaded ? '🙂' : '…'}
              maxLength={16}
              onChange={(e) => setEmojiDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveEmoji()
              }}
              aria-label="Project emoji"
            />
            <button
              type="button"
              className="cset-btn cset-btn-primary"
              disabled={savingEmoji || emojiDraft.trim().length === 0 || emojiDraft.trim() === emoji}
              onClick={saveEmoji}
            >
              {savingEmoji ? 'Saving…' : 'Save'}
            </button>
          </div>
          <div className="cset-note">Shown next to this project in the rail.</div>
          {emojiError !== null ? <div className="cset-error">{emojiError}</div> : null}
        </div>

        {/* Archive — remove the project from the rail without deleting it. It
            stays in the Admin tab's "Archived projects" list and can be
            restored any time (archived-projects sprint). */}
        <div className="cset-field cset-archive">
          <label className="cset-label">Archive</label>
          {archived ? (
            <div className="cset-note" role="status">
              Project archived — it’s been removed from your rail. Restore it any
              time from the Admin tab’s “Archived projects” section.
            </div>
          ) : confirmingArchive ? (
            <div className="cset-inline">
              <span className="cset-note">
                Archive this project? It leaves the rail but can be restored later.
              </span>
              <button
                type="button"
                className="cset-btn cset-btn-danger"
                disabled={archiving}
                onClick={archiveProject}
              >
                {archiving ? 'Archiving…' : 'Confirm archive'}
              </button>
              <button
                type="button"
                className="cset-btn"
                disabled={archiving}
                onClick={() => setConfirmingArchive(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="cset-inline">
              <button
                type="button"
                className="cset-btn"
                onClick={() => setConfirmingArchive(true)}
              >
                Archive project
              </button>
              <span className="cset-note">Removes it from the rail (reversible).</span>
            </div>
          )}
          {archiveError !== null ? <div className="cset-error">{archiveError}</div> : null}
        </div>
      </section>

      {/* ── Collaborators (display-only, M2) ── */}
      <section className="cset-section" aria-label="Collaborators">
        <h2 className="cset-h">Collaborators</h2>
        <ul className="cset-people-ul">
          <li className="cset-person">
            <span className="cset-person-name">{ownerRow.name}</span>
            <span className="cset-person-role">Owner</span>
          </li>
          {members
            .filter((m) => m.role !== 'owner')
            .map((m) => (
              <li key={m.user_id} className="cset-person">
                <span className="cset-person-name">{m.name}</span>
                <span className="cset-person-role">Member</span>
              </li>
            ))}
        </ul>
        <button type="button" className="cset-btn" disabled title="Available in M2">
          Invite / Remove — available in M2
        </button>
      </section>
    </div>
  )
}

function CredentialRow({
  rec,
  inherited,
  busy,
  onRemove,
}: {
  rec: Rec
  /** A `global`-scope default this project inherits (labelled + delete removes
   *  the global default). */
  inherited: boolean
  busy: boolean
  onRemove: () => void
}): React.JSX.Element {
  return (
    <li className="cset-cred-row">
      <span className="cset-cred-service" title={rec.service}>
        {rec.service}
      </span>
      {rec.label !== null && rec.label.length > 0 ? (
        <span className="cset-cred-label">{rec.label}</span>
      ) : null}
      {inherited ? <span className="cset-cred-badge">global default</span> : null}
      <button
        type="button"
        className="cset-btn cset-btn-icon"
        onClick={onRemove}
        disabled={busy}
        title="Remove credential"
        aria-label={`Remove ${rec.service} credential`}
      >
        ✕
      </button>
    </li>
  )
}
