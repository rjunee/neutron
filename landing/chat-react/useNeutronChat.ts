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
import {
  useExternalStoreRuntime,
  type AppendMessage,
  type ExternalStoreAdapter,
} from '@assistant-ui/react'

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

/**
 * Mirror the controller's synchronous view-model into React state and drive its
 * lifecycle (start on mount, stop on unmount, pause/resume on tab visibility).
 *
 * This is DELIBERATELY separate from {@link useChatRuntime}: the controller
 * lifecycle is keyed on the controller instance and MUST survive a project
 * switch untouched (a switch re-scopes the same controller's socket — it does
 * NOT restart the controller), whereas the assistant-ui runtime is rebuilt
 * per-conversation (see {@link useChatRuntime}). Keeping them apart lets a
 * caller remount the runtime on `convId` change without ever tearing down the
 * subscription/lifecycle.
 */
export function useNeutronChatVm(controller: NeutronChatController): ChatViewModel {
  const [vm, setVm] = useState<ChatViewModel>(() => controller.getViewModel())

  useEffect(() => {
    const unsub = controller.subscribe(setVm)
    controller.start()
    const onVisibility = (): void => {
      controller.setActive(document.visibilityState === 'visible')
    }
    // W5 GAP-2 — the browser's network-regain signal. On `online`, tell the
    // controller (→ session → transport) to reset backoff and reconnect NOW,
    // instead of waiting out the exponential backoff after a flap. (The NATIVE
    // NetInfo equivalent is the documented W6 seam on the native bridge — only
    // the web `online` listener belongs here.)
    const onOnline = (): void => {
      controller.notifyReachable()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
      unsub()
      controller.stop()
    }
  }, [controller])

  return vm
}

/**
 * Build the MEMOIZED assistant-ui external-store adapter — the object whose
 * IDENTITY {@link useChatRuntime} hands to `useExternalStoreRuntime`.
 *
 * ⚠️ #354 BLANK-SCREEN CRASH GUARD — the stable identity of this object is the
 * load-bearing fix for the #354 crash. assistant-ui's `useExternalStoreRuntime`
 * runs `runtime.setAdapter(adapter)` in an effect on EVERY render, and that
 * method's FIRST line is `if (this._store === adapter) return`. If this hook
 * returned a fresh object literal per render (the pre-#162 bug), that guard
 * never hits → `setAdapter` calls `_notifySubscribers()` on every commit → the
 * assistant-ui `useSyncExternalStore` snapshots churn → in a real browser's
 * concurrent renderer this becomes a re-render storm ("Maximum update depth
 * exceeded" / "Tried to unmount a fiber that is already unmounted") → the
 * `ChatErrorBoundary` trips → BLANK SCREEN. Memoizing the adapter so its
 * identity only changes when `messages`/`isRunning` (or the stable callbacks)
 * actually change lets `setAdapter` early-return on unrelated re-renders, which
 * is what stops the storm. Do NOT inline this back into an object literal.
 *
 * (The residual React dev-only "getSnapshot should be cached" WARNING originates
 * INSIDE assistant-ui's `useRuntimeState` — its `getState()` returns a fresh
 * object — and cannot be silenced from here; on its own, without the notify
 * storm above, it does not loop. The regression coverage is
 * `__tests__/snapshot-stability.test.tsx`.)
 */
export function useChatAdapter(
  controller: NeutronChatController,
  vm: ChatViewModel,
  origin: string,
  draft?: AttachmentDraft,
): ExternalStoreAdapter<RenderMessage> {
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

  return adapter
}

/**
 * Build the assistant-ui `ExternalStoreRuntime` from the current view-model.
 *
 * SEV1 chat project-switch race (2026-07-02) — a project switch must mount a
 * FRESH runtime, NOT reuse a single stable one. The assistant-ui message
 * primitives resolve a part by INDEX into the runtime's live message list; if
 * the same runtime is retained across a switch, `controller.setProject` empties
 * `msgs` IN-PLACE and the shared runtime shrinks to length 0 while stale
 * `MessagePart` subscribers from the outgoing project still index into it →
 * `useClientLookup: Index N out of bounds (length: 0)` → the render throws and
 * the #162 error boundary trips. The caller therefore mounts the host that
 * calls THIS hook with `key={convId}` (see `ConversationRuntimeHost` in
 * ChatApp.tsx): each conversation gets its own runtime, the outgoing runtime is
 * discarded WHOLE (never shrunk in place), and the incoming one starts from the
 * already-scoped (empty → hydrating) `msgs` — so no part ever indexes a stale
 * position. This is the root-cause fix; the boundary stays only as a last
 * resort that now (essentially) never fires on a normal switch/load.
 */
export function useChatRuntime(
  controller: NeutronChatController,
  vm: ChatViewModel,
  origin: string,
  draft?: AttachmentDraft,
): ReturnType<typeof useExternalStoreRuntime> {
  const adapter = useChatAdapter(controller, vm, origin, draft)
  const runtime = useExternalStoreRuntime<RenderMessage>(adapter)

  return runtime
}

/**
 * Backward-compatible convenience wrapper: mirror the vm AND build a runtime in
 * one call. Retained for the test harnesses that predate the per-conversation
 * split; production code uses {@link useNeutronChatVm} + a `convId`-keyed host
 * that calls {@link useChatRuntime} so the runtime resets per conversation.
 */
export function useNeutronChat(
  controller: NeutronChatController,
  origin: string,
  draft?: AttachmentDraft,
): UseNeutronChat {
  const vm = useNeutronChatVm(controller)
  const runtime = useChatRuntime(controller, vm, origin, draft)
  return { runtime, vm }
}
