/**
 * landing/chat-react — the thin React seam over {@link NeutronChatController}.
 *
 * It (a) mirrors the controller's synchronous view-model into React state, (b)
 * drives the controller lifecycle (start on mount, stop on unmount, pause on
 * tab blur via the AppState bridge), and (c) builds the assistant-ui
 * `ExternalStoreRuntime` — the bring-your-own-transport runtime: assistant-ui
 * owns nothing, it renders our `messages` (via {@link toThreadMessage}) and
 * calls `onNew` when the user sends, which we forward to the controller.
 */

import { useEffect, useMemo, useState } from 'react'
import { useExternalStoreRuntime, type AppendMessage } from '@assistant-ui/react'

import type { ChatViewModel, NeutronChatController, RenderMessage } from './controller.ts'
import { toThreadMessage } from './message-adapter.ts'

/** Pull the plain text out of an assistant-ui AppendMessage's content parts. */
export function extractText(message: AppendMessage): string {
  const out: string[] = []
  for (const part of message.content) {
    if (part.type === 'text') out.push(part.text)
  }
  return out.join('').trim()
}

/** Pull image attachment URLs out of an AppendMessage (content image parts). */
export function extractAttachments(message: AppendMessage): string[] {
  const out: string[] = []
  for (const part of message.content) {
    if (part.type === 'image' && typeof part.image === 'string') out.push(part.image)
  }
  return out
}

export interface UseNeutronChat {
  runtime: ReturnType<typeof useExternalStoreRuntime>
  vm: ChatViewModel
}

export function useNeutronChat(controller: NeutronChatController, origin: string): UseNeutronChat {
  const [vm, setVm] = useState<ChatViewModel>(() => controller.getViewModel())

  useEffect(() => {
    const unsub = controller.subscribe(setVm)
    controller.start()
    const onVisibility = (): void => {
      controller.setActive(document.visibilityState === 'visible')
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      unsub()
      controller.stop()
    }
  }, [controller])

  const convertMessage = useMemo(
    () => (m: RenderMessage) => toThreadMessage(m, origin),
    [origin],
  )

  const runtime = useExternalStoreRuntime<RenderMessage>({
    messages: vm.messages,
    isRunning: vm.isRunning,
    convertMessage,
    onNew: async (message: AppendMessage) => {
      const text = extractText(message)
      const attachments = extractAttachments(message)
      if (text.length === 0 && attachments.length === 0) return
      await controller.send(text, attachments.length > 0 ? attachments : undefined)
    },
  })

  return { runtime, vm }
}
