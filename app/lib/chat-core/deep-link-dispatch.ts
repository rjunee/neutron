/**
 * @neutronai/app — pure deep-link dispatch over the chat-core transcript
 * (ISSUE #18, ported to the collapsed Telegram-grade surface).
 *
 * Walk the durable messages once and fire every agent message's top-level
 * `deep_link` whose `message_id` hasn't been navigated yet, recording it in
 * `seen`. Idempotent across calls (re-invoking with the same (messages, seen)
 * pair fires nothing new), so a re-render or a resume replay never
 * double-navigates. Pure (no React / Expo Router) so it's unit-testable
 * directly — the surface supplies `router.push` as the sink.
 *
 * Only `role === 'agent'` messages with a non-empty `deep_link` + a real
 * `message_id` ever trigger navigation.
 */

import type { ChatMessage } from '@neutron/chat-core';

export function dispatchUnseenDeepLinks(
  messages: ReadonlyArray<ChatMessage>,
  seen: Set<string>,
  push: (href: string) => void,
): number {
  let fired = 0;
  for (const m of messages) {
    if (m.role !== 'agent') continue;
    if (m.message_id === null) continue;
    if (m.deep_link === null || m.deep_link === undefined || m.deep_link.length === 0) continue;
    if (seen.has(m.message_id)) continue;
    seen.add(m.message_id);
    push(m.deep_link);
    fired += 1;
  }
  return fired;
}
