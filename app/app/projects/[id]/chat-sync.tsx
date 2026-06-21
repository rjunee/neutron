/**
 * @neutronai/app — project-scoped Telegram-grade chat route (mobile Phase 2,
 * research doc §6/§8). Renders the FlashList v2 + chat-core offline-sync
 * surface ({@link ChatSyncSurface}) inside the project shell's `<Slot/>`.
 *
 * This lands alongside the existing `chat.tsx` tab rather than replacing it:
 * chat-sync is the new local-store-backed surface (offline send, gap-free
 * reconnect, instant cold-open, push catch-up) reachable via
 * `router.push('/projects/<id>/chat-sync')`. It is intentionally NOT wired
 * into the locked 5-tab bar — the cutover happens once the surface reaches
 * full parity with the legacy tab.
 */

import { useLocalSearchParams } from 'expo-router';

import { ChatSyncSurface } from '../../../components/ChatSyncSurface';

export default function ChatSyncRoute(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const projectId = typeof id === 'string' ? id : '';
  return <ChatSyncSurface projectId={projectId} />;
}
