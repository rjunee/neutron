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

import { useCallback, useEffect, useMemo, useState } from 'react'

import type { BootstrapConfig } from './config.ts'
import {
  WebProjectCredentialsClient,
  type CredentialScope,
  type Rec,
} from './project-credentials-client.ts'

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
  const client = useMemo(
    () =>
      new WebProjectCredentialsClient(
        fetchImpl !== undefined
          ? { base_url: config.origin, token: config.token, fetchImpl }
          : { base_url: config.origin, token: config.token },
      ),
    [config.origin, config.token, fetchImpl],
  )

  // Raw fetch for the project-settings GET/PATCH (a single `name` field — no
  // dedicated client). Mirrors `ProjectShell`'s `onCreateProject` bearer fetch.
  const doFetch: FetchImpl = useMemo(
    () => fetchImpl ?? ((input, init) => fetch(input, init)),
    [fetchImpl],
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

  // ── project name ──
  const [name, setName] = useState('')
  const [nameLoaded, setNameLoaded] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)

  // ── collaborators (display-only) ──
  const [members, setMembers] = useState<ProjectMemberView[]>([])

  const loadCreds = useCallback((): void => {
    setCredsLoading(true)
    setCredsError(null)
    void client
      .list(projectId)
      .then((list) => {
        setProjectCreds(list.project)
        setGlobalCreds(list.global)
        setCredsLoading(false)
      })
      .catch((err: unknown) => {
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
        const project = (data as { project?: { name?: unknown; members?: unknown } } | null)?.project
        const pName = typeof project?.name === 'string' ? project.name : ''
        setName(pName)
        setNameDraft(pName)
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
    setMembers([])
    loadCreds()
    loadSettings()
  }, [loadCreds, loadSettings, projectId])

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
        setSaving(false)
        setService('')
        setToken('')
        setLabel('')
        loadCreds()
      })
      .catch((err: unknown) => {
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
          setBusyKey(null)
          loadCreds()
        })
        .catch((err: unknown) => {
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
        setName(next)
        setNameDraft(next)
        setRenaming(false)
      })
      .catch((err: unknown) => {
        setRenaming(false)
        setNameError(err instanceof Error ? err.message : 'failed to rename project')
      })
  }, [doFetch, config.origin, config.token, projectId, nameDraft, name, renaming])

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

        {/* Emoji is a SEAM — there's no emoji column yet, so the control renders
            disabled. It lands with the rail-emoji work (no invented backend). */}
        <div className="cset-field">
          <label className="cset-label" htmlFor="cset-emoji">
            Emoji
          </label>
          <div className="cset-inline">
            <input id="cset-emoji" className="cset-input cset-input-emoji" value="" disabled placeholder="🙂" />
          </div>
          <div className="cset-note">Coming with rail emoji.</div>
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
