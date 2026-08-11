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
 *   - AMBIGUOUS BETWEEN TWO BOARDS. A label that two boards answer to is not a
 *     name; it is the defect wearing one. `general` is both the no-project
 *     sentinel and a legal project id, and the owner's box already has a project
 *     called `General` — so General and that project used to produce the SAME
 *     label, and the rail showed two rows with one name. {@link
 *     disambiguateProjectBoardLabel} qualifies the project side. The 48-char cap
 *     was a second route to the same place (two names sharing a long prefix capped
 *     to one label); {@link truncate} elides the MIDDLE so the distinguishing tail
 *     survives.
 *   - MORE THAN ONE LINE. Project names are owner-authored free text and are
 *     validated for length only, so `\n` survives into `projects.name`. Both
 *     consumers of this label splice it into a line-oriented medium — a chat
 *     message and the `<work_board>` prompt block — where an interior newline
 *     becomes a STANDALONE LINE that reads as its own message or its own
 *     instruction. {@link sanitizeBoardLabel} is the chokepoint that collapses
 *     it; see its docblock.
 */

import { normalizeBoardProjectId } from './store.ts'

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
export const MAX_BOARD_LABEL_LEN = 48

/** The elision mark {@link truncate} splices in. One grapheme, always visible. */
const ELLIPSIS = '…'

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Split into USER-PERCEIVED CHARACTERS (grapheme clusters), not code points.
 *
 * A code-point split is what shattered the emoji this module is specifically
 * hardened to keep whole: `👨‍💻` is THREE code points joined by a ZWJ, so a
 * code-point slice landing inside it emits a bare `👨` and drops the rest — the
 * board named back to the owner is not the board in his rail, which is the defect
 * {@link ZERO_WIDTH_JOINER} exists to prevent, reintroduced one layer down. A
 * grapheme split cuts only BETWEEN glyphs, so no sequence can be cut in half.
 */
function graphemes(text: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(text), (s) => s.segment)
}

/**
 * Cap `text` to `max` GRAPHEMES, eliding the MIDDLE and keeping the tail.
 *
 * WHY THE MIDDLE AND NOT THE TAIL. A head-only cap makes two DIFFERENT names
 * render as ONE label whenever they share a long prefix, and owner-authored names
 * are overwhelmingly prefix-shared with the distinguishing part at the END
 * (`… Review — Phase 1` / `… Phase 2`, `… — v1` / `… — v2`). Both used to cap to
 * the byte-identical `Q3 Financial Reporting and Compliance Review — …`, so the
 * ack named a board the owner could not tell from its sibling — this PR's defect
 * exactly, arriving through the length cap instead of through the mapping.
 * Keeping both ends makes that class distinguishable.
 *
 * NOT a uniqueness GUARANTEE, and deliberately not: two names differing ONLY
 * inside the elided middle still collapse. A guarantee needs a hash or an id
 * suffix, and neither is the owner's vocabulary — which is the requirement this
 * label exists to satisfy. The residual is recorded in the as-built note.
 */
function truncate(text: string, max: number): string {
  const g = graphemes(text)
  if (g.length <= max) return text
  // One grapheme is spent on the ellipsis; split the rest head-heavy so an odd
  // budget favours the beginning (where the name's subject usually is).
  const keep = max - 1
  const tail = Math.floor(keep / 2)
  const head = keep - tail
  const headText = g.slice(0, head).join('')
  return tail === 0 ? `${headText}${ELLIPSIS}` : `${headText}${ELLIPSIS}${g.slice(g.length - tail).join('')}`
}

/**
 * Every char class that can END A LINE or steer a rendered one: C0/C1 controls
 * (`\n`, `\r`, `\t`, NEL), LINE/PARAGRAPH SEPARATOR, and the format chars
 * (`\p{Cf}` — the bidi overrides, which reorder a rendered label without
 * occupying a visible column, plus soft hyphen and the zero-width spaces).
 * Neutralized to a SPACE rather than deleted so `a\nb` reads as two words, not
 * the single word `ab`.
 */
const LINE_BREAKING_OR_INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/**
 * ZERO WIDTH JOINER — in `\p{Cf}` with the bidi overrides, and the ONE member of
 * that class that is load-bearing content rather than a rendering instruction.
 * It is what binds a multi-codepoint emoji into one glyph, and emoji project
 * names are a first-class pattern here (`open/composer.ts` resolveProjectEmoji),
 * so blanket-spacing `\p{Cf}` shattered them: a project named `👨‍💻 Dev Work`
 * was acknowledged as `👨 💻 Dev Work` — the board named back to the owner was
 * not the board he can see in the rail, which is this whole PR's defect in
 * miniature. Kept verbatim; every other format char is still neutralized. ZWJ
 * cannot end a line and does not reorder anything, so keeping it costs nothing
 * the class was defending.
 */
const ZERO_WIDTH_JOINER = '\u200D'

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
 *
 * Returns `''` for a name with no VISIBLE content, which is what both callers'
 * floors test. Emptiness is deliberately NOT `length === 0`: {@link
 * ZERO_WIDTH_JOINER} is preserved (it is content inside an emoji), so a name of
 * nothing but joiners is a non-empty string that RENDERS AS NOTHING. Left to a
 * length test it walked straight past both floors and produced `· ` — a
 * board-naming line with no board named, which is the unnamed ack this PR exists
 * to remove, reintroduced by the exception that keeps emoji intact.
 */
export function sanitizeBoardLabel(raw: string): string {
  // FLOOR BEFORE CAP, and that order is the guard. `truncate` splices in a
  // VISIBLE ellipsis, so flooring the capped string asks "does this render as
  // anything?" of a string the cap just guaranteed renders as at least `…`: a name
  // of 47+ joiners passed the floor with visible content of exactly `"…"` and was
  // published as a board name. Flooring the FLATTENED-but-uncapped string asks the
  // question of the owner's actual name, which is what the floor is for.
  const flattened = flattenToOneLine(raw)
  if (!hasVisibleContent(flattened)) return ''
  return truncate(flattened, MAX_BOARD_LABEL_LEN)
}

/** Appended to a project name that would otherwise read as the General board. */
export const PROJECT_BOARD_SUFFIX = '(project)'

/**
 * Make a PROJECT's owner-facing name distinguishable from the General board.
 *
 * THE DEFECT THIS CLOSES. `general` is both the reserved no-project sentinel AND
 * a legal project id, and the owner's instance already has a real project called
 * `General` (`app/lib/project-rail-view.ts` records `GET /api/app/projects`
 * returning `id: 'general'` on his box). Reserving the SLUG — this PR's
 * `onboarding/wow-moment/project-identity.ts` — stops a NEW project minting that
 * id; it does nothing about the NAME, and the name is the whole owner-facing
 * problem. Before this, the General board and a project named `General` produced
 * the byte-identical label `General` from `boardLabelForProjectId`, and the two
 * rail rows read identically too. So the ack named a board, the owner looked at
 * the rail, and two rows answered to the name — which is indistinguishable from
 * the ack naming the wrong board.
 *
 * The PROJECT is disambiguated rather than General because General is the fixed,
 * unnameable board every instance has, and the project is the one the owner
 * chose the name of — so the qualifier lands on the thing that has an alternative.
 *
 * ONE rule, applied SERVER-SIDE at both seams that produce an owner-facing board
 * name — {@link boardLabelForProjectId} (the acks, the `<work_board>` block, the
 * `/status` line) and the project rail's `label` (`open/composer.ts`
 * `readProjectRows`, which BOTH the web and the mobile rail render verbatim). The
 * rail label is server-computed, so there is no client copy of this rule to drift
 * and no second spelling to keep in parity.
 *
 * Case- and whitespace-insensitive, on the FLATTENED name: `general`, `General `
 * and `General\n` all read as `General` to the owner, so all three collide. A
 * non-colliding name is returned UNTOUCHED (no flatten, no cap) — the rail shows
 * full names and this function must not quietly become a second cap.
 */
export function disambiguateProjectBoardLabel(name: string): string {
  const flattened = flattenToOneLine(name)
  return flattened.toLowerCase() === GENERAL_BOARD_LABEL.toLowerCase()
    ? `${name} ${PROJECT_BOARD_SUFFIX}`
    : name
}

/** Does this label render as anything at all? Joiners are invisible on their own. */
function hasVisibleContent(label: string): boolean {
  return label.split(ZERO_WIDTH_JOINER).join('').trim().length > 0
}

/** {@link sanitizeBoardLabel}'s flatten step without its cap, for the longer
 *  title slot (titles cap at {@link MAX_TITLE_LEN}, labels at 48). */
function flattenToOneLine(raw: string): string {
  return raw
    .replace(LINE_BREAKING_OR_INVISIBLE, (ch) => (ch === ZERO_WIDTH_JOINER ? ch : ' '))
    .replace(/\s+/g, ' ')
    .trim()
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
 * A real project resolves to its rail name, DISAMBIGUATED against the General
 * board by {@link disambiguateProjectBoardLabel} then flattened + capped by
 * {@link sanitizeBoardLabel}; a miss, a blank name, or a THROWING lookup degrades
 * to {@link UNKNOWN_BOARD_LABEL}, never the raw id.
 *
 * The value it returns is UNIQUE PER BOARD for the two cases the owner actually
 * hits — General vs a project named `General`, and two long names that differ at
 * the end — which is what makes an ack checkable against the rail. It is not
 * unique in general; see {@link truncate} for the residual and why closing it
 * would cost the owner's vocabulary.
 */
export function boardLabelForProjectId(
  project_id: string | null | undefined,
  lookup: WorkBoardProjectNameLookup,
): string {
  const pid = normalizeBoardProjectId(project_id)
  if (pid === null) return GENERAL_BOARD_LABEL
  let found: string | null | undefined
  try {
    found = lookup(pid)
  } catch {
    // A project-store read failure degrades the LABEL only. The caller still
    // delivers: an ack swallowed for want of a name is the silent chat the ack
    // exists to prevent.
    found = null
  }
  // Disambiguate BEFORE sanitizing: the collision test needs the owner's whole
  // name, and the suffix must be inside the cap's budget so a colliding name can
  // never be capped back down to the bare `General` it was distinguished from.
  const label = sanitizeBoardLabel(
    disambiguateProjectBoardLabel(typeof found === 'string' ? found : ''),
  )
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
 * @param deps.resolve_chat_id  maps a NORMALIZED board scope (`null` → General,
 *   never the `'general'` sentinel — see `normalizeBoardProjectId`) to the chat
 *   topic id the message lands in — wired to `tridentDeliveryChatId`. It receives
 *   the SAME normalized value the label is resolved from, which is the invariant
 *   that keeps the named board and the delivered-to board identical.
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
        // ONE normalization, threaded to BOTH the label and the destination, so
        // the board this ack NAMES and the topic it LANDS IN can never be
        // different boards. They were: the sentinel `'general'` (which is what a
        // live General turn actually carries — see `normalizeBoardProjectId`)
        // normalized to `General` in the label and to a per-project topic
        // `app:<owner>:general` in the routing, so the General surface never
        // received its own ack. Resolving the scope ONCE here is the fix; passing
        // `input.project_id` to `resolve_chat_id` is the bug.
        // `boardLabelForProjectId` owns the project read and guards it: a
        // throwing lookup degrades to `unknown project` and this ack still
        // DELIVERS. On General the lookup is never called, so a project-store
        // failure cannot affect a General ack at all.
        const scope = normalizeBoardProjectId(input.project_id)
        const board = boardLabelForProjectId(scope, deps.project_name)
        const chatId = deps.resolve_chat_id(scope)
        deps.post(chatId, textFor(input.kind, input.title, board))
        lastPostedAt.set(key, t)
      } catch {
        // The ack must NEVER perturb the tool result — swallow everything.
      }
    },
  }
}
