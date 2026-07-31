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
 */

import { useLocalSearchParams, usePathname } from 'expo-router';

import { ChatSyncSurface } from '../../../components/ChatSyncSurface';
import { projectIdFromPathname } from '../../../lib/project-rail-view';

export default function ProjectChatTab(): React.JSX.Element {
  const params = useLocalSearchParams<{ id: string; prefill?: string; autosend?: string }>();
  const pathname = usePathname();
  // THE SCOPE COMES FROM THE PATH, exactly as the shell around this screen
  // resolves it (`_layout.tsx` `projectIdFromPathname`) — because the route
  // PARAM was observed on device to go stale across a project switch while the
  // layout stayed mounted, and a transcript rendered for a different project
  // than the header and rail name is worse than no transcript. The param is the
  // fallback for a non-project route; the query params below still come from it.
  const projectId =
    projectIdFromPathname(pathname) ?? (typeof params.id === 'string' ? params.id : '');
  const prefill = typeof params.prefill === 'string' ? params.prefill : '';
  const autosend = typeof params.autosend === 'string' ? params.autosend : '';
  return (
    <ChatSyncSurface
      projectId={projectId}
      {...(prefill.length > 0 ? { initialPrefill: prefill } : {})}
      {...(autosend.length > 0 ? { initialAutosend: autosend } : {})}
    />
  );
}
