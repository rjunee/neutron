/**
 * landing/chat-react — web APP SHELL (WAVE 3 PR-4; rail/tab rework 2026-06-30).
 *
 * The top-level layout for the React web client. Two persistent regions:
 *
 *   ┌────────────┬──────────────────────────────────────┐
 *   │ TopicRail  │ TabBar (Chat · …)                     │
 *   │ (projects, │──────────────────────────────────────│
 *   │  always    │ active tab body (ChatApp / Documents  │
 *   │  visible)  │ / Plan / Admin / Core webview)        │
 *   └────────────┴──────────────────────────────────────┘
 *
 * ── TopicRail = persistent left column ──────────────────────────────────────
 * The project rail is ALWAYS visible — General + every project, on every tab —
 * so the user can switch project (which re-scopes the chat to that project's
 * topic) or create a project from anywhere. It used to be nested INSIDE the Chat
 * tab body (`ChatApp`), so it vanished on non-Chat tabs; it now lives here at the
 * layout root. `ChatApp` is just the Chat-tab body (`ChatSurface`).
 *
 * ── TabBar in BOTH General and project ──────────────────────────────────────
 * The tab bar renders in the right content pane for BOTH views:
 *   - General (no active project): Chat + Admin (the global-scope tabs).
 *   - Project: Chat / Plan / Documents (+ any installed project Core tabs). NO
 *     Admin — it's a global surface, reachable from General, NOT folded into a
 *     project (mixing a global tab into a project's set was the old bug).
 *
 * ── Tab content ─────────────────────────────────────────────────────────────
 *   - Chat (builtin)         → `ChatApp`, kept MOUNTED across tab switches
 *     (hidden via `hidden`) so the chat-core session, streaming state, and
 *     scroll position survive a round-trip to another tab.
 *   - Plan / Documents (builtin) → the live Work Board / Documents views.
 *   - Admin (builtin, global)  → the owner-facing integrations surface.
 *   - Core (webview)         → the Core's `project_tab` surface in a sandboxed
 *     `<iframe>`, scheme-validated (`sanitizeCoreTabUrl`) before the iframe `src`.
 *
 * Tasks is NO LONGER a builtin tab (Ryan directive, WAVE 3) — it returns as a
 * Core-contributed webview tab via the `CoreTabContribution` path, so the
 * generic `webview` branch below renders it with no engine tasks code.
 *
 * ── No feature flag ─────────────────────────────────────────────────────────
 * Per the SPEC Decisions Log (Ryan, 2026-06-23) WAVE 3 ships WITHOUT feature
 * flags. The shell renders the resolved tabs directly; when a resolver can't be
 * reached the bar degrades to the guaranteed Chat tab (graceful fallback, not a
 * flag).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ChatApp, TopicRail } from './ChatApp.tsx'
import { DocumentsTab, type DocOpenRequest } from './DocumentsTab.tsx'
import { WorkBoardTab } from './WorkBoardTab.tsx'
import { IntegrationsTab } from './IntegrationsTab.tsx'
import { SettingsTab } from './SettingsTab.tsx'
import type { ChatViewModel } from './controller.ts'
import type { NeutronChatController } from './controller.ts'
import type { BootstrapConfig } from './config.ts'
import type { AttachmentDraft } from './useAttachmentDraft.ts'
import {
  CHAT_TAB,
  WebTabsClient,
  sanitizeCoreTabUrl,
  type TabDescriptor,
} from './tabs-client.ts'

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

/** The Chat tab key — kept mounted and the default active tab. */
const CHAT_KEY = CHAT_TAB.key

/** The horizontal tab bar. Pure presentation over the resolved descriptors. */
function TabBar({
  tabs,
  activeKey,
  onSelect,
}: {
  tabs: readonly TabDescriptor[]
  activeKey: string
  onSelect: (key: string) => void
}): React.JSX.Element {
  return (
    <nav className="car-tabs" role="tablist" aria-label="Sections">
      {tabs.map((t) => {
        const active = t.key === activeKey
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            className={`car-tab${active ? ' car-tab-active' : ''}`}
            onClick={() => onSelect(t.key)}
          >
            {t.label}
          </button>
        )
      })}
    </nav>
  )
}

/** Placeholder for a builtin tab whose real view ships in a later PR. */
function TabPlaceholder({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="car-tab-placeholder" role="status">
      <div className="car-tab-placeholder-title">{label}</div>
      <div className="car-tab-placeholder-sub">Coming soon.</div>
    </div>
  )
}

/** Render one non-Chat tab's body: Documents, the Plan board, the Admin
 *  integrations surface, a Core webview, or a builtin placeholder. `projectId`
 *  is '' for the General (no-project) view — only the global Admin tab renders
 *  there, and it doesn't require a concrete project. */
function TabContent({
  tab,
  projectId,
  config,
  controller,
  fetchImpl,
  docOpenRequest,
}: {
  tab: TabDescriptor
  projectId: string
  config: BootstrapConfig
  /** Live-frame source for the Work Board tab (`work_board_changed`). */
  controller: NeutronChatController
  fetchImpl?: FetchImpl
  /** P-A — a pending "open this doc" request forwarded to the Documents tab. */
  docOpenRequest?: DocOpenRequest
}): React.JSX.Element {
  if (tab.mount.kind === 'webview') {
    const safeUrl = sanitizeCoreTabUrl(tab.mount.target)
    if (safeUrl === null) {
      return (
        <div className="car-tab-placeholder" role="alert">
          <div className="car-tab-placeholder-title">Can’t open {tab.label}</div>
          <div className="car-tab-placeholder-sub">
            This Core tab didn’t provide a valid web address.
          </div>
        </div>
      )
    }
    return (
      <iframe
        className="car-tab-frame"
        src={safeUrl}
        title={`${tab.label} Core tab`}
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
      />
    )
  }
  // Builtin Documents — the Obsidian-replacement read+comment surface (PR-5).
  if (tab.mount.target === 'docs') {
    return (
      <DocumentsTab
        projectId={projectId}
        config={config}
        {...(fetchImpl !== undefined ? { fetchImpl } : {})}
        {...(docOpenRequest !== undefined ? { openRequest: docOpenRequest } : {})}
      />
    )
  }
  // Builtin Plan (work_board) — the live work-tracker (active+next, completed
  // history), human read+WRITE, applying live `work_board_changed` frames.
  if (tab.mount.target === 'workboard') {
    return (
      <WorkBoardTab
        projectId={projectId}
        config={config}
        liveSource={controller}
        {...(fetchImpl !== undefined ? { fetchImpl } : {})}
      />
    )
  }
  // Builtin Admin — the owner-facing OAuth + API-key integrations surface. A
  // GLOBAL-scope tab (per-instance, not per-project); shown in the General view.
  if (tab.mount.target === 'admin') {
    return (
      <IntegrationsTab
        projectId={projectId}
        config={config}
        {...(fetchImpl !== undefined ? { fetchImpl } : {})}
      />
    )
  }
  // Builtin Settings — the per-project settings surface: credentials (API keys
  // the agent's tools use), project rename, and (M2-gated) collaborators.
  if (tab.mount.target === 'settings') {
    return (
      <SettingsTab
        projectId={projectId}
        config={config}
        {...(fetchImpl !== undefined ? { fetchImpl } : {})}
      />
    )
  }
  // Any other builtin tab whose real view hasn't landed yet.
  return <TabPlaceholder label={tab.label} />
}

export function ProjectShell({
  vm,
  controller,
  config,
  draft,
  fetchImpl,
}: {
  vm: ChatViewModel
  controller: NeutronChatController
  config: BootstrapConfig
  draft: AttachmentDraft
  /** Injected in tests; also forwarded to `ChatApp` for authed image fetches. */
  fetchImpl?: FetchImpl
}): React.JSX.Element {
  const client = useMemo(
    () =>
      new WebTabsClient(
        fetchImpl !== undefined
          ? { base_url: config.origin, token: config.token, fetchImpl }
          : { base_url: config.origin, token: config.token },
      ),
    [config.origin, config.token, fetchImpl],
  )

  const [tabs, setTabs] = useState<TabDescriptor[]>([CHAT_TAB])
  const [activeKey, setActiveKey] = useState<string>(CHAT_KEY)
  const projectId = vm.projectId
  const isGeneral = projectId === null || projectId.length === 0

  // P-A — in-app doc-link navigation state. A tapped chat doc link records a
  // pending {project, path}; once the shell is scoped to that project AND its
  // Documents tab has resolved, we activate that tab and hand the path to
  // `DocumentsTab` via a nonce-stamped {@link DocOpenRequest}.
  const docNonce = useRef(0)
  const [pendingDoc, setPendingDoc] = useState<{ projectId: string; path: string } | null>(null)
  const [docOpenRequest, setDocOpenRequest] = useState<DocOpenRequest | null>(null)
  const onOpenDocLink = useCallback(
    (linkProjectId: string, path: string): void => {
      // Cross-project link (e.g. tapped from the General onboarding chat): switch
      // project first; the resolver effect opens the doc once its tabs resolve.
      if (linkProjectId !== (vm.projectId ?? '')) controller.setProject(linkProjectId)
      setPendingDoc({ projectId: linkProjectId, path })
    },
    [vm.projectId, controller],
  )

  // Resolve the tab set for the current scope:
  //   - General  → Chat + the GLOBAL tabs (builtin Admin + global Core tabs).
  //   - Project  → the project tabs (Chat / Plan / Documents + project Core
  //                tabs). NO global fold-in — Admin is reachable from General.
  // A stale in-flight fetch (rapid switches, StrictMode double-invoke) is
  // ignored via the `cancelled` latch. Switching scope resets the active tab to
  // Chat so we never land on a tab that doesn't exist in the new set.
  useEffect(() => {
    let cancelled = false
    setActiveKey(CHAT_KEY)
    setTabs([CHAT_TAB])
    if (isGeneral) {
      void client
        .listGlobalTabs()
        .then((globalTabs) => {
          if (cancelled) return
          setTabs([CHAT_TAB, ...globalTabs])
        })
        .catch(() => {
          if (!cancelled) setTabs([CHAT_TAB])
        })
      return () => {
        cancelled = true
      }
    }
    void client
      .listProjectTabs(projectId as string)
      .then((projectTabs) => {
        if (cancelled) return
        setTabs(projectTabs.length > 0 ? projectTabs : [CHAT_TAB])
      })
      .catch(() => {
        if (!cancelled) setTabs([CHAT_TAB])
      })
    return () => {
      cancelled = true
    }
  }, [client, projectId, isGeneral])

  // P-A — resolve a pending doc-link tap: once the shell is scoped to the
  // link's project AND its Documents tab has loaded, activate that tab and hand
  // the path to `DocumentsTab`. Runs after the tab-set effect above, which
  // resets to Chat on a project switch — so a cross-project link lands on the
  // doc, not Chat.
  useEffect(() => {
    if (pendingDoc === null) return
    if ((projectId ?? '') !== pendingDoc.projectId) return
    const docsTab = tabs.find((t) => t.mount.target === 'docs')
    if (docsTab === undefined) return
    setActiveKey(docsTab.key)
    docNonce.current += 1
    setDocOpenRequest({ path: pendingDoc.path, nonce: docNonce.current })
    setPendingDoc(null)
  }, [pendingDoc, projectId, tabs])

  // The previous active tab can vanish when the set changes (scope switch / Core
  // uninstall). Fall back to Chat so we never highlight a missing tab.
  const hasActive = tabs.some((t) => t.key === activeKey)
  const resolvedActiveKey = hasActive ? activeKey : CHAT_KEY
  const activeTab = tabs.find((t) => t.key === resolvedActiveKey) ?? CHAT_TAB

  // assistant-ui's composer autofocus tries to scroll the focused input into
  // view on mount; keep the panels container as the scroll parent.
  const panelsRef = useRef<HTMLDivElement>(null)

  // Chat stays mounted across tab switches so the live session, stream, and
  // scroll state survive — only its visibility toggles.
  const chatHidden = resolvedActiveKey !== CHAT_KEY

  // Create-project flow (rail button): the rail owns an INLINE name input
  // (mirrors the mobile `app/app/projects` pattern — no native window.prompt,
  // which is unstyleable and blocks E2E/CDP automation). This callback POSTs to
  // the bearer-gated create endpoint, navigates into the new project on success
  // (`setProject` re-scopes the chat), and RETURNS an error string (or null) so
  // the rail renders the failure inline instead of a blocking window.alert. The
  // live `projects_changed` frame refreshes the rail list.
  const [creatingProject, setCreatingProject] = useState(false)
  const onCreateProject = useCallback(
    async (name: string): Promise<string | null> => {
      if (creatingProject) return null
      setCreatingProject(true)
      const doFetch: FetchImpl = fetchImpl ?? ((input, init) => fetch(input, init))
      try {
        const res = await doFetch(`${config.origin}/api/app/projects`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify({ name }),
        })
        if (res.ok) {
          const data = (await res.json()) as { project?: { id?: unknown } }
          const id = data.project?.id
          if (typeof id === 'string' && id.length > 0) controller.setProject(id)
          return null
        }
        return `Could not create project (${res.status}).`
      } catch {
        return 'Could not create project.'
      } finally {
        setCreatingProject(false)
      }
    },
    [creatingProject, fetchImpl, config.origin, config.token, controller],
  )

  return (
    <div className="car-app">
      <TopicRail
        projects={vm.projects}
        activeId={vm.projectId}
        onSelect={(id) => controller.setProject(id)}
        onCreate={onCreateProject}
        creating={creatingProject}
      />
      <div className="car-content">
        <TabBar tabs={tabs} activeKey={resolvedActiveKey} onSelect={setActiveKey} />
        <div className="car-tabpanels" ref={panelsRef}>
          {/* Chat stays mounted across tab switches so the live session, stream,
              and scroll state survive — only its visibility toggles. */}
          <div className="car-tabpanel" role="tabpanel" hidden={chatHidden} aria-hidden={chatHidden}>
            <ChatApp
              vm={vm}
              controller={controller}
              config={config}
              draft={draft}
              onOpenDocLink={onOpenDocLink}
              {...(fetchImpl !== undefined ? { fetchImpl } : {})}
            />
          </div>
          {resolvedActiveKey !== CHAT_KEY ? (
            <div className="car-tabpanel" role="tabpanel">
              <TabContent
                tab={activeTab}
                projectId={projectId ?? ''}
                config={config}
                controller={controller}
                {...(fetchImpl !== undefined ? { fetchImpl } : {})}
                {...(docOpenRequest !== null ? { docOpenRequest } : {})}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
