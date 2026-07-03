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

import { ChatApp, TopicRail, GENERAL_EMOJI, railEmojiFor, useMediaQuery } from './ChatApp.tsx'
import { DocumentsTab, type DocOpenRequest } from './DocumentsTab.tsx'
import { WorkBoardTab } from './WorkBoardTab.tsx'
import { PlansPane } from './PlansPane.tsx'
import { IntegrationsTab } from './IntegrationsTab.tsx'
import { SettingsTab } from './SettingsTab.tsx'
import { ThemeToggle } from './ThemeToggle.tsx'
import type { ChatViewModel } from './controller.ts'
import type { NeutronChatController } from './controller.ts'
import type { BootstrapConfig } from './config.ts'
import type { AttachmentDraft } from './useAttachmentDraft.ts'
import {
  CHAT_TAB,
  GENERAL_WORK_TAB,
  WebTabsClient,
  sanitizeCoreTabUrl,
  type TabDescriptor,
} from './tabs-client.ts'

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

/** The Chat tab key — kept mounted and the default active tab. */
const CHAT_KEY = CHAT_TAB.key

/** The horizontal tab bar. Pure presentation over the resolved descriptors.
 *
 *  `resolving` is true while a scope switch's tab fetch is in flight: the bar
 *  keeps the PREVIOUS scope's descriptors mounted for visual continuity (no
 *  flicker), but every NON-Chat tab is disabled so a stale button can't be
 *  clicked to mount a wrong-scope `TabContent` (e.g. the old project's Core
 *  iframe) before the new set resolves (Codex P2). Chat is always in-scope. */
function TabBar({
  tabs,
  activeKey,
  onSelect,
  resolving,
}: {
  tabs: readonly TabDescriptor[]
  activeKey: string
  onSelect: (key: string) => void
  resolving: boolean
}): React.JSX.Element {
  return (
    <nav className="car-tabs" role="tablist" aria-label="Sections">
      {tabs.map((t) => {
        const active = t.key === activeKey
        const disabled = resolving && t.key !== CHAT_KEY
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            aria-disabled={disabled}
            className={`car-tab${active ? ' car-tab-active' : ''}`}
            onClick={() => {
              if (disabled) return
              onSelect(t.key)
            }}
          >
            {t.label}
          </button>
        )
      })}
    </nav>
  )
}

/** The workspace-identity seat — the "you're inside a workspace" anchor seated
 *  to the LEFT of the tabs: the active scope's emoji + name (General shows
 *  💬 General). No activity dot (that lives on the rail — Ryan's de-dup keeps the
 *  seat clean). */
function WorkspaceSeat({ emoji, name }: { emoji: string; name: string }): React.JSX.Element {
  return (
    <div className="car-wsseat">
      <span className="car-wsseat-emoji" aria-hidden="true">
        {emoji}
      </span>
      <span className="car-wsseat-name">{name}</span>
    </div>
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
  onOpenDocLink,
}: {
  tab: TabDescriptor
  projectId: string
  config: BootstrapConfig
  /** Live-frame source for the Work Board tab (`work_board_changed`). */
  controller: NeutronChatController
  fetchImpl?: FetchImpl
  /** P-A — a pending "open this doc" request forwarded to the Documents tab. */
  docOpenRequest?: DocOpenRequest
  /** Open a project doc in the Documents tab — threaded to the Work tab's card
   *  ▸ spec-doc links (same nav a chat doc link uses). */
  onOpenDocLink?: (projectId: string, path: string) => void
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
        {...(onOpenDocLink !== undefined ? { onOpenDoc: onOpenDocLink } : {})}
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
  // The open request is SCOPED to the project that produced it, so a stale
  // request can never open project A's doc after the user switches to project B.
  const [docOpenRequest, setDocOpenRequest] =
    useState<{ projectId: string; req: DocOpenRequest } | null>(null)
  const onOpenDocLink = useCallback(
    (linkProjectId: string, path: string): void => {
      // Cross-project link (e.g. tapped from the General onboarding chat): switch
      // project first; the resolver effect opens the doc once its tabs resolve.
      if (linkProjectId !== (vm.projectId ?? '')) controller.setProject(linkProjectId)
      setPendingDoc({ projectId: linkProjectId, path })
    },
    [vm.projectId, controller],
  )

  // Doc-link deep-link 404 fix — when the SPA was HARD-LOADED at a
  // `/projects/<id>/docs?path=…` deep link (the gateway's SPA catch-all served
  // the shell; `config.initialDocLink` carries the parsed target), open that
  // doc ONCE on boot — the same effect a tap would have had. Reusing
  // `onOpenDocLink` shares all the project-switch + tab-resolve + open-request
  // machinery. The ref guard fires it a single time so a later re-render can't
  // re-open a doc the user has since navigated away from.
  const bootDocLinkOpened = useRef(false)
  useEffect(() => {
    if (bootDocLinkOpened.current) return
    const link = config.initialDocLink
    if (link === undefined) return
    bootDocLinkOpened.current = true
    onOpenDocLink(link.projectId, link.path)
  }, [config.initialDocLink, onOpenDocLink])

  // Resolve the tab set for the current scope:
  //   - General  → Chat + the GLOBAL tabs (builtin Admin + global Core tabs).
  //   - Project  → the project tabs (Chat / Plan / Documents + project Core
  //                tabs). NO global fold-in — Admin is reachable from General.
  // A stale in-flight fetch (rapid switches, StrictMode double-invoke) is
  // ignored via the `cancelled` latch. Switching scope resets the active tab to
  // Chat so we never land on a tab that doesn't exist in the new set.
  // Which project (`''` = General) the current `tabs` were RESOLVED for. Null
  // while a fetch is in flight. The doc-link resolver waits for this to match
  // the pending link's project, so a cross-project link never consumes the
  // previous project's stale tab set (Codex).
  const [tabsScope, setTabsScope] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    // Reconcile the tab bar IN PLACE (2026-07-02 flicker fix): a switch resets
    // the active tab to Chat and marks the scope in-flight (`tabsScope = null`,
    // which the doc-link resolver keys off), but it does NOT collapse `tabs` to
    // `[CHAT_TAB]` first. Collapsing then re-expanding was a visible two-step
    // flicker on every switch; keeping the current descriptors mounted until the
    // new set resolves lets React reconcile the `<TabBar>` buttons by key (the
    // always-present Chat tab never remounts) and swap the rest in ONE step.
    setActiveKey(CHAT_KEY)
    setTabsScope(null)
    if (isGeneral) {
      void client
        .listGlobalTabs()
        .then((globalTabs) => {
          if (cancelled) return
          // General gets the SAME Work surface every named project has: inject the
          // `work_board` descriptor (after Chat) so the existing `showPane` gate +
          // narrow-width tab light up for General, scoped to its `owner_slug` board.
          // The engine's global set is Admin-only, so General had no `workboard`
          // descriptor and thus no Work view (the gap this closes). Mirrors the
          // mobile shell's `ensureWorkTab` injection — one code path, no branch.
          setTabs([CHAT_TAB, GENERAL_WORK_TAB, ...globalTabs])
          setTabsScope('')
        })
        .catch(() => {
          if (cancelled) return
          setTabs([CHAT_TAB])
          setTabsScope('')
        })
      return () => {
        cancelled = true
      }
    }
    const scope = projectId as string
    void client
      .listProjectTabs(scope)
      .then((projectTabs) => {
        if (cancelled) return
        setTabs(projectTabs.length > 0 ? projectTabs : [CHAT_TAB])
        setTabsScope(scope)
      })
      .catch(() => {
        if (cancelled) return
        setTabs([CHAT_TAB])
        setTabsScope(scope)
      })
    return () => {
      cancelled = true
    }
  }, [client, projectId, isGeneral])

  // P-A — resolve a pending doc-link tap: once the shell is scoped to the
  // link's project AND that project's tabs have RESOLVED (not the previous
  // project's stale set) AND its Documents tab exists, activate that tab and
  // hand the path to `DocumentsTab`.
  useEffect(() => {
    if (pendingDoc === null) return
    if ((projectId ?? '') !== pendingDoc.projectId) return
    // Wait until the loaded tab set actually belongs to the pending project —
    // after a cross-project setProject, `tabs` briefly still holds the old set.
    if (tabsScope === null || tabsScope !== pendingDoc.projectId) return
    const docsTab = tabs.find((t) => t.mount.target === 'docs')
    if (docsTab === undefined) return
    setActiveKey(docsTab.key)
    docNonce.current += 1
    setDocOpenRequest({
      projectId: pendingDoc.projectId,
      req: { path: pendingDoc.path, nonce: docNonce.current },
    })
    setPendingDoc(null)
  }, [pendingDoc, projectId, tabs, tabsScope])

  // PR-4 — on desktop (≥1024px) the Work board is NOT a seated tab; it lives in
  // the right-edge slide-out pane (mounted below). Drop the `workboard`
  // descriptor from the tab bar and mount the pane instead. Below 1024px Work
  // STAYS a tab (the mobile Work badge is PR-6) — one implementation per
  // platform, never a dual tab-and-pane path on the same viewport.
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const workboardTab = tabs.find((t) => t.mount.target === 'workboard')
  // Gate the pane on a RESOLVED scope (`tabsScope !== null`). During a scope
  // switch `tabs` intentionally still holds the OUTGOING scope's descriptors, so
  // an ungated `showPane` would mount the pane — and fire a wrong-scope
  // (`/projects//work-board`, or the previous project's) board fetch — for the new
  // scope before its tabs resolve, exactly the stale-scope hazard the disabled tab
  // buttons already guard against (Codex P2). Once resolved, `tabs`/`workboardTab`
  // belong to the current scope.
  const showPane = isDesktop && tabsScope !== null && workboardTab !== undefined
  const visibleTabs = showPane ? tabs.filter((t) => t.mount.target !== 'workboard') : tabs

  // Pane open state is owned by `PlansPane` (auto-open/close + manual handle);
  // it reports up here so the shell grid's 3rd column can grow in lock-step
  // (chat shrinks, never overlaid). Reset when the pane unmounts (resize below
  // 1024px, or a scope with no Work board) so the grid can't stay expanded.
  const [paneOpen, setPaneOpen] = useState(false)
  useEffect(() => {
    if (!showPane) setPaneOpen(false)
  }, [showPane])

  // The previous active tab can vanish when the set changes (scope switch / Core
  // uninstall) — or, on desktop, because the Work tab was dropped in favor of the
  // pane. Fall back to Chat so we never highlight a missing tab. While a scope
  // switch's tab fetch is in flight (`resolving`), the still-mounted tabs belong
  // to the OUTGOING scope, so clamp the active tab to the always-in-scope Chat
  // until the new set resolves — belt-and-braces with the disabled non-Chat
  // buttons so no wrong-scope `TabContent` can mount mid-switch (Codex P2).
  const resolving = tabsScope === null
  const hasActive = visibleTabs.some((t) => t.key === activeKey)
  const resolvedActiveKey = resolving || !hasActive ? CHAT_KEY : activeKey
  const activeTab = visibleTabs.find((t) => t.key === resolvedActiveKey) ?? CHAT_TAB

  // P-A — a doc-open request is ONE-SHOT: clear it once the user leaves the
  // Documents tab so revisiting Documents (or a `DocumentsTab` remount on a
  // project switch) can't replay the old linked doc.
  const activeTarget = activeTab.mount.target
  useEffect(() => {
    if (activeTarget !== 'docs' && docOpenRequest !== null) setDocOpenRequest(null)
  }, [activeTarget, docOpenRequest])
  // Only forward the request to the Documents tab of the project that produced
  // it (never a different project's Documents mount).
  const docReqForTab =
    docOpenRequest !== null && docOpenRequest.projectId === (projectId ?? '')
      ? docOpenRequest.req
      : undefined

  // assistant-ui's composer autofocus tries to scroll the focused input into
  // view on mount; keep the panels container as the scroll parent.
  const panelsRef = useRef<HTMLDivElement>(null)

  // Chat stays mounted across tab switches so the live session, stream, and
  // scroll state survive — only its visibility toggles.
  const chatHidden = resolvedActiveKey !== CHAT_KEY

  // A Work card's ▸ spec-doc link opens the doc in the Documents tab. General's
  // tab set is Chat + Work + Admin — it has NO Documents tab, so `onOpenDocLink`
  // would set a pending doc the resolver can never satisfy (it waits for a `docs`
  // tab), leaving a dead button (Codex P2). So we DON'T wire `onOpenDoc` into
  // General's Work surface: `WorkBoardTab` then renders the spec-doc ref as a
  // STATIC label instead of a clickable no-op. Named projects keep the live link.
  const workOpenDoc = isGeneral ? undefined : onOpenDocLink

  // Workspace-identity seat (left of the tabs): the active scope's emoji + name.
  // General → 💬 General; a project → its emoji (server, else generic) + label.
  // A just-switched-to project may not yet be in `vm.projects`; fall back to a
  // neutral label so the seat never renders blank.
  const activeProject = isGeneral ? undefined : vm.projects.find((p) => p.id === projectId)
  const seatEmoji = isGeneral ? GENERAL_EMOJI : railEmojiFor(activeProject?.emoji)
  const seatName = isGeneral ? 'General' : (activeProject?.label ?? 'Workspace')

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
        {/* Tab band (seated tabs): the workspace-identity seat, then the section
            tabs (fills the row), with the light/dark theme toggle bottom-right.
            The toggle owns the whole UI's theme (a user preference, not per-tab),
            so it lives at the shell root. */}
        <div className="car-topbar">
          <WorkspaceSeat emoji={seatEmoji} name={seatName} />
          <TabBar tabs={visibleTabs} activeKey={resolvedActiveKey} onSelect={setActiveKey} resolving={resolving} />
          <ThemeToggle />
        </div>
        {/* The chat STAGE (below the band): the chat/tab panels + the desktop Work
            slide-out. A CSS grid so the pane's column can grow (chat shrinks,
            never overlaid) while the pane floats within this region — below the
            band, not over it. */}
        <div className={`car-stage${showPane && paneOpen ? ' car-stage-pane-open' : ''}`}>
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
                  {...(workOpenDoc !== undefined ? { onOpenDocLink: workOpenDoc } : {})}
                  {...(fetchImpl !== undefined ? { fetchImpl } : {})}
                  {...(docReqForTab !== undefined ? { docOpenRequest: docReqForTab } : {})}
                />
              </div>
            ) : null}
          </div>
          {/* PR-4 — the desktop WORK slide-out. Mounted (not a tab) only ≥1024px
              on a scope that has a Work board; keyed by project so its
              auto-open/close controller resets cleanly on a project switch. */}
          {showPane ? (
            <PlansPane
              key={projectId ?? ''}
              projectId={projectId ?? ''}
              config={config}
              controller={controller}
              onOpenChange={setPaneOpen}
              {...(workOpenDoc !== undefined ? { onOpenDoc: workOpenDoc } : {})}
              {...(fetchImpl !== undefined ? { fetchImpl } : {})}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}
