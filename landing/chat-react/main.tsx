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
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { WebChatSession, createWebStore } from '@neutron/chat-core'

import { ChatApp } from './ChatApp.tsx'
import { resolveBootstrapConfig, type BootstrapConfig, type WindowLike } from './config.ts'
import { NeutronChatController } from './controller.ts'
import { useNeutronChat } from './useNeutronChat.ts'
import { useAttachmentDraft } from './useAttachmentDraft.ts'

function Root({
  controller,
  config,
}: {
  controller: NeutronChatController
  config: BootstrapConfig
}): React.JSX.Element {
  const draft = useAttachmentDraft({ token: config.token })
  const { runtime, vm } = useNeutronChat(controller, config.origin, draft)
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatApp vm={vm} controller={controller} config={config} draft={draft} />
    </AssistantRuntimeProvider>
  )
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
  // feature-detect); the transcript is durable so cold-open is instant.
  const store = await createWebStore()
  const controller = new NeutronChatController({
    projectId: config.projectId,
    createSession: (sinks) =>
      new WebChatSession({
        url: config.wsUrl,
        topic_id: config.topicId,
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
