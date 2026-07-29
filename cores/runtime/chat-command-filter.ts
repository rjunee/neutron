/**
 * @neutronai/cores-runtime — shared Core chat-command-filter contract.
 *
 * Refactor X4 (item 3). L2 relocated the gateway's `ChatCommandFilter`
 * consumer contract into the node-free `@neutronai/contracts` leaf, and
 * flagged that the bundled cores each declared a structurally-identical but
 * INDEPENDENT clone (`ResearchChatCommandFilter`, `EmailChatCommandFilter`,
 * `ScrapingChatCommandFilter`). This is the ONE shared producer type those
 * clones collapse onto.
 *
 * Why a cores-band generic rather than importing the contracts leaf
 * directly: the leaf's `ChatCommandFilterResult` is the narrow gateway
 * boundary (`{ text, data?, deep_link?, error?: {code,message} }`). The
 * cores produce RICHER results — research attaches a typed `card`, email's
 * `error` carries a `draft_id` — so they need a generic
 * `CoreChatCommandFilter<Card, Err>`. The generic stays STRUCTURALLY
 * assignable to the leaf contract (extra optional fields only), so each
 * core's wiring can still hand its filter to the gateway app-ws surface
 * unchanged.
 */

/** Inbound shape — identical across every bundled core. */
export interface CoreChatCommandFilterInput {
  user_id: string
  project_slug: string
  channel_topic_id: string
  project_id?: string
  body: string
}

/** Base structured error; cores may extend it (e.g. email adds `draft_id`). */
export interface CoreChatCommandFilterError {
  code: string
  message: string
}

/**
 * Result of a matched Core chat command. `Card` is the optional typed
 * render card a core attaches (`never` = none); `Err` is the structured
 * error shape (default {@link CoreChatCommandFilterError}).
 */
export interface CoreChatCommandFilterResult<
  Card = never,
  Err extends CoreChatCommandFilterError = CoreChatCommandFilterError,
> {
  text: string
  data?: unknown
  card?: Card
  deep_link?: string
  error?: Err
}

/**
 * A Core's chat-command filter: `match` returns a result when the inbound
 * body is one of the Core's commands, or `null` to fall through to LLM
 * dispatch.
 */
export interface CoreChatCommandFilter<
  Card = never,
  Err extends CoreChatCommandFilterError = CoreChatCommandFilterError,
> {
  match(
    input: CoreChatCommandFilterInput,
  ): Promise<CoreChatCommandFilterResult<Card, Err> | null>
}
