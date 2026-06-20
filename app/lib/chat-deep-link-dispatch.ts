/**
 * @neutronai/app — pure dispatch helper for the ChatDeepLinkNavigator
 * (ISSUE #18).
 *
 * Lives in its own file so the bun-test suite can import the helper
 * WITHOUT pulling React / Expo Router into the test runtime (the app
 * workspace's node_modules are not installed in the gateway worktree
 * we run from). The React wrapper in `./chat-deep-link-navigator.tsx`
 * imports + delegates here.
 */

import type { ChatMessage } from './chat-streaming';

/**
 * Pure helper: walk `messages` once, push every agent-message
 * `deep_link` whose `id` has not yet been fired, and record the id in
 * the `seen` set. Returns the count of pushes fired (handy for the
 * unit test's assertions; the React wrapper ignores the return value).
 *
 * Idempotent across calls — re-invoking with the same (messages, seen)
 * pair fires zero additional pushes because every id is already in
 * `seen`.
 *
 * Only `kind === 'agent'` messages with `deep_link !== undefined` ever
 * trigger a push. User / system messages are ignored even if the
 * `ChatMessage` shape happens to carry a `deep_link` field.
 */
export function dispatchUnseenDeepLinks(
  messages: ReadonlyArray<ChatMessage>,
  seen: Set<string>,
  push: (href: string) => void,
): number {
  let fired = 0;
  for (const m of messages) {
    if (m.kind !== 'agent') continue;
    if (m.deep_link === undefined) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    push(m.deep_link);
    fired += 1;
  }
  return fired;
}
