/**
 * landing/chat-react — browser entry point for the React/assistant-ui web chat.
 *
 * Bundled to `/chat-react.js` by the landing server's lazy `Bun.build` (mirrors
 * how `chat.ts` → `/chat.js` works today) and loaded only by `chat-react.html`,
 * which the server serves at `/chat` ONLY when the web-chat flag resolves to
 * `react`. The vanilla client is otherwise untouched.
 *
 * Wiring: derive the bootstrap config from the page (start token → user id →
 * app-ws topic + URL), open a durable local store (OPFS, with in-memory
 * fallback), build a `WebChatSession` (chat-core), wrap it in the controller,
 * and mount the assistant-ui composition.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WebChatSession, createWebStore } from '@neutronai/chat-core'

import { ProjectShell } from './ProjectShell.tsx'
import {
  resolveBootstrapConfig,
  topicForProject,
  wsUrlForScope,
  type BootstrapConfig,
  type WindowLike,
} from './config.ts'
import { NeutronChatController } from './controller.ts'
import { useNeutronChatVm } from './useNeutronChat.ts'
import { useAttachmentDraft } from './useAttachmentDraft.ts'

function Root({
  controller,
  config,
}: {
  controller: NeutronChatController
  config: BootstrapConfig
}): React.JSX.Element {
  const draft = useAttachmentDraft({ token: config.token })
  // Mirror the controller vm + drive its lifecycle here (stable across the
  // whole session). The assistant-ui runtime is NO LONGER provided at the root:
  // it's built per-conversation inside `ChatApp` (`ConversationRuntimeHost`,
  // keyed by convId) so a project switch mounts a fresh runtime and can't index
  // a stale message list (SEV1 switch-race fix). The chat session still survives
  // tab switches because `ProjectShell` keeps `ChatApp` mounted.
  const vm = useNeutronChatVm(controller)
  return <ProjectShell vm={vm} controller={controller} config={config} draft={draft} />
}

function renderError(rootEl: HTMLElement, message: string): void {
  rootEl.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = 'car-fatal'
  wrap.textContent = message
  rootEl.appendChild(wrap)
}

async function boot(): Promise<void> {
  const rootEl = document.getElementById('root')
  if (rootEl === null) return
  let config: BootstrapConfig
  try {
    config = resolveBootstrapConfig(window as unknown as WindowLike)
  } catch (err) {
    renderError(rootEl, err instanceof Error ? err.message : 'chat-react: failed to initialize')
    return
  }
  // OPFS store with graceful in-memory fallback (createWebStore handles the
  // feature-detect); the transcript is durable so cold-open is instant. ONE
  // store is shared across per-project sessions — it's keyed internally by
  // topic_id, so each project's transcript stays isolated under its own topic.
  const store = await createWebStore()
  // Per-project chat: derive the socket URL for a given scope. `project_id` on
  // the URL tells the server to bind the PER-PROJECT topic (`app:<user>:<id>`);
  // General omits it. An explicit `__neutron_app_ws_url` override (dev/test)
  // wins verbatim — a single fixed socket, no per-project query.
  // ISSUES #40 — delegate to the shared, unit-tested URL factory so EVERY connect
  // (initial + project switch + reconnect) carries the boot-detected IANA `tz`,
  // not just the initial `config.wsUrl`.
  const wsUrlFor = (projectId: string | null): string => wsUrlForScope(config, projectId)
  const controller = new NeutronChatController({
    projectId: config.projectId,
    // FIX 1 — seed the rail from the bootstrap, then keep it reactive so
    // projects created mid-onboarding appear live (a `projects_changed` frame).
    projects: config.projects,
    // Managed post-onboarding claim redirect — undefined on Open self-host, so
    // the controller's redirect no-ops (see BootstrapConfig.postOnboardingClaimUrl).
    ...(config.postOnboardingClaimUrl !== undefined
      ? { postOnboardingClaimUrl: config.postOnboardingClaimUrl }
      : {}),
    topicForProject: (projectId) => topicForProject(config.userId, projectId),
    createSession: (sinks, scope) =>
      new WebChatSession({
        url: wsUrlFor(scope.projectId),
        topic_id: scope.topicId,
        store,
        device_id: config.deviceId,
        onChange: sinks.onChange,
        onStatus: sinks.onStatus,
        onFrame: sinks.onFrame,
      }),
  })
  createRoot(rootEl).render(
    <StrictMode>
      <Root controller={controller} config={config} />
    </StrictMode>,
  )
}

void boot()
