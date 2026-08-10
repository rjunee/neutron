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
 *
 *      This tab is a READER of the global defaults, never their author
 *      (ISSUES #486). It used to carry a project/global scope toggle on the add
 *      form and a delete on every inherited row, so a credential written while
 *      standing in ONE project silently changed EVERY project — two writers for
 *      one fact. Inherited rows are now labelled and read-only, and both the
 *      add form and the delete only ever touch this project. Authoring the
 *      instance-wide defaults lives where they apply: General → Admin.
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
  type Rec,
  type ServiceAccountSelection,
} from './project-credentials-client.ts'
import { oauthServiceTitle } from './integrations-oauth-view.ts'
import { WebCodexCredentialClient, type CodexStatus } from './codex-credential-client.ts'
import {
  WebPhaseModelsClient,
  applyRowEdit,
  effectiveRow,
  type PhaseModelsPayload,
  type PhaseOverride,
} from './phase-models-client.ts'
import {
  WebVoiceTranscriptionClient,
  describeJob,
  formatBytes,
  jobFraction,
  type TranscriptionBackendChoice,
  type VoiceTranscriptionStatus,
} from './voice-transcription-client.ts'

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

  // Per-phase build models — which model + reasoning effort runs each phase.
  const phaseModelsClient = useMemo(
    () => new WebPhaseModelsClient({ base_url: config.origin, token: config.token, fetchImpl: withSignal }),
    [config.origin, config.token, withSignal],
  )

  // ── per-phase build models ──
  const [phaseModels, setPhaseModels] = useState<PhaseModelsPayload | null>(null)
  const [phaseOverrides, setPhaseOverrides] = useState<Record<string, PhaseOverride>>({})
  const [phaseBusy, setPhaseBusy] = useState(false)
  const [phaseError, setPhaseError] = useState<string | null>(null)
  const [phaseSaved, setPhaseSaved] = useState(false)

  const loadPhaseModels = useCallback((): void => {
    void phaseModelsClient
      .load()
      .then((next) => {
        if (!mountedRef.current) return
        setPhaseModels(next)
        setPhaseOverrides(next.overrides)
        setPhaseError(null)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        // A failed LOAD is reported, not rendered as an empty pipeline: zero phases
        // would read as "this build has no phases", which the owner cannot act on.
        setPhaseModels(null)
        setPhaseError(err instanceof Error ? err.message : 'could not load the build settings')
      })
  }, [phaseModelsClient])

  const editPhase = useCallback(
    (phaseKey: string, patch: { model?: string; effort?: string }): void => {
      setPhaseModels((current) => {
        if (current === null) return current
        const phase = current.phases.find((p) => p.key === phaseKey)
        if (phase !== undefined) setPhaseOverrides((prev) => applyRowEdit(prev, phase, patch))
        return current
      })
      // A pending edit invalidates the confirmation — leaving it up would say the
      // newest change is already stored.
      setPhaseSaved(false)
    },
    [],
  )

  const savePhaseModels = useCallback((): void => {
    if (phaseBusy) return
    setPhaseBusy(true)
    setPhaseError(null)
    void phaseModelsClient
      .save(phaseOverrides)
      .then((next) => {
        if (!mountedRef.current) return
        setPhaseModels(next)
        setPhaseOverrides(next.overrides)
        setPhaseSaved(true)
        setPhaseBusy(false)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        // The local edits are KEPT so a rejected value can be corrected in place;
        // discarding them would punish a typo by throwing away the rest of the work.
        setPhaseError(err instanceof Error ? err.message : 'could not save the build settings')
        setPhaseBusy(false)
      })
  }, [phaseModelsClient, phaseOverrides, phaseBusy])

  // ── credentials ──
  const [projectCreds, setProjectCreds] = useState<Rec[]>([])
  const [globalCreds, setGlobalCreds] = useState<Rec[]>([])
  const [credsLoading, setCredsLoading] = useState(true)
  const [credsError, setCredsError] = useState<string | null>(null)

  // Add-credential form. No scope control — this form only ever writes THIS
  // project's credential (ISSUES #486).
  const [service, setService] = useState('')
  const [token, setToken] = useState('')
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)

  // Per-row delete guard so a double-click can't fire two deletes.
  const [busyKey, setBusyKey] = useState<string | null>(null)

  // ── connected accounts this project reads (#500) ──
  // Rows come from the server ALREADY joined with the live grants, so an
  // account connected after this tab loaded shows up on the next load rather
  // than being inferred here from a stale local list.
  const [accountServices, setAccountServices] = useState<ServiceAccountSelection[]>([])
  const [accountsLoading, setAccountsLoading] = useState(true)
  const [accountsError, setAccountsError] = useState<string | null>(null)
  // Per-toggle guard, keyed `<service>:<account_id>`.
  const [accountBusyKey, setAccountBusyKey] = useState<string | null>(null)

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

  // ── local voice transcription (whisper.cpp) ──
  // Machine-scoped, not per-project: one install serves every project, so this
  // client carries no project id.
  const asrClient = useMemo(
    () =>
      new WebVoiceTranscriptionClient({
        base_url: config.origin,
        token: config.token,
        fetchImpl: withSignal,
      }),
    [config.origin, config.token, withSignal],
  )
  const [asr, setAsr] = useState<VoiceTranscriptionStatus | null>(null)
  const [asrModel, setAsrModel] = useState<string>('')
  const [asrBusy, setAsrBusy] = useState(false)
  const [asrError, setAsrError] = useState<string | null>(null)
  const [confirmingAsrRemove, setConfirmingAsrRemove] = useState(false)
  // The pasted key. Never seeded from the server (it never sends one) and
  // cleared the moment a save is fired, so it lives in memory for as long as it
  // takes to type it and no longer.
  const [openAiKeyDraft, setOpenAiKeyDraft] = useState('')

  const loadAsr = useCallback((): void => {
    void asrClient
      .status()
      .then((s) => {
        if (!mountedRef.current) return
        setAsr(s)
        // Preselect the installed model, else the recommended default. Only seed
        // the dropdown once so a poll tick can't yank the user's choice mid-pick.
        setAsrModel((prev) => (prev === '' ? (s.model_id ?? s.default_model_id) : prev))
      })
      .catch(() => {
        if (!mountedRef.current) return
        setAsr(null)
      })
  }, [asrClient])

  // POLL while an install is running. A ~150 MB - 1.6 GB download behind a
  // button that shows nothing is the exact failure this section exists to avoid,
  // so the bar moves off real server-side byte counts. The interval is torn down
  // the moment the job leaves a running phase (or the tab unmounts) — no timer
  // outlives the work it was watching.
  const asrPhase = asr?.job?.phase ?? null
  const asrRunning =
    asrPhase !== null && asrPhase !== 'done' && asrPhase !== 'failed' && asrPhase !== 'idle'
  useEffect(() => {
    if (!asrRunning) return
    const t = setInterval(loadAsr, 1000)
    return () => clearInterval(t)
  }, [asrRunning, loadAsr])

  const startAsrInstall = useCallback((): void => {
    setAsrBusy(true)
    setAsrError(null)
    void asrClient
      .install(asrModel)
      .then((s) => {
        if (!mountedRef.current) return
        setAsr(s)
        setAsrBusy(false)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        setAsrBusy(false)
        setAsrError(err instanceof Error ? err.message : 'failed to start the install')
      })
  }, [asrClient, asrModel])

  const removeAsr = useCallback((): void => {
    setAsrBusy(true)
    setAsrError(null)
    void asrClient
      .remove()
      .then((s) => {
        if (!mountedRef.current) return
        setAsr(s)
        setAsrBusy(false)
        setConfirmingAsrRemove(false)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        setAsrBusy(false)
        setAsrError(err instanceof Error ? err.message : 'failed to remove')
      })
  }, [asrClient])

  // Choose-a-backend / save-a-key / forget-a-key all share this shape: every
  // route answers with the SAME status object, so the reply IS the new state and
  // there is no re-fetch race between what was just done and what the server
  // thinks. A write is never aborted on unmount (see `withSignal`).
  const runAsrMutation = useCallback(
    (call: () => Promise<VoiceTranscriptionStatus>, failure: string): void => {
      setAsrBusy(true)
      setAsrError(null)
      void call()
        .then((s) => {
          if (!mountedRef.current) return
          setAsr(s)
          setAsrBusy(false)
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return
          setAsrBusy(false)
          setAsrError(err instanceof Error ? err.message : failure)
        })
    },
    [],
  )

  const chooseAsrBackend = useCallback(
    (backend: TranscriptionBackendChoice): void => {
      runAsrMutation(() => asrClient.chooseBackend(backend), 'failed to change the backend')
    },
    [asrClient, runAsrMutation],
  )

  const saveOpenAiKey = useCallback((): void => {
    const key = openAiKeyDraft.trim()
    if (key.length === 0) return
    // Cleared BEFORE the request, not in the `.then`: a failed save must not
    // leave the key sitting in a DOM input, and the error text the server
    // returns never echoes what was sent.
    setOpenAiKeyDraft('')
    runAsrMutation(() => asrClient.saveOpenAiKey(key), 'failed to save the key')
  }, [asrClient, openAiKeyDraft, runAsrMutation])

  const removeOpenAiKey = useCallback((): void => {
    runAsrMutation(() => asrClient.removeOpenAiKey(), 'failed to remove the key')
  }, [asrClient, runAsrMutation])

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

  const loadAccounts = useCallback((): void => {
    setAccountsLoading(true)
    setAccountsError(null)
    void client
      .listAccounts(projectId)
      .then((services) => {
        if (!mountedRef.current) return
        setAccountServices(services)
        setAccountsLoading(false)
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return
        setAccountServices([])
        setAccountsLoading(false)
        setAccountsError(err instanceof Error ? err.message : 'failed to load connected accounts')
      })
  }, [client, projectId])

  const toggleAccount = useCallback(
    (service: string, account_id: string, enabled: boolean): void => {
      const key = `${service}:${account_id}`
      setAccountBusyKey(key)
      setAccountsError(null)
      void client
        .setAccountEnabled(projectId, { service, account_id, enabled })
        .then((services) => {
          if (!mountedRef.current) return
          setAccountServices(services)
          setAccountBusyKey(null)
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return
          setAccountBusyKey(null)
          setAccountsError(err instanceof Error ? err.message : 'failed to update account')
        })
    },
    [client, projectId],
  )

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
    setLabel('')
    setBusyKey(null)
    setNameError(null)
    setEmojiError(null)
    setConfirmingArchive(false)
    setArchiving(false)
    setArchived(false)
    setArchiveError(null)
    setMembers([])
    setAccountServices([])
    setAccountBusyKey(null)
    setAccountsError(null)
    loadCreds()
    loadAccounts()
    loadSettings()
    loadCodex()
    loadPhaseModels()
    loadAsr()
  }, [loadCreds, loadAccounts, loadSettings, loadCodex, loadPhaseModels, loadAsr, projectId])

  const addCredential = useCallback((): void => {
    const svc = service.trim()
    const tok = token
    if (svc.length === 0 || tok.length === 0 || saving) return
    setSaving(true)
    setCredsError(null)
    const lbl = label.trim()
    void client
      .set(projectId, { service: svc, token: tok, ...(lbl.length > 0 ? { label: lbl } : {}) })
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
  }, [client, projectId, service, token, label, saving, loadCreds])

  // Only ever removes THIS project's credential. Inherited (global) rows have
  // no remove control here — they are removed where they are authored.
  const removeCredential = useCallback(
    (rec: Rec): void => {
      const key = `project:${rec.service}`
      if (busyKey !== null) return
      setBusyKey(key)
      setCredsError(null)
      void client
        .remove(projectId, rec.service)
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
          value is never shown again after you save it. Anything you add here
          applies to <strong>this project only</strong>; the keys marked{' '}
          <em>global default</em> come from every project’s shared set and are
          changed in <strong>General → Admin</strong>.
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
              <CredentialRow key={`global:${rec.service}`} rec={rec} inherited busy={false} />
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
              placeholder="e.g. openai, github, kimi"
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
          <div className="cset-note" data-testid="cred-scope-note">
            Saved for this project only. To set a default every project inherits,
            use General → Admin.
          </div>
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

      {/* ── Connected accounts this project reads (ISSUES #500) ──────────────
          CONNECTING an account is global and lives in General → Admin. This
          only narrows which of the already-connected accounts THIS project
          sweeps, so a work project stops reading a personal mailbox without
          anything being disconnected or re-consented. ── */}
      <section className="cset-section" aria-label="Connected accounts">
        <h2 className="cset-h">Connected accounts</h2>
        <p className="cset-sub">
          Which of your connected accounts this project reads. Turning one off here
          changes <strong>this project only</strong> — nothing is disconnected, and the
          account keeps working everywhere else. Accounts are connected once in{' '}
          <strong>General → Admin</strong>, and a newly connected account is on
          everywhere until you turn it off.
        </p>

        {accountsError !== null ? <div className="cset-error">{accountsError}</div> : null}

        {accountsLoading ? (
          <div className="cset-empty">Loading…</div>
        ) : accountServices.every((svc) => svc.accounts.length === 0) ? (
          <div className="cset-empty">
            No accounts connected yet. Connect one in General → Admin.
          </div>
        ) : (
          accountServices
            .filter((svc) => svc.accounts.length > 0)
            .map((svc) => (
              <div className="cset-acct-group" key={svc.service} data-service={svc.service}>
                <h3 className="cset-acct-service">{oauthServiceTitle(svc.service)}</h3>
                {/* Every account off is a legitimate "this project doesn't use
                    it" choice — but it must READ as off, not as broken. */}
                {svc.accounts.every((a) => !a.enabled) ? (
                  <div className="cset-acct-off" data-testid={`accounts-off-${svc.service}`}>
                    Off for this project — {oauthServiceTitle(svc.service)} is not read here.
                  </div>
                ) : null}
                <ul className="cset-acct-ul" aria-label={`${oauthServiceTitle(svc.service)} accounts`}>
                  {svc.accounts.map((acct) => {
                    const key = `${svc.service}:${acct.account_id}`
                    return (
                      <li className="cset-acct-row" key={key} data-account-enabled={acct.enabled}>
                        <label className="cset-acct-label">
                          <input
                            type="checkbox"
                            className="cset-acct-toggle"
                            checked={acct.enabled}
                            disabled={accountBusyKey === key}
                            onChange={() =>
                              toggleAccount(svc.service, acct.account_id, !acct.enabled)
                            }
                          />
                          {/* `label` is humanised server-side — account_id is a
                              hex digest and never reaches the screen. */}
                          <span className="cset-acct-name">{acct.label}</span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))
        )}
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

      {/* ── Code generation: which model runs each build phase ───────────────
          Machine-scoped, like the voice setting below: which model runs a build is
          a property of the owner's subscriptions and quota, not of the project
          being built. The phase list is SERVER-SUPPLIED — labels, descriptions,
          defaults and legal values all arrive in the payload — so a phase added to
          the engine appears here with no client change, and the phone and the web
          cannot disagree about what the phases are. */}
      <section className="cset-section" aria-label="Code generation">
        <h2 className="cset-h">Code generation</h2>
        <p className="cset-sub">
          Which model runs each part of a build, and how hard it thinks. Changes apply to
          the next build — nothing restarts. A dot marks the default; choosing it clears
          the override, so the phase keeps following the default if that ever changes.
        </p>

        {phaseError !== null ? (
          <p className="cset-error" data-testid="phase-models-error">
            {phaseError}
          </p>
        ) : null}
        {phaseSaved && phaseError === null ? (
          <p className="cset-saved" data-testid="phase-models-saved">
            Saved
          </p>
        ) : null}

        {phaseModels === null ? (
          <div className="cset-empty">
            {phaseError === null ? 'Loading…' : 'Build settings unavailable.'}
          </div>
        ) : (
          <>
            {phaseModels.phases.map((phase) => {
              const row = effectiveRow(phase, phaseOverrides)
              return (
                <fieldset
                  className="cset-field"
                  key={phase.key}
                  data-testid={`phase-${phase.key}`}
                >
                  <legend className="cset-label">
                    {phase.label}
                    {row.overridden ? (
                      <em data-testid={`phase-${phase.key}-changed`}> — changed</em>
                    ) : null}
                  </legend>
                  <p className="cset-sub">{phase.description}</p>
                  <div className="cset-chiprow">
                    <span className="cset-label">Model</span>
                    {phaseModels.model_tiers.map((tier) => (
                      <button
                        key={tier}
                        type="button"
                        className={`cset-chip${row.model === tier ? ' cset-chip-on' : ''}`}
                        aria-pressed={row.model === tier}
                        data-testid={`phase-${phase.key}-model-${tier}`}
                        onClick={() => editPhase(phase.key, { model: tier })}
                      >
                        {tier}
                        {phase.default.model === tier ? ' ·' : ''}
                      </button>
                    ))}
                  </div>
                  <div className="cset-chiprow">
                    <span className="cset-label">Effort</span>
                    {phaseModels.efforts.map((eff) => (
                      <button
                        key={eff}
                        type="button"
                        className={`cset-chip${row.effort === eff ? ' cset-chip-on' : ''}`}
                        aria-pressed={row.effort === eff}
                        data-testid={`phase-${phase.key}-effort-${eff}`}
                        onClick={() => editPhase(phase.key, { effort: eff })}
                      >
                        {eff}
                        {phase.default.effort === eff ? ' ·' : ''}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )
            })}
            <button
              type="button"
              className="cset-btn"
              disabled={phaseBusy}
              data-testid="phase-models-save"
              onClick={savePhaseModels}
            >
              {phaseBusy ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      </section>

      {/* ── Voice transcription ──────────────────────────────────────────────
          Machine-scoped, not per-project: one choice and one install serve every
          project on this box. Nothing is downloaded until the owner asks for it
          here, so a fresh install stays lean and never pays for a feature it may
          not use.

          The SETTING is the only thing that decides which backend runs. There is
          no precedence underneath it in either direction — the copy must not
          imply one, because the server does not implement one. */}
      <section className="cset-section" aria-label="Voice transcription">
        <h2 className="cset-h">Voice transcription</h2>
        <p className="cset-sub">
          How your voice notes are turned into text. Two options, and this setting is the only
          thing that decides between them — installing one does not override the other.
        </p>

        {asr === null ? (
          <div className="cset-empty">Loading…</div>
        ) : (
          <>
            <p className="cset-asr-status" data-backend={asr.backend}>
              {asr.backend === 'local'
                ? `✓ Transcribing on this server — ${asr.model_id ?? 'installed'} model${
                    asr.installed_bytes > 0 ? ` (${formatBytes(asr.installed_bytes)} on disk)` : ''
                  }`
                : asr.backend === 'openai'
                  ? '✓ Transcribing with the OpenAI API'
                  : asr.backend_reason === 'unchosen'
                    ? '⚠ Nothing is transcribing — both options are set up, so pick the one you want'
                    : asr.backend_reason === 'local_not_installed'
                      ? '⚠ Nothing is transcribing — you chose this server, but whisper.cpp is not installed yet'
                      : asr.backend_reason === 'openai_key_missing'
                        ? '⚠ Nothing is transcribing — you chose OpenAI, but no API key is saved'
                        : '○ Nothing is transcribing — set up one of the options below'}
            </p>

            {/* THE CHOICE. Each option states its own honest cost; neither is
                marked as the default, because there isn't one. */}
            <fieldset className="cset-field cset-scope" data-testid="voice-backend-choice">
              <legend className="cset-label">Use</legend>
              <label className="cset-radio">
                <input
                  type="radio"
                  name="cset-asr-backend"
                  checked={asr.choice === 'local'}
                  disabled={asrBusy}
                  onChange={() => chooseAsrBackend('local' as TranscriptionBackendChoice)}
                />
                <span>
                  <strong>This server</strong>
                  {asr.backend === 'local' ? <em> — in use</em> : null}
                  <br />
                  <small>
                    Runs on your own server with whisper.cpp. No API key, nothing billed per
                    minute, and the audio never leaves the machine. Speed is down to the hardware:
                    the timings below were measured on a server with no GPU, where the large models
                    take longer than the recording itself. On a GPU-accelerated machine they are
                    much faster.
                    {!asr.local_available ? (
                      <strong> Not installed yet — install a model below.</strong>
                    ) : null}
                  </small>
                </span>
              </label>
              <label className="cset-radio">
                <input
                  type="radio"
                  name="cset-asr-backend"
                  checked={asr.choice === 'openai'}
                  disabled={asrBusy}
                  onChange={() => chooseAsrBackend('openai' as TranscriptionBackendChoice)}
                />
                <span>
                  <strong>OpenAI API</strong>
                  {asr.backend === 'openai' ? <em> — in use</em> : null}
                  <br />
                  <small>
                    Sends the audio to OpenAI. Large-model accuracy in a few seconds whatever your
                    server is, so it does not slow down on a CPU-only box. Needs an API key, is
                    billed per minute of audio, and the recording leaves your machine.
                    {!asr.openai_key.present ? (
                      <strong> No API key saved yet — add one below.</strong>
                    ) : null}
                  </small>
                </span>
              </label>
            </fieldset>

            {asr.choice !== null && asr.backend !== asr.choice ? (
              <div className="cset-note" data-testid="voice-backend-stalled">
                Your choice is not running yet, and nothing has been substituted for it — set it up
                below and it starts on the next voice note.
              </div>
            ) : null}

            {/* Live progress. Real byte counts from the server, not a spinner. */}
            {asr.job !== null && asr.job.phase !== 'idle' ? (
              <div className="cset-asr-progress" role="status" aria-live="polite">
                <div className="cset-note">{describeJob(asr.job)}</div>
                {asr.job.phase !== 'failed' ? (
                  <div
                    className="cset-asr-bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    {...(jobFraction(asr.job) !== null
                      ? { 'aria-valuenow': Math.round((jobFraction(asr.job) ?? 0) * 100) }
                      : {})}
                  >
                    <span
                      className="cset-asr-bar-fill"
                      style={{ width: `${Math.round((jobFraction(asr.job) ?? 0) * 100)}%` }}
                    />
                  </div>
                ) : null}
                {asr.job.phase === 'failed' ? (
                  <div className="cset-error">
                    {asr.job.error?.message ?? 'The install failed.'} Nothing was installed — you
                    can try again.
                  </div>
                ) : null}
              </div>
            ) : null}

            {asrError !== null ? <div className="cset-error">{asrError}</div> : null}

            {/* macOS ships no upstream whisper-cli build; point at Homebrew
                rather than downloading weights that cannot be run. */}
            {!asr.binary_downloadable && !asr.binary_present && !asr.installed ? (
              <div className="cset-note">
                No prebuilt whisper.cpp binary is published for this platform. Install it first with
                your package manager (on macOS: <code>brew install whisper-cpp</code>), then reload
                this page — the model download below will do the rest.
              </div>
            ) : null}

            <h3 className="cset-label">On this server</h3>

            {asr.installed ? (
              <div className="cset-inline cset-asr-actions">
                {confirmingAsrRemove ? (
                  <>
                    <span className="cset-note">
                      Delete the local model and binary ({formatBytes(asr.installed_bytes)})?{' '}
                      {asr.choice === 'local'
                        ? 'On-server transcription is what you chose, so voice notes stop being transcribed until you install it again or switch to OpenAI.'
                        : 'Voice notes are unaffected — they are not using this.'}
                    </span>
                    <button
                      type="button"
                      className="cset-btn cset-btn-danger"
                      disabled={asrBusy}
                      onClick={removeAsr}
                    >
                      {asrBusy ? 'Removing…' : 'Delete'}
                    </button>
                    <button
                      type="button"
                      className="cset-btn"
                      disabled={asrBusy}
                      onClick={() => setConfirmingAsrRemove(false)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="cset-btn cset-btn-danger"
                    disabled={asrBusy || asrRunning}
                    onClick={() => setConfirmingAsrRemove(true)}
                  >
                    Remove local Whisper
                  </button>
                )}
              </div>
            ) : (
              <div className="cset-field">
                <label className="cset-label" htmlFor="cset-asr-model">
                  Model
                </label>
                <select
                  id="cset-asr-model"
                  className="cset-input"
                  value={asrModel}
                  disabled={asrBusy || asrRunning}
                  onChange={(e) => setAsrModel(e.target.value)}
                >
                  {asr.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — {formatBytes(m.size_bytes)} download
                    </option>
                  ))}
                </select>
                {/* The honest cost, stated before the click: download size,
                    measured speed, and RAM. */}
                {asr.models
                  .filter((m) => m.id === asrModel)
                  .map((m) => (
                    <div className="cset-note" key={m.id}>
                      {m.note} Uses about {m.peak_rss_mb} MB of RAM while transcribing.
                    </div>
                  ))}
                <div className="cset-form-actions cset-asr-actions">
                  <button
                    type="button"
                    className="cset-btn cset-btn-primary"
                    disabled={asrBusy || asrRunning || asrModel === ''}
                    onClick={startAsrInstall}
                  >
                    {asrRunning ? 'Installing…' : 'Install local Whisper'}
                  </button>
                </div>
              </div>
            )}

            {/* ── OpenAI key ──────────────────────────────────────────────────
                Write-only. The server returns whether a key exists, where it
                came from and when it was saved — never the key, and never part
                of one. There is deliberately nothing here that renders a stored
                value, so there is nothing to leak into a screenshot or a DOM
                dump. */}
            <h3 className="cset-label">OpenAI</h3>
            <p className="cset-note" data-testid="voice-openai-key-status">
              {!asr.openai_key.present
                ? 'Add a key from platform.openai.com to use OpenAI transcription. It is stored encrypted on your own server and is never shown again.'
                : asr.openai_key.source === 'environment'
                  ? 'Using OPENAI_API_KEY from the server environment. To change it here, save a key below; to remove it, edit the server.'
                  : asr.openai_key.source === 'shared'
                    ? 'Using your OpenAI key from Integrations — the same key that powers semantic memory. Save a key below only if you want transcription billed to a separate one.'
                    : asr.openai_key.saved_at !== null
                      ? `Key saved ${new Date(asr.openai_key.saved_at).toLocaleDateString()}.`
                      : 'Key saved.'}
            </p>
            <form
              className="cset-form"
              onSubmit={(e) => {
                e.preventDefault()
                saveOpenAiKey()
              }}
            >
              <div className="cset-field">
                <label className="cset-label" htmlFor="cset-asr-openai-key">
                  API key
                </label>
                <input
                  id="cset-asr-openai-key"
                  className="cset-input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={
                    asr.openai_key.present ? 'Replace the saved key' : 'Paste your OpenAI API key'
                  }
                  value={openAiKeyDraft}
                  onChange={(e) => setOpenAiKeyDraft(e.target.value)}
                />
              </div>
              <div className="cset-form-actions cset-asr-actions">
                <button
                  type="submit"
                  className="cset-btn cset-btn-primary"
                  disabled={asrBusy || openAiKeyDraft.trim().length === 0}
                >
                  {asr.openai_key.present ? 'Replace key' : 'Save key'}
                </button>
                {asr.openai_key.source === 'stored' ? (
                  <button
                    type="button"
                    className="cset-btn cset-btn-danger"
                    disabled={asrBusy}
                    onClick={removeOpenAiKey}
                  >
                    Remove key
                  </button>
                ) : null}
              </div>
            </form>
          </>
        )}
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
  /**
   * A `global`-scope default this project INHERITS. Read-only here: it is
   * labelled and shown (knowing the key exists is what makes this project's
   * settings legible) but carries no remove control, because removing it would
   * change every other project from a screen scoped to this one (ISSUES #486).
   */
  inherited: boolean
  busy: boolean
  onRemove?: () => void
}): React.JSX.Element {
  return (
    <li className="cset-cred-row">
      <span className="cset-cred-service" title={rec.service}>
        {rec.service}
      </span>
      {rec.label !== null && rec.label.length > 0 ? (
        <span className="cset-cred-label">{rec.label}</span>
      ) : null}
      {inherited ? (
        <>
          <span className="cset-cred-badge">global default</span>
          <span className="cset-cred-managed">Change in General → Admin</span>
        </>
      ) : (
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
      )}
    </li>
  )
}
