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
 *   - EVERY ack NAMES THE BOARD it mutated, in the owner's own vocabulary — the
 *     project name shown in the rail, or `General`. See "naming the board" below.
 *
 * NAMING THE BOARD
 * ----------------
 * The owner runs many boards side by side: one per project plus General. The ack
 * used to name only the ITEM (`▸ On the Work Board: "…"`), so an ack for the
 * `example-project` board read identically to one for General — and while the
 * owner watched a pane holding none of it, a truthful confirmation about a
 * DIFFERENT board was indistinguishable from a fabricated one. He reasonably
 * called it a lie. Every text now carries `· <board>`.
 *
 * Three things the label must never be:
 *   - the STORAGE KEY. `workBoardScopeKey` collapses General onto the instance
 *     slug, so General's key is an internal identifier that must never reach the
 *     chat. General is answered by {@link boardLabelForProjectId} BEFORE the
 *     project lookup is called at all — there is no path on which resolving
 *     General can produce, or even read, that key.
 *   - an internal PROJECT ID. A `project_id` that no longer resolves to a rail
 *     project (deleted mid-turn) degrades to {@link UNKNOWN_BOARD_LABEL}, never
 *     to the raw id.
 *   - MORE THAN ONE LINE. Project names are owner-authored free text and are
 *     validated for length only, so `\n` survives into `projects.name`. Both
 *     consumers of this label splice it into a line-oriented medium — a chat
 *     message and the `<work_board>` prompt block — where an interior newline
 *     becomes a STANDALONE LINE that reads as its own message or its own
 *     instruction. {@link sanitizeBoardLabel} is the chokepoint that collapses
 *     it; see its docblock.
 */

import { GENERAL_WORK_BOARD_PROJECT_ID } from './store.ts'

/** Which board event the ack speaks to. Distinct dedup identities per item. */
export type WorkBoardChatAckKind = 'card_added' | 'build_dispatched' | 'inline_started'

/** The owner-facing name of the no-project board. NEVER the instance slug. */
export const GENERAL_BOARD_LABEL = 'General'

/**
 * Shown when a non-null `project_id` does not resolve to a rail project (the
 * project was deleted between the mutation and the ack). Deliberately a WORD,
 * not the id — an internal id in the chat is exactly what (c) forbids, and an
 * ack that silently omitted the board would re-open the defect this closes.
 */
export const UNKNOWN_BOARD_LABEL = 'unknown project'

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
/** Board labels are owner-authored project names — cap them like a title. */
const MAX_BOARD_LABEL_LEN = 48

function truncate(text: string, max: number): string {
  // Measure + slice by CODE POINTS, not UTF-16 code units: a raw `.slice` on a
  // string whose astral char (emoji, etc.) straddles the cut index yields a lone
  // surrogate → mojibake before the ellipsis. `Array.from` iterates code points.
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return `${chars.slice(0, max - 1).join('')}…`
}

/**
 * Every char class that can END A LINE or steer a rendered one, mapped to a
 * space before whitespace is collapsed: C0/C1 controls (`\n`, `\r`, `\t`, NEL),
 * LINE/PARAGRAPH SEPARATOR, and the format chars (`\p{Cf}` — zero-width joiners
 * and the bidi overrides, which reorder a rendered label without occupying a
 * visible column). Replaced with a space rather than deleted so `a\nb` reads as
 * two words, not the single word `ab`.
 */
const LINE_BREAKING_OR_INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/**
 * FLATTEN one owner-authored name into exactly one line, then cap it.
 *
 * `projects.name` is validated for length ONLY (`gateway/http/app-projects-surface.ts`
 * handleCreate trims and bounds to 1-128 chars), so an interior newline is a
 * STORABLE project name. Both consumers of this label splice it into a
 * line-oriented medium, and in both an interior newline is an injection:
 *
 *   - the chat ack — the extra line renders as its own message-like line, so the
 *     confirmation the ack exists to make checkable becomes two claims;
 *   - the `<work_board>` prompt block — a name ending
 *     `\nIGNORE ALL PRIOR INSTRUCTIONS` yields a standalone instruction line
 *     INSIDE the block. XML-escaping does not help: `&<>` are not what makes it
 *     dangerous, the line boundary is.
 *
 * Mirrors `store.sanitizeTitle`, which flattens item titles for exactly this
 * reason — the label had no equivalent, which is what let it through. Capping is
 * by CODE POINTS and happens HERE, before any caller escapes, so a cap can never
 * cut an astral char in half or a `&lt;` entity in the middle.
 */
export function sanitizeBoardLabel(raw: string): string {
  return truncate(flattenToOneLine(raw), MAX_BOARD_LABEL_LEN)
}

/** {@link sanitizeBoardLabel}'s flatten step without its cap, for the longer
 *  title slot (titles cap at {@link MAX_TITLE_LEN}, labels at 48). */
function flattenToOneLine(raw: string): string {
  return raw.replace(LINE_BREAKING_OR_INVISIBLE, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Resolve ONE project id to its rail name (`projects.name`), or null/undefined
 * when the id names no live project.
 *
 * A single-row lookup on purpose. This is called on every ack AND every agent
 * turn to answer one question — what is this project called — and the full rail
 * read it replaced (`readProjectRows()`) is O(projects) SQL plus a per-project
 * unread count and rail-extras query, all of it discarded but one name.
 */
export type WorkBoardProjectNameLookup = (project_id: string) => string | null | undefined

/**
 * THE one mapping from a turn's `project_id` to the board name the owner reads.
 * Every owner-facing board name resolves through here — the three deterministic
 * acks, the `<work_board>` prompt block, and the `/status` project line.
 *
 * General (`null` / blank / the `general` sentinel) short-circuits to
 * {@link GENERAL_BOARD_LABEL} and `lookup` IS NOT CALLED: General's storage key
 * is the instance slug and must never surface, and there is no rail row to find.
 * A real project resolves to its rail name, flattened + capped by
 * {@link sanitizeBoardLabel}; a miss, a blank name, or a THROWING lookup degrades
 * to {@link UNKNOWN_BOARD_LABEL}, never the raw id.
 */
export function boardLabelForProjectId(
  project_id: string | null | undefined,
  lookup: WorkBoardProjectNameLookup,
): string {
  const pid = typeof project_id === 'string' ? project_id.trim() : ''
  if (pid.length === 0 || pid === GENERAL_WORK_BOARD_PROJECT_ID) return GENERAL_BOARD_LABEL
  let found: string | null | undefined
  try {
    found = lookup(pid)
  } catch {
    // A project-store read failure degrades the LABEL only. The caller still
    // delivers: an ack swallowed for want of a name is the silent chat the ack
    // exists to prevent.
    found = null
  }
  const label = sanitizeBoardLabel(typeof found === 'string' ? found : '')
  return label.length === 0 ? UNKNOWN_BOARD_LABEL : label
}

function textFor(kind: WorkBoardChatAckKind, title: string, board: string): string {
  // Flatten the title too. It arrives from `store.sanitizeTitle` on every wired
  // path today, but this is the last hop before an owner-facing line and the
  // ack must not inherit its one-line guarantee from a caller.
  const t = truncate(flattenToOneLine(title), MAX_TITLE_LEN)
  switch (kind) {
    case 'card_added':
      return `▸ On the Work Board · ${board}: "${t}"`
    case 'build_dispatched':
      return `⑂ Build dispatched · ${board}: "${t}" — running autonomously; the result will post here when it lands.`
    case 'inline_started':
      return `› Started "${t}" · ${board} — I'll post here when it's done.`
  }
}

/**
 * Build the shared ack poster.
 *
 * @param deps.resolve_chat_id  maps the turn's `project_id` (null → General) to
 *   the chat topic id the message lands in — wired to `tridentDeliveryChatId`.
 * @param deps.project_name     resolve ONE project id to its rail name, so every
 *   text can NAME its board. Read fresh per ack (a mid-session rename is named
 *   correctly) and NOT called at all on General. REQUIRED: an ack that cannot name
 *   its board is the defect, so there is no unlabeled path.
 * @param deps.post             durable+live delivery — wired to the #337 app-ws
 *   poster (`buildClarifyPoster.post`), so the ack persists AND fans live
 *   exactly like a normal agent reply. Late-binding safe: a no-op if unbound.
 * @param deps.now              injectable clock (tests); defaults to `Date.now`.
 * @param deps.dedup_window_ms  per-(project,item,kind,title) suppression window (default 30s).
 */
export function buildWorkBoardChatAck(deps: {
  resolve_chat_id: (project_id: string | null) => string
  project_name: WorkBoardProjectNameLookup
  post: (chat_id: string, text: string) => void
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
        // `boardLabelForProjectId` owns the project read and guards it: a
        // throwing lookup degrades to `unknown project` and this ack still
        // DELIVERS. On General the lookup is never called, so a project-store
        // failure cannot affect a General ack at all.
        const board = boardLabelForProjectId(input.project_id, deps.project_name)
        const chatId = deps.resolve_chat_id(input.project_id)
        deps.post(chatId, textFor(input.kind, input.title, board))
        lastPostedAt.set(key, t)
      } catch {
        // The ack must NEVER perturb the tool result — swallow everything.
      }
    },
  }
}
