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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useExternalStoreRuntime, type AppendMessage } from '@assistant-ui/react'

import type { ChatViewModel, NeutronChatController, RenderMessage } from './controller.ts'
import type { AttachmentDraft } from './useAttachmentDraft.ts'
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

export function useNeutronChat(
  controller: NeutronChatController,
  origin: string,
  draft?: AttachmentDraft,
): UseNeutronChat {
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

  // The draft is a fresh object literal every render (its methods are stable
  // useCallbacks, but the wrapper isn't), so read it through a ref — that keeps
  // `onNew` stable without dropping the draft dependency, which in turn keeps the
  // adapter object below memoizable.
  const draftRef = useRef(draft)
  draftRef.current = draft

  const onNew = useCallback(
    async (message: AppendMessage): Promise<void> => {
      const text = extractText(message)
      // Wait for any in-flight uploads so a caption sent before a larger image
      // finishes uploading doesn't drop the attachment, then merge the staged
      // URLs (+ any assistant-ui content image parts — none today) and clear the
      // draft once the controller owns the send.
      const d = draftRef.current
      const staged = d !== undefined ? await d.waitForUploads() : []
      const attachments = [...extractAttachments(message), ...staged]
      if (text.length === 0 && attachments.length === 0) return
      await controller.send(text, attachments.length > 0 ? attachments : undefined)
      d?.clear()
    },
    [controller],
  )

  // Memoize the ExternalStore adapter so its object IDENTITY only changes when
  // the messages / running state actually change. assistant-ui's
  // `useExternalStoreRuntime` calls `runtime.setAdapter(store)` in an effect on
  // EVERY render; its first line is `if (this._store === store) return`, so a
  // fresh object literal (the old code) re-ran the full adapter sync + a
  // `_notifySubscribers()` on every unrelated re-render (draft edits, StrictMode
  // double-invoke, parent renders). That notify storm is what tripped React's
  // "getSnapshot should be cached to avoid an infinite loop" warning — the
  // runtime's `getState()` returns a fresh object each call, so a redundant
  // notify makes two consecutive snapshots differ. A stable identity lets
  // `setAdapter` early-return when nothing changed.
  const adapter = useMemo(
    () => ({
      messages: vm.messages,
      isRunning: vm.isRunning,
      convertMessage,
      onNew,
    }),
    [vm.messages, vm.isRunning, convertMessage, onNew],
  )

  const runtime = useExternalStoreRuntime<RenderMessage>(adapter)

  return { runtime, vm }
}
