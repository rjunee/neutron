/**
 * @neutronai/connect — group-chat agent ENGAGEMENT MODE (per-project).
 *
 * The Claude-Tag-style "stay quiet until tagged" switch for a Connect shared
 * project. Spec: `docs/specs/connect-agent-engagement-mode-2026-06-26.md`
 * (grounds: connect-spec §1.5 routing, §4 attribution, §1.4 read/write access).
 *
 * A shared project carries one `agent_engagement_mode` (stored on the
 * `projects` row — migration 0088):
 *
 *   - `all_messages`  — every member post auto-routes to the shared agent
 *                       session (the current behaviour; the DEFAULT, so a group
 *                       project behaves like a single-person chat out of the
 *                       box — Ryan-confirmed 2026-06-26).
 *   - `tag_gated`     — the agent engages ONLY when a member @-mentions it
 *                       (`@neutron`); members converse freely otherwise.
 *
 * This module is PURE (no I/O, no imports) so it can be unit-tested in
 * isolation and reused at BOTH the routing seam (the chat-bridge agent-turn
 * trigger) and the project-settings surface. It contains three pieces:
 *
 *   1. The mode vocabulary + a type guard.
 *   2. `detectAgentMention` — the `@neutron` chat-mention detector
 *      (case-insensitive, handle/alias aware, doc-quote guarded).
 *   3. `resolveEngagement` — the gate: (mode, text, member access) → engage?
 *   4. `classifyTaggedIntent` — inline-answer vs delegate-to-subagent split
 *      for a tagged turn (rides the gap#3 agent-dispatch family).
 *
 * IMPORTANT (spec §2): the gate decides ONLY whether to TRIGGER an agent turn.
 * The shared transcript ALWAYS persists every message in both modes — humans
 * still see each other and the agent has the conversation as context the next
 * time it IS tagged. Persistence is the caller's job; this module never gates
 * it.
 */

/** The two engagement modes a shared project can be in (spec, Ryan-locked). */
export type AgentEngagementMode = 'tag_gated' | 'all_messages'

/** Every valid mode — iterated by the settings PATCH validator + tests. */
export const ALL_AGENT_ENGAGEMENT_MODES: readonly AgentEngagementMode[] = [
  'tag_gated',
  'all_messages',
]

/**
 * The schema + write-side default. A new shared project behaves like a
 * single-person chat (the agent sees every message) until the owner opts into
 * `tag_gated` (spec §"DEFAULT", Ryan 2026-06-26). Existing projects therefore
 * need no behaviour change.
 */
export const DEFAULT_AGENT_ENGAGEMENT_MODE: AgentEngagementMode = 'all_messages'

/** Narrow an untrusted value (wire body / DB read) to a valid mode. */
export function isAgentEngagementMode(value: unknown): value is AgentEngagementMode {
  return value === 'tag_gated' || value === 'all_messages'
}

/**
 * The handles/aliases (WITHOUT the leading `@`) that trigger the agent in
 * `tag_gated` mode. Matched case-insensitively. The product handle is
 * `neutron`; `claude` is kept as a courtesy alias (the underlying model the
 * group is talking to) so a member who tags the model by name still engages.
 */
export const DEFAULT_AGENT_HANDLES: readonly string[] = ['neutron', 'claude']

export interface MentionDetectOptions {
  /** Override the handle/alias set. Empty/undefined → DEFAULT_AGENT_HANDLES. */
  handles?: readonly string[]
}

/**
 * Strip the spans where an `@mention` is a QUOTE, not an address: fenced code
 * blocks (```…```), inline code (`…`), and blockquote lines (`> …`). Same
 * doc-quote-guard principle the PTY detectors use — a member pasting
 * "the docs say `@neutron does X`" or quoting an earlier line must NOT trip an
 * agent turn. We blank the spans (replace with spaces, preserving nothing that
 * could match) rather than delete them.
 */
function stripQuotedSpans(text: string): string {
  // Fenced code blocks first (greedy per-fence), then inline code, then
  // blockquote lines. Order matters: a ``` fence can contain backticks.
  let out = text.replace(/```[\s\S]*?```/g, ' ')
  out = out.replace(/`[^`]*`/g, ' ')
  out = out
    .split('\n')
    .map((line) => (/^\s*>/.test(line) ? ' ' : line))
    .join('\n')
  return out
}

/** Escape a handle for safe embedding in the mention RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Detect an `@<handle>` chat-mention of the agent in `text`.
 *
 * Rules (spec §3):
 *   - case-insensitive;
 *   - matches any configured handle/alias;
 *   - a mention inside inline-code / fenced-code / blockquote is IGNORED
 *     (doc-quote guard);
 *   - the handle must be followed by a non-word char or end-of-string, so
 *     `@neutron` and `@Neutron!` match but `@neutrons` / `@neutron_bot` do not;
 *   - multiple mentions collapse to a single trigger (this returns a boolean).
 *
 * Returns `true` iff the agent is addressed.
 */
export function detectAgentMention(
  text: string,
  options: MentionDetectOptions = {},
): boolean {
  if (typeof text !== 'string' || text.length === 0) return false
  const handles =
    options.handles !== undefined && options.handles.length > 0
      ? options.handles
      : DEFAULT_AGENT_HANDLES
  const scanned = stripQuotedSpans(text)
  const alternation = handles.map((h) => escapeRegExp(h)).join('|')
  // `@(handle)` not followed by another word char (so `@neutrons` won't match)
  // and not part of an email (`a@neutron.com` → preceded by a word char →
  // rejected by the leading boundary).
  const re = new RegExp(`(^|[^\\w@])@(?:${alternation})(?![\\w])`, 'i')
  return re.test(scanned)
}

/** A member's session-post capability (connect-spec §1.4). */
export type MemberAccess = 'read' | 'write'

export interface EngagementInput {
  mode: AgentEngagementMode
  /** The member's post text. */
  text: string
  /**
   * The posting member's access (connect-spec §1.4). A `read` member cannot
   * drive agent turns even by @-mentioning (spec edge case — confirmed: no
   * trigger). Defaults to `write` (the owner / a write collaborator).
   */
  access?: MemberAccess
  /** Override the agent handle/alias set used for mention detection. */
  handles?: readonly string[]
}

/** Why the gate decided the way it did (audit + tests + structured logs). */
export type EngagementReason =
  | 'all_messages'
  | 'mention'
  | 'no_mention'
  | 'read_only_member'

export interface EngagementDecision {
  /** Whether to TRIGGER an agent turn for this post. */
  engage: boolean
  reason: EngagementReason
  /** Whether the post @-mentioned the agent (independent of `engage`). */
  mentioned: boolean
}

/**
 * The routing gate (spec §2). Decides whether a member post should trigger an
 * agent turn. NEVER gates transcript persistence — the caller persists every
 * message regardless of this decision.
 *
 *   - read-only member → never engages (defense-in-depth; a `read` member's
 *     POST is already refused at the post boundary, §1.4);
 *   - `all_messages`   → always engages;
 *   - `tag_gated`      → engages iff the post @-mentions the agent.
 */
export function resolveEngagement(input: EngagementInput): EngagementDecision {
  const mentioned = detectAgentMention(
    input.text,
    input.handles !== undefined ? { handles: input.handles } : {},
  )
  if (input.access === 'read') {
    return { engage: false, reason: 'read_only_member', mentioned }
  }
  if (input.mode === 'all_messages') {
    return { engage: true, reason: 'all_messages', mentioned }
  }
  // tag_gated
  return {
    engage: mentioned,
    reason: mentioned ? 'mention' : 'no_mention',
    mentioned,
  }
}

/** A delegated dispatch kind (mirrors agent-dispatch `DispatchKind`). */
export type TaggedDispatchKind = 'research' | 'review' | 'adhoc'

export type TaggedIntent = 'inline' | 'delegate'

export interface TaggedIntentResult {
  /** `inline` → answer on the shared session; `delegate` → spawn a subagent. */
  intent: TaggedIntent
  /** The task text with the @mention + any `/delegate` prefix stripped. */
  task: string
  /** Dispatch kind when `intent==='delegate'` (the agent-dispatch family). */
  kind: TaggedDispatchKind
}

/**
 * Imperative verbs that mark a tagged turn as a TASK worth delegating to a
 * background subagent rather than answering inline. Deliberately small +
 * explainable (spec §4: "Forge decides the inline-vs-dispatch boundary").
 */
const DELEGATE_VERB_RE =
  /^(?:build|create|implement|fix|refactor|write|draft|set up|set-up|research|investigate|analy[sz]e|audit|review|find|look into|look-into|figure out|figure-out|go (?:and )?|run|generate|compile|summari[sz]e|compare|design|plan|scaffold|migrate|port)\b/i

const RESEARCH_HINT_RE = /\b(research|investigate|look into|find out|dig into)\b/i
const REVIEW_HINT_RE = /\b(review|audit|critique|check over|go over)\b/i

/**
 * Split a tagged turn into "answer inline" vs "delegate to a subagent" (spec
 * §4 — tag-to-delegate rides the gap#3 agent-dispatch family).
 *
 *   - An explicit `/delegate [research|review] <task>` (or `/dispatch …`)
 *     prefix ALWAYS delegates, honouring an explicit kind.
 *   - Otherwise the heuristic: a leading imperative verb ("build X",
 *     "research Y") → delegate; a short conversational tag ("@neutron what's
 *     the status?") → inline.
 *   - The returned `task` has the leading `@handle` mention(s) and any
 *     `/delegate` prefix stripped, ready to hand to the dispatcher.
 */
export function classifyTaggedIntent(
  text: string,
  options: MentionDetectOptions = {},
): TaggedIntentResult {
  const handles =
    options.handles !== undefined && options.handles.length > 0
      ? options.handles
      : DEFAULT_AGENT_HANDLES
  const alternation = handles.map((h) => escapeRegExp(h)).join('|')
  // Strip every leading `@handle` token (one or more) + surrounding space.
  const mentionRe = new RegExp(`^\\s*(?:@(?:${alternation})\\b[\\s,:;-]*)+`, 'i')
  let body = text.replace(mentionRe, '').trim()

  // Explicit override: `/delegate`, `/dispatch`, or `/delegate research …`.
  const explicit = /^\/(?:delegate|dispatch)\b\s*/i.exec(body)
  if (explicit !== null) {
    let rest = body.slice(explicit[0].length).trim()
    let kind: TaggedDispatchKind = 'adhoc'
    const kindMatch = /^(research|review|adhoc)\b\s*/i.exec(rest)
    if (kindMatch !== null && kindMatch[1] !== undefined) {
      kind = kindMatch[1].toLowerCase() as TaggedDispatchKind
      rest = rest.slice(kindMatch[0].length).trim()
    }
    return { intent: 'delegate', task: rest.length > 0 ? rest : body, kind }
  }

  if (DELEGATE_VERB_RE.test(body)) {
    const kind: TaggedDispatchKind = RESEARCH_HINT_RE.test(body)
      ? 'research'
      : REVIEW_HINT_RE.test(body)
        ? 'review'
        : 'adhoc'
    return { intent: 'delegate', task: body, kind }
  }

  // Conversational tag → answer inline on the shared session.
  if (body.length === 0) body = text.trim()
  return { intent: 'inline', task: body, kind: 'adhoc' }
}
