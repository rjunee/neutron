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
 * NAMING THE BOARD (#502)
 * ----------------------
 * The owner runs many boards side by side: one per project plus General. The ack
 * used to name only the ITEM (`▸ On the Work Board: "…"`), so an ack for the
 * `example-project` board read identically to one for General — and while the
 * owner watched the General pane sit empty, a truthful confirmation about a
 * DIFFERENT board was indistinguishable from a fabricated one. He reasonably
 * called it a lie. Every text now carries `· <board>`.
 *
 * Two things the label must never be:
 *   - the STORAGE KEY. `workBoardScopeKey` collapses General onto the instance
 *     slug, so General's key is an internal identifier that must never reach the
 *     chat. General is answered by {@link boardLabelForProjectId} itself and the
 *     project list is never consulted for it.
 *   - an internal PROJECT ID. A `project_id` that no longer resolves to a rail
 *     project (deleted mid-turn) degrades to {@link UNKNOWN_BOARD_LABEL}, never
 *     to the raw id.
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

/** A minimal view of the project rail — `readProjectRows()` rows satisfy it. */
export interface WorkBoardProjectRow {
  id: string
  label: string
}

/**
 * THE one mapping from a turn's `project_id` to the board name the owner reads.
 *
 * General (`null` / blank / the `general` sentinel) short-circuits to
 * {@link GENERAL_BOARD_LABEL} WITHOUT consulting `projects` — General's storage
 * key is the instance slug and must never surface, and there is no rail row to
 * find. A real project resolves to its rail `label` (`projects.name`); a miss or
 * a blank name degrades to {@link UNKNOWN_BOARD_LABEL}, never the raw id.
 */
export function boardLabelForProjectId(
  project_id: string | null | undefined,
  projects: readonly WorkBoardProjectRow[],
): string {
  const pid = typeof project_id === 'string' ? project_id.trim() : ''
  if (pid.length === 0 || pid === GENERAL_WORK_BOARD_PROJECT_ID) return GENERAL_BOARD_LABEL
  const found = projects.find((p) => p.id === pid)?.label
  const label = typeof found === 'string' ? found.trim() : ''
  return label.length === 0 ? UNKNOWN_BOARD_LABEL : truncate(label, MAX_BOARD_LABEL_LEN)
}

function textFor(kind: WorkBoardChatAckKind, title: string, board: string): string {
  const t = truncate(title, MAX_TITLE_LEN)
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
 * @param deps.projects         the CURRENT project rail, read fresh per ack, so
 *   every text can NAME its board (#502) — wired to `readProjectRows()`. REQUIRED:
 *   an ack that cannot name its board is the defect, so there is no unlabeled path.
 * @param deps.post             durable+live delivery — wired to the #337 app-ws
 *   poster (`buildClarifyPoster.post`), so the ack persists AND fans live
 *   exactly like a normal agent reply. Late-binding safe: a no-op if unbound.
 * @param deps.now              injectable clock (tests); defaults to `Date.now`.
 * @param deps.dedup_window_ms  per-(project,item,kind,title) suppression window (default 30s).
 */
export function buildWorkBoardChatAck(deps: {
  resolve_chat_id: (project_id: string | null) => string
  projects: () => readonly WorkBoardProjectRow[]
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
        // Read the rail INSIDE its own try: a project-store read failure must
        // degrade to `unknown project` and still DELIVER, not swallow the whole
        // ack. (General does not depend on this list at all — an empty list
        // still resolves to `General`.)
        let projects: readonly WorkBoardProjectRow[] = []
        try {
          projects = deps.projects()
        } catch {
          /* best-effort — boardLabelForProjectId degrades on an empty list */
        }
        const board = boardLabelForProjectId(input.project_id, projects)
        const chatId = deps.resolve_chat_id(input.project_id)
        deps.post(chatId, textFor(input.kind, input.title, board))
        lastPostedAt.set(key, t)
      } catch {
        // The ack must NEVER perturb the tool result — swallow everything.
      }
    },
  }
}
