/**
 * landing/chat-react — web project TAB SHELL (WAVE 3 PR-4).
 *
 * Wraps the existing `ChatApp` as the **Chat** tab and renders the project's
 * tab bar from the engine resolver (`GET /api/app/projects/<id>/tabs`), so the
 * web project view shows tabs (Chat + Documents + Tasks + any installed Core
 * tabs) instead of chat-only. This is the web twin of the mobile registry-driven
 * tab bar shipped in PR-3 (`app/components/ProjectTabBar.tsx`).
 *
 * ── No feature flag ─────────────────────────────────────────────────────────
 * Per the SPEC Decisions Log (Ryan, 2026-06-23) WAVE 3 ships WITHOUT feature
 * flags. The shell renders the resolved tabs directly — there is no toggle and
 * no dual chat-only path. When the resolver can't be reached the bar degrades to
 * the guaranteed Chat tab (the existing chat experience), which is graceful
 * fallback, not a flag.
 *
 * ── Tab content ─────────────────────────────────────────────────────────────
 *   - Chat (builtin)         → the existing `ChatApp`, kept MOUNTED across tab
 *     switches (hidden via `hidden`) so the chat-core session, streaming state,
 *     and scroll position survive a round-trip to another tab.
 *   - Documents/Tasks (builtin) → a "coming soon" placeholder until PR-5..9 land
 *     their real views. This is unbuilt content, NOT a flag.
 *   - Core (webview)         → the Core's `project_tab` surface in a sandboxed
 *     `<iframe>`, mirroring the mobile `cores/[slug]` webview from PR-3. The URL
 *     is scheme-validated (`sanitizeCoreTabUrl`) before it ever reaches the
 *     iframe `src`.
 *
 * ── Project scope ───────────────────────────────────────────────────────────
 * Tabs are resolved per project. When a project is active (`vm.projectId`) the
 * shell fetches that project's tab set; the General (no-project) view has no
 * project tabs, so it stays chat-only. Switching projects re-fetches and resets
 * the active tab to Chat.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { ChatApp } from './ChatApp.tsx'
import { DocumentsTab } from './DocumentsTab.tsx'
import { TasksTab } from './TasksTab.tsx'
import { IntegrationsTab } from './IntegrationsTab.tsx'
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
    <nav className="car-tabs" role="tablist" aria-label="Project sections">
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

/** Render one non-Chat tab's body: the Documents view, a Core webview, or a
 *  builtin placeholder for tabs whose real view ships in a later PR. */
function TabContent({
  tab,
  projectId,
  config,
  fetchImpl,
}: {
  tab: TabDescriptor
  projectId: string
  config: BootstrapConfig
  fetchImpl?: FetchImpl
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
      />
    )
  }
  // Builtin Tasks — the LLM-prioritized, agent+user-parity tasks view (PR-8).
  if (tab.mount.target === 'tasks') {
    return (
      <TasksTab
        projectId={projectId}
        config={config}
        {...(fetchImpl !== undefined ? { fetchImpl } : {})}
      />
    )
  }
  // Builtin Admin — the owner-facing OAuth + API-key integrations surface. This
  // is a GLOBAL-scope tab (per-instance, not per-project) folded into the bar.
  if (tab.mount.target === 'admin') {
    return (
      <IntegrationsTab
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

  // Resolve the tab set for the active project. The General (no-project) view
  // has no project tabs, so it falls back to the guaranteed Chat tab. A stale
  // in-flight fetch (rapid project switches, StrictMode double-invoke) is
  // ignored via the `cancelled` latch.
  useEffect(() => {
    if (projectId === null || projectId.length === 0) {
      setTabs([CHAT_TAB])
      setActiveKey(CHAT_KEY)
      return
    }
    let cancelled = false
    // Reset to the Chat fallback IMMEDIATELY on a project switch so the previous
    // project's resolved tabs (incl. its Core iframe URLs) can't linger — and be
    // clicked under the new project's chat — while the new fetch is in flight.
    setActiveKey(CHAT_KEY)
    setTabs([CHAT_TAB])
    // Resolve per-project tabs (Chat/Documents/Tasks + project Core tabs) and the
    // GLOBAL tabs (builtin Admin + global Core tabs) in parallel, then fold the
    // global tabs in AFTER the project tabs so the owner can reach the Admin /
    // Integrations surface from the project shell. A failed global fetch degrades
    // to the project-only set (the Admin tab just won't appear) — not a flag.
    void Promise.all([
      client.listProjectTabs(projectId),
      client.listGlobalTabs().catch(() => [] as TabDescriptor[]),
    ])
      .then(([projectTabs, globalTabs]) => {
        if (cancelled) return
        const base = projectTabs.length > 0 ? projectTabs : [CHAT_TAB]
        const seen = new Set(base.map((t) => t.key))
        const extra = globalTabs.filter((t) => !seen.has(t.key))
        setTabs([...base, ...extra])
      })
      .catch(() => {
        if (cancelled) return
        setTabs([CHAT_TAB])
      })
    return () => {
      cancelled = true
    }
  }, [client, projectId])

  // The previous active tab can vanish when the set changes (project switch /
  // Core uninstall). Fall back to Chat so we never highlight a missing tab.
  const hasActive = tabs.some((t) => t.key === activeKey)
  const resolvedActiveKey = hasActive ? activeKey : CHAT_KEY
  const activeTab = tabs.find((t) => t.key === resolvedActiveKey) ?? CHAT_TAB

  // assistant-ui's composer autofocus tries to scroll the focused input into
  // view on mount; keep the panels container as the scroll parent.
  const panelsRef = useRef<HTMLDivElement>(null)

  // The General (no-project) view has no project tabs, so it stays the existing
  // CHAT-ONLY experience — no tab strip, full chat area. The tab bar only
  // appears once a project is active. `ChatApp` keeps the SAME tree position
  // either way, so crossing the General↔project boundary doesn't remount it.
  const isGeneral = projectId === null || projectId.length === 0
  const chatHidden = !isGeneral && resolvedActiveKey !== CHAT_KEY

  return (
    <div className="car-projectshell">
      {!isGeneral ? (
        <TabBar tabs={tabs} activeKey={resolvedActiveKey} onSelect={setActiveKey} />
      ) : null}
      <div className="car-tabpanels" ref={panelsRef}>
        {/* Chat stays mounted across tab switches so the live session, stream,
            and scroll state survive — only its visibility toggles. */}
        <div className="car-tabpanel" role="tabpanel" hidden={chatHidden} aria-hidden={chatHidden}>
          <ChatApp
            vm={vm}
            controller={controller}
            config={config}
            draft={draft}
            {...(fetchImpl !== undefined ? { fetchImpl } : {})}
          />
        </div>
        {!isGeneral && resolvedActiveKey !== CHAT_KEY && projectId !== null ? (
          <div className="car-tabpanel" role="tabpanel">
            <TabContent
              tab={activeTab}
              projectId={projectId}
              config={config}
              {...(fetchImpl !== undefined ? { fetchImpl } : {})}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
