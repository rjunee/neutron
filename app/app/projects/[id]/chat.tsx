/**
 * @neutronai/app — the project's Chat tab route.
 *
 * The single native chat surface. Renders {@link ChatSyncSurface} — the
 * Telegram-grade FlashList + chat-core durable-transport surface (offline
 * send, gap-free resume, reactions/edits/receipts, rich agent rendering,
 * upload pipeline). The legacy streaming surface + its `chat-state`/`ws-client`
 * transport were deleted in the 2026-06-29 chat-collapse; there is no second
 * surface and no flag.
 *
 * ISSUE #17 — the launcher long-press dispatch rides in as query params:
 * `?prefill=<prefix>` mounts the composer pre-populated (`chat_send_prefix`),
 * `?autosend=<text>` fires one send once the socket connects (`chat_send`).
 *
 * `?message_id=<id>` is the PUSH TAP's landing instruction — the message the
 * notification was about (`app/lib/push-deep-link-dispatch.ts`). It reached this
 * route for months with nothing reading it, so a tap opened the chat and left the
 * owner wherever he last was; the surface anchors on it now.
 */

import { useLocalSearchParams, usePathname } from 'expo-router';

import { ChatSyncSurface } from '../../../components/ChatSyncSurface';
import { projectIdFromPathname } from '../../../lib/project-rail-view';

export default function ProjectChatTab(): React.JSX.Element {
  const params = useLocalSearchParams<{
    id: string;
    prefill?: string;
    autosend?: string;
    message_id?: string;
  }>();
  const pathname = usePathname();
  // THE SCOPE COMES FROM THE PATH, exactly as the shell around this screen
  // resolves it (`_layout.tsx` `projectIdFromPathname`) — ONE authority for
  // "which project", so the transcript can never disagree with the header and
  // rail that frame it. A transcript rendered for a different project than the
  // chrome names is worse than no transcript.
  //
  // WHICH SIDE WENT STALE, stated exactly, because this comment used to claim the
  // opposite and the confusion invited a hunt for a bug that is not here: the
  // staleness was the LAYOUT's. `useLocalSearchParams` is sticky in a component
  // that stays MOUNTED across the navigation, and switching projects keeps the
  // layout mounted while re-rendering this screen — so the layout kept reporting
  // the old id while this screen already saw the new one (`docs/AS_BUILT.md`
  // 2026-07 "tapping General swapped the transcript but left the header on the
  // previous project"). This screen reads the path for AGREEMENT with the shell,
  // not because its own params were ever observed to lag.
  //
  // That is also why `message_id` below is safe to read from the param. It is the
  // freshly-rendered side, so re-entering this scope without the query param does
  // not resurrect a previous tap's target and re-anchor an ordinary open onto an
  // old row (the #505/#511 class). Two independent latches would blunt it even if
  // that changed — `ChatSyncSurface` keys its frozen anchor on the target and
  // latches `honouredDeepLink` once per id — but the param being fresh is the
  // reason, and a future router upgrade that makes child params sticky would need
  // this line reconsidered rather than those latches trusted.
  // The param stays the fallback for a non-project route.
  const projectId =
    projectIdFromPathname(pathname) ?? (typeof params.id === 'string' ? params.id : '');
  const prefill = typeof params.prefill === 'string' ? params.prefill : '';
  const autosend = typeof params.autosend === 'string' ? params.autosend : '';
  const messageId = typeof params.message_id === 'string' ? params.message_id : '';
  return (
    <ChatSyncSurface
      projectId={projectId}
      {...(prefill.length > 0 ? { initialPrefill: prefill } : {})}
      {...(autosend.length > 0 ? { initialAutosend: autosend } : {})}
      {...(messageId.length > 0 ? { targetMessageId: messageId } : {})}
    />
  );
}
