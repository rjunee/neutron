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
 *   - Per-(project_id, item_id, kind, title) dedup within a short window
 *     (default 30s): a store reconciliation or a double-fire cannot double-post
 *     the SAME event. But DIFFERENT kinds for the same item do NOT suppress each
 *     other — an add then a dispatch in one turn is a real two-step progression
 *     and posts both. project_id + title are in the key so UNBOUND dispatches
 *     (item_id='') don't collapse to one identity and silently swallow a second
 *     distinct build's ack.
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
const MAX_BOARD_LABEL_LEN = 48

/** The board every ack from the General surface belongs to. */
export const GENERAL_BOARD_LABEL = 'General'
/**
 * What a project that cannot be named degrades to.
 *
 * A WORD, never the raw id: an ack is chat copy the owner reads, and a uuid in it
 * is noise that also leaks an internal identifier into a message. A project
 * deleted mid-turn is the ordinary way to get here.
 */
export const UNKNOWN_BOARD_LABEL = 'unknown project'

/**
 * Which board an ack is about, as a word.
 *
 * `null` — the General surface — is answered WITHOUT calling `lookup`: General has
 * no row to find, so asking would be a guaranteed miss that renders as
 * `unknown project` for the one scope that is never unknown.
 */
export function boardLabelForProjectId(
  project_id: string | null,
  lookup: (project_id: string) => string | null,
): string {
  if (project_id === null || project_id.length === 0) return GENERAL_BOARD_LABEL
  let name: string | null = null
  try {
    name = lookup(project_id)
  } catch {
    // A naming failure must never cost the owner the ack itself.
    name = null
  }
  if (name === null) return UNKNOWN_BOARD_LABEL
  const label = truncateByGrapheme(name.trim(), MAX_BOARD_LABEL_LEN)
  return label.length === 0 ? UNKNOWN_BOARD_LABEL : label
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Truncate by GRAPHEME CLUSTER, not code point.
 *
 * Code points already fixed the lone-surrogate mojibake, but they still cut inside
 * a cluster: a flag is two regional indicators, a family emoji is several code
 * points joined by ZWJ, and `é` may be `e` + a combining accent. Slicing between
 * them yields half a flag, a stray accent, or a fragment of a family. `Intl.Segmenter`
 * is the only thing in the platform that knows where a user-perceived character ends.
 */
function truncateByGrapheme(text: string, max: number): string {
  const g = Array.from(GRAPHEME_SEGMENTER.segment(text), (part) => part.segment)
  if (g.length <= max) return text
  return `${g.slice(0, max - 1).join('')}…`
}

function truncateTitle(title: string): string {
  return truncateByGrapheme(title, MAX_TITLE_LEN)
}

function textFor(kind: WorkBoardChatAckKind, title: string, board: string): string {
  const t = truncateTitle(title)
  switch (kind) {
    case 'card_added':
      // NAMES THE BOARD. Without it an ack for a card added in one project is
      // indistinguishable from one added in another, and the owner cannot tell
      // from the message which board just changed.
      return `▸ On the Work Board · ${board}: "${t}"`
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
 * @param deps.dedup_window_ms  per-(project,item,kind,title) suppression window (default 30s).
 */
export function buildWorkBoardChatAck(deps: {
  resolve_chat_id: (project_id: string | null) => string
  post: (chat_id: string, text: string) => void
  /**
   * Resolve ONE project id to its rail name, so the ack can say which board it is
   * about. OPTIONAL: absent, every ack degrades to `unknown project` rather than
   * failing, which keeps an un-wired composition working exactly as before.
   */
  project_name?: (project_id: string) => string | null
  now?: () => number
  dedup_window_ms?: number
}): WorkBoardChatAck {
  const now = deps.now ?? (() => Date.now())
  const windowMs =
    typeof deps.dedup_window_ms === 'number' && deps.dedup_window_ms >= 0
      ? deps.dedup_window_ms
      : DEFAULT_DEDUP_WINDOW_MS
  // key = `${project_id}\0${item_id}\0${kind}\0${title}` → last-post epoch ms.
  // NUL joins keep the fields unambiguous regardless of their content. project_id
  // and title are BOTH in the key because an UNBOUND dispatch (no board item) has
  // item_id='' — keying on `${item_id}\0${kind}` alone collapsed EVERY unbound
  // build within a window to the single key `\0build_dispatched`, silently
  // suppressing the 2nd distinct unbound dispatch's ack (Argus r2 finding).
  // Adding project_id + title distinguishes different unbound builds (different
  // titles → different keys → both ack) while still deduping a genuine
  // double-fire of the SAME event (same project+item+kind+title within window).
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
        const key = `${input.project_id ?? ''}\0${input.item_id}\0${input.kind}\0${input.title}`
        const prev = lastPostedAt.get(key)
        if (prev !== undefined && t - prev < windowMs) return
        // Deliver FIRST, then record the dedup stamp — only a delivery that
        // actually happened should suppress a retry. If `resolve_chat_id` or
        // `post` throws, the catch swallows it and the stamp is NOT set, so the
        // next fire for this (item,kind) can still land instead of being muted
        // for the whole window with no ack ever delivered.
        const chatId = deps.resolve_chat_id(input.project_id)
        const lookup = deps.project_name ?? ((): string | null => null)
        const board = boardLabelForProjectId(input.project_id, lookup)
        deps.post(chatId, textFor(input.kind, input.title, board))
        lastPostedAt.set(key, t)
      } catch {
        // The ack must NEVER perturb the tool result — swallow everything.
      }
    },
  }
}
