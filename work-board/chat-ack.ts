/**
 * @neutronai/work-board — deterministic chat-ack for chat-dispatched work.
 *
 * THE GAP this closes (#429 task 4)
 * ---------------------------------
 * The live agent is a warm Claude Code REPL whose ONLY chat output is the
 * dev-channel `reply()` tool — exactly ONE per turn, landing at TURN END. When
 * the owner asks for work from a project chat and the agent adds a Work Board
 * card / dispatches or starts a build INLINE in that same turn, the card pops
 * the Work pane instantly (store `onChange` → `work_board_changed` frame) but
 * the CHAT stays silent for the whole turn — up to 45 min for a long inline job
 * — because the single reply() has not landed yet. A spoken ack depended
 * entirely on the model choosing to speak.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * A tiny, side-effect-only poster the AGENT-TOOL layer calls the moment a
 * chat-dispatched board mutation succeeds, to put a short, deterministic,
 * agent-style confirmation into the ORIGINATING chat topic RIGHT AWAY —
 * independent of the turn's own reply(). It is delivered through the SAME
 * durable+live app-ws seam a normal reply uses (persists to the chat log + fans
 * to any open socket), so the message survives a reload and reads exactly like
 * the agent spoke it.
 *
 * INVARIANTS
 * ----------
 *   - NEVER throws. The ack is a courtesy on top of a tool result; a resolver
 *     or transport failure must never perturb the tool's return value. The whole
 *     body is try/catch-swallowed.
 *   - Per-(item_id, kind) dedup within a short window (default 30s): a store
 *     reconciliation or a double-fire cannot double-post the SAME event. But
 *     DIFFERENT kinds for the same item do NOT suppress each other — an add then
 *     a dispatch in one turn is a real two-step progression and posts both.
 *   - It only speaks for events the agent-tool layer hands it (agent adds,
 *     inline_active false→true flips, successful build dispatch/start). Human
 *     HTTP mutations and rejected dispatches post nothing — those callers simply
 *     never invoke it.
 */

/** Which board event the ack speaks to. Distinct dedup identities per item. */
export type WorkBoardChatAckKind = 'card_added' | 'build_dispatched' | 'inline_started'

export interface WorkBoardChatAckInput {
  /** The composing turn's ACTIVE project (null on the General surface). */
  project_id: string | null
  item_id: string
  title: string
  kind: WorkBoardChatAckKind
}

export interface WorkBoardChatAck {
  /** Post the ack for this event (deduped, never throws). Fire-and-forget. */
  post(input: WorkBoardChatAckInput): void
}

const DEFAULT_DEDUP_WINDOW_MS = 30_000
const MAX_TITLE_LEN = 96

function truncateTitle(title: string): string {
  // Measure + slice by CODE POINTS, not UTF-16 code units: a raw `.slice` on a
  // string whose astral char (emoji, etc.) straddles the cut index yields a lone
  // surrogate → mojibake before the ellipsis. `Array.from` iterates code points.
  const chars = Array.from(title)
  if (chars.length <= MAX_TITLE_LEN) return title
  return `${chars.slice(0, MAX_TITLE_LEN - 1).join('')}…`
}

function textFor(kind: WorkBoardChatAckKind, title: string): string {
  const t = truncateTitle(title)
  switch (kind) {
    case 'card_added':
      return `▸ On the Work Board: "${t}"`
    case 'build_dispatched':
      return `⑂ Build dispatched: "${t}" — running autonomously; the result will post here when it lands.`
    case 'inline_started':
      return `› Working on "${t}" now — I'll post here when it's done.`
  }
}

/**
 * Build the shared ack poster.
 *
 * @param deps.resolve_chat_id  maps the turn's `project_id` (null → General) to
 *   the chat topic id the message lands in — wired to `tridentDeliveryChatId`.
 * @param deps.post             durable+live delivery — wired to the #337 app-ws
 *   poster (`buildClarifyPoster.post`), so the ack persists AND fans live
 *   exactly like a normal agent reply. Late-binding safe: a no-op if unbound.
 * @param deps.now              injectable clock (tests); defaults to `Date.now`.
 * @param deps.dedup_window_ms  per-(item,kind) suppression window (default 30s).
 */
export function buildWorkBoardChatAck(deps: {
  resolve_chat_id: (project_id: string | null) => string
  post: (chat_id: string, text: string) => void
  now?: () => number
  dedup_window_ms?: number
}): WorkBoardChatAck {
  const now = deps.now ?? (() => Date.now())
  const windowMs =
    typeof deps.dedup_window_ms === 'number' && deps.dedup_window_ms >= 0
      ? deps.dedup_window_ms
      : DEFAULT_DEDUP_WINDOW_MS
  // key = `${item_id}\0${kind}` → last-post epoch ms. A NUL join keeps the
  // two fields unambiguous regardless of item-id content.
  const lastPostedAt = new Map<string, number>()

  return {
    post(input: WorkBoardChatAckInput): void {
      try {
        const t = now()
        // Lazily prune stale memo entries so the map can't grow unbounded on a
        // long-lived warm session.
        for (const [k, ts] of lastPostedAt) {
          if (t - ts >= windowMs) lastPostedAt.delete(k)
        }
        const key = `${input.item_id}\0${input.kind}`
        const prev = lastPostedAt.get(key)
        if (prev !== undefined && t - prev < windowMs) return
        // Deliver FIRST, then record the dedup stamp — only a delivery that
        // actually happened should suppress a retry. If `resolve_chat_id` or
        // `post` throws, the catch swallows it and the stamp is NOT set, so the
        // next fire for this (item,kind) can still land instead of being muted
        // for the whole window with no ack ever delivered.
        const chatId = deps.resolve_chat_id(input.project_id)
        deps.post(chatId, textFor(input.kind, input.title))
        lastPostedAt.set(key, t)
      } catch {
        // The ack must NEVER perturb the tool result — swallow everything.
      }
    },
  }
}
