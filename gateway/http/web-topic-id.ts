/**
 * web-topic-id.ts — the synthetic web topic_id helper, extracted into a
 * dependency-free leaf so it can be shared without forcing importers to pull
 * in the `chat-bridge.ts` monolith.
 *
 * Extracted in R5 (audit P1-2) to break the
 * `gateway/http/chat-bridge.ts` ↔ `gateway/realmode-composer/build-onboarding-handoff.ts`
 * import cycle: the handoff builder only needed `webTopicId`, and chat-bridge
 * imported a constant back from the handoff builder. With `webTopicId` living
 * here, the handoff builder imports the leaf instead of chat-bridge, and
 * chat-bridge re-exports it so every existing `import { webTopicId } from
 * '.../chat-bridge.ts'` caller is unchanged.
 */

/**
 * Compute the synthetic web topic_id used to route prompts back to the
 * active socket. Stable per (project_slug, user_id) so a reconnect with
 * the same user_id resumes onto the same engine state.
 */
export function webTopicId(user_id: string): string {
  return `web:${user_id}`
}
