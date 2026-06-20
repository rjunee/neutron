/**
 * @neutronai/app — ChatDeepLinkNavigator (ISSUE #18).
 *
 * Single client-side consumer of the top-level `deep_link` field on the
 * `AppWsOutboundAgentMessage` envelope. Mounted as a sibling inside
 * `<ChatStateProvider>` in the chat route shell. On every new agent
 * message that carries a `deep_link !== undefined`, the navigator calls
 * `router.push(deep_link)` exactly once per `message_id` — a
 * `Set<string>` ref tracks which messages have already fired so a
 * re-render of the messages array does not double-navigate.
 *
 * Pure-helper split: the navigation decision lives in
 * `./chat-deep-link-dispatch.ts` (`dispatchUnseenDeepLinks`) so the
 * bun-test suite can exercise the de-dup logic without pulling React /
 * Expo Router into the test runtime — matches the existing test
 * pattern in `app/__tests__/` (component sources are inspected as text;
 * pure helpers are exercised directly).
 *
 * Decision rationale (per the plan's § Part C, decision rationale):
 * a dedicated navigator component keeps `chat-state.tsx` reducer-pure,
 * makes the navigation side-effect testable in isolation, and avoids
 * re-entrancy with the existing `useEffect` that owns the WS lifecycle.
 *
 * Mount-once invariant: the `seen` ref is component-instance-scoped, so
 * mounting two navigators inside the same `<ChatStateProvider>` would
 * double-fire navigation on the same message_id. Mount it exactly once
 * per provider.
 */

import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';

import { useChatState } from './chat-state';
import { dispatchUnseenDeepLinks } from './chat-deep-link-dispatch';

// Re-export the pure helper for backwards-compatible imports (the test
// suite imports it from this module historically).
export { dispatchUnseenDeepLinks } from './chat-deep-link-dispatch';

/**
 * React component. Mounted inside `<ChatStateProvider>` so
 * `useChatState()` returns the live messages array; uses Expo Router's
 * `useRouter().push` as the navigation primitive.
 */
export function ChatDeepLinkNavigator() {
  const { messages } = useChatState();
  const router = useRouter();
  const seen = useRef<Set<string>>(new Set());
  useEffect(() => {
    dispatchUnseenDeepLinks(messages, seen.current, (href) => {
      // `router.push` accepts a strongly typed href; `string` is
      // structurally acceptable but TS widens the parameter to the
      // Expo-router union, so we cast at the call boundary.
      router.push(href as Parameters<typeof router.push>[0]);
    });
  }, [messages, router]);
  return null;
}
