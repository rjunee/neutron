/**
 * @neutronai/contracts — chat command-filter shape (L2 leaf).
 *
 * L2 (2026-07) — `ChatCommandFilter` + `ChatCommandFilterResult` extracted
 * VERBATIM out of `gateway/http/app-ws-surface.ts` into this node-free leaf
 * (critic-layering.md §5 "stranded contract types"). `app-ws-surface.ts`
 * re-exports both so existing import specifiers stay valid (test-policy
 * §2.2 barrel rule).
 *
 * NOTE: four in-core packages (`skill-forge`, `research`, `scraping`,
 * `email`) each declare a STRUCTURALLY IDENTICAL but INDEPENDENT clone of
 * this shape (`SkillForgeChatCommandFilter`, `ResearchChatCommandFilter`,
 * etc. — none of them import this type). Those clones are untouched by this
 * move; unifying them onto this leaf is out of scope for L2 (pure
 * relocation only, zero behavior change).
 */

/**
 * Pre-dispatch chat-command filter. Returns a non-null response when
 * the inbound is a recognised command (e.g. `/remind <body>`); the
 * surface posts the response back via the session registry and SKIPS
 * `adapter.dispatchInbound` so the LLM path doesn't fire. Returning
 * `null` lets the inbound fall through to the normal LLM dispatch.
 */
export interface ChatCommandFilter {
  match(input: {
    user_id: string
    project_slug: string
    channel_topic_id: string
    project_id?: string
    body: string
  }): Promise<ChatCommandFilterResult | null>
}

export interface ChatCommandFilterResult {
  /** A short reply line for the chat surface to render. */
  text: string
  /** Optional structured payload (search hits, drawer list, etc.). */
  data?: unknown
  /** Optional deep-link the channel may surface as a tap target. */
  deep_link?: string
  /** Populated only when the command was malformed or denied. */
  error?: { code: string; message: string }
}
