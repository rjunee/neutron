#!/usr/bin/env bun
/**
 * Stop hook for Neutron persistent-REPL sessions.
 *
 * LIFTED from Nova `gateway/hooks/enforce-reply.ts` (§ 1 #5,
 * ★ CORE-PRESERVED-VERBATIM). The transcript-walk, the `__reply` MCP-name
 * match, and the notice-exempt logic are byte-for-byte the Nova logic. The
 * block-reason wording is adapted (it no longer names a chat product — the
 * reply now resolves a substrate `completion` Event) and `SILENT_SYSTEM_META`
 * is inlined (Nova imported it from `gateway-core`). The continuation-promise
 * gate below is a PORT, not a copy: its delivered-reply rule is inverted
 * against Nova's because this runtime's delivery semantics differ (see
 * {@link deliveredReplyText}), and its escape hatches are this runtime's real
 * scheduling seams rather than Nova's.
 *
 * This hook is what guarantees EXACTLY-ONE `reply()` per channel turn, which
 * is what gives the bridge its clean 1:1 map to one `completion` Event
 * (brief § 3 SPRINT 1 deliverable #4).
 *
 * Claude Code fires this when the agent tries to end its turn. If the last
 * user message was a `<channel>` notification (injected by the dev-channel)
 * and the agent did not call the `reply` tool, we block the stop and force it
 * to continue. Without this, terminal-only output is invisible to the caller
 * and the turn never resolves a completion.
 *
 * TWO gates run here, and they catch different failures:
 *   1. NO REPLY AT ALL — the agent printed its answer to the terminal, where
 *      nobody can read it. (The original gate; unchanged.)
 *   2. A REPLY THAT PROMISES WORK IT NEVER DOES — "re-running now", "I'll fix
 *      and report back", "one sec". The agent posts an intent and ends the turn,
 *      and because a channel turn is asynchronous NOTHING re-invokes it. The
 *      owner gets silence until they ask for a status. This is the single most
 *      common way a session looks broken while being technically healthy.
 *
 * Gate 2 is ported from Nova's `gateway/hooks/enforce-reply.ts`, and most of
 * what it carries across is false-positive handling rather than pattern
 * matching: the delivered-reply rule, the quoted-span strip, and the
 * verb-as-noun lookbehind each exist because the naive version fired on innocent
 * text. A promise gate that cries wolf gets switched off, which is strictly
 * worse than no gate — so those mitigations are the load-bearing part, and each
 * one is pinned by a test.
 *
 * Input on stdin (Claude Code Stop hook payload):
 *   { session_id, transcript_path, stop_hook_active, ... }
 * Output on stdout (to block): { "decision": "block", "reason": "..." }
 * Exit 0 with no output = allow stop.
 */

import { appendFileSync } from 'node:fs'

/** Channel turns whose opening `<channel system="...">` tag matches one of
 *  these are informational (notices) and exempt from the reply requirement. */
const SILENT_SYSTEM_META = new Set(['true', 'notice'])

const LOG_FILE =
  process.env['NEUTRON_ENFORCE_REPLY_LOG'] ?? '/tmp/neutron-enforce-reply.log'

function log(line: string): void {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // best-effort logging
  }
}

interface HookInput {
  session_id?: string
  transcript_path?: string
  stop_hook_active?: boolean
}

interface TranscriptEntry {
  type?: string
  message?: {
    role?: string
    content?: unknown
  }
  toolUseResult?: unknown
  isMeta?: boolean
}

function extractChannelText(content: unknown): string | null {
  if (typeof content === 'string') {
    if (content.includes('<channel') || content.includes('notifications/claude/channel')) {
      return content
    }
    return null
  }
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === 'object') {
        const obj = c as Record<string, unknown>
        if (typeof obj.text === 'string') {
          const hit = extractChannelText(obj.text)
          if (hit) return hit
        }
      }
    }
  }
  return null
}

function isSilentChannelTurn(content: unknown): boolean {
  const text = extractChannelText(content)
  if (!text) return false
  const openingTag = text.slice(0, text.indexOf('>') + 1)
  const match = openingTag.match(/<channel\b[^>]*\bsystem="([^"]*)"/)
  if (match && match[1] !== undefined && SILENT_SYSTEM_META.has(match[1])) return true
  return false
}

/** Every `reply` tool call in the turn, in transcript order. */
function replyTexts(turn: TranscriptEntry[]): string[] {
  const parts: string[] = []
  for (const e of turn) {
    if (e.type !== 'assistant') continue
    const content = e.message?.content
    if (!Array.isArray(content)) continue
    for (const c of content) {
      if (!c || typeof c !== 'object') continue
      const obj = c as Record<string, unknown>
      if (obj.type !== 'tool_use') continue
      const name = typeof obj.name === 'string' ? obj.name : ''
      if (name !== 'reply' && !name.endsWith('__reply')) continue
      const input =
        obj.input && typeof obj.input === 'object' ? (obj.input as Record<string, unknown>) : {}
      if (typeof input.text === 'string') parts.push(input.text)
    }
  }
  return parts
}

/**
 * The text of the reply the owner ACTUALLY RECEIVES — which in this runtime is
 * the FIRST one, not the last.
 *
 * This inverts the upstream rule it is ported from, and the difference is not
 * cosmetic. Upstream streams a turn as several replies, so the message the owner
 * is left staring at is the LAST one; evaluating anything earlier punished the
 * legitimate "warn immediately, then do the work, then report" shape.
 *
 * This runtime delivers exactly one. `reply` carries no streaming/append
 * parameter (`dev-channel-impl.ts:129-137`), and the substrate settles the turn
 * on the first correlated reply — it pushes the completion, closes the channel
 * and marks the turn settled (`repl-session.ts:280-290`) — after which every
 * later reply is rejected (`repl-session.ts:269`). So a second reply is not a
 * continuation the owner sees; it is discarded.
 *
 * What ports is the RATIONALE, not the index: evaluate the message the owner is
 * actually left staring at. Taking "last reply" literally here would read a
 * follow-up the substrate already threw away and clear a turn that really did
 * strand the owner on a promise — a false NEGATIVE hiding the exact failure this
 * gate exists to catch.
 */
function deliveredReplyText(turn: TranscriptEntry[]): string {
  const parts = replyTexts(turn)
  return parts.length ? parts[0]! : ''
}

/**
 * Did the turn arm a REAL mechanism that will bring a message back to the owner
 * on its own? If so, an intent-to-continue reply is honest — something WILL
 * follow — so the gate must not block.
 *
 * This runtime has exactly ONE such seam, and it is deliberately a short list
 * rather than the upstream one — the upstream names do not exist here:
 *
 *   - `reminders_create` (`cores/free/reminders/src/tools.ts:104`) is the genuine
 *     scheduled wakeup. It is auto-approved, so the agent can arm it without the
 *     owner tapping anything (`gateway/cores/install-bundled.ts:1098`); a 30s tick
 *     picks the row up (`reminders/tick.ts:162`) and the dispatcher starts a turn
 *     on the SAME warm pooled session (`reminders/dispatcher.ts:139-145`,
 *     `open/composer.ts:2433-2434` → `pool.ts:490` → `spawn.ts:884`). The woken
 *     turn keeps the tool bridge, so it can even re-arm itself.
 *
 * Deliberately NOT accepted, each verified rather than assumed:
 *   - `dispatch_agent` — runs on a separate ephemeral substrate, and its
 *     completion reporter in this tree is a bare LOG LINE
 *     (`open/composer.ts:999-1004`). Nothing reaches the owner and nothing
 *     re-enters the session, so accepting it would wave through the exact
 *     stranding this gate exists to catch. It is also owner-approval-gated
 *     (`agent-dispatch/tool.ts:115`), so it cannot be armed unattended anyway.
 *   - `rituals_*` — approval-gated and executed on a different ephemeral
 *     substrate, so they wake a DIFFERENT agent, not this idle one.
 *   - cron / idle-nudge / morning-brief — server-side timers with no tool
 *     surface; the agent cannot call them at all.
 *
 * Bridge tools reach the agent as `mcp__neutron__<tool>`
 * (`signatures.ts:37`, `spawn.ts:108`) while dev-channel tools are unprefixed,
 * so match the bare name or the `__`-suffixed MCP form rather than an exact
 * string.
 */
function turnHasContinuationMechanism(turn: TranscriptEntry[]): boolean {
  const armed = (name: string, tool: string): boolean =>
    name === tool || name.endsWith(`__${tool}`)
  for (const e of turn) {
    if (e.type !== 'assistant') continue
    const content = e.message?.content
    if (!Array.isArray(content)) continue
    for (const c of content) {
      if (!c || typeof c !== 'object') continue
      const obj = c as Record<string, unknown>
      if (obj.type !== 'tool_use') continue
      const name = typeof obj.name === 'string' ? obj.name : ''
      if (armed(name, 'reminders_create')) return true
    }
  }
  return false
}

/**
 * High-confidence "I am about to do more work / I will come back" patterns.
 * FUTURE intent only — a past-tense report of completed work must never match.
 * Deliberately conservative: `stop_hook_active` caps any block at ONCE per turn,
 * so a rare false positive costs one extra nudge, never a wedge.
 */
const CONTINUATION_PROMISE_RE = new RegExp(
  [
    // Future modal + action verb: "I'll re-run", "let me fix", "about to run".
    //
    // The negative lookbehind rejects the verb-as-NOUN case. Most of these words
    // are also everyday nouns — "the fix", "a check", "your build", "the test" —
    // and because the modal and the word can sit up to 50 characters apart, an
    // unguarded alternation fires on ordinary prose that merely mentions one
    // ("I'll explain why the fix landed"). A determiner, possessive or adjective
    // immediately before the word is the signal that it is being used as a noun.
    "\\b(i['’]?ll|i will|let me|i['’]?m going to|i['’]?m gonna|going to|gonna|about to)\\b[^.!?\\n]{0,50}(?<!\\b(?:a|an|the|your|my|our|its|their|his|her|this|that|these|those|active|current|new|latest|next|last|full|clean|whole|entire|first|final|same|real|actual|another|each|every|no)\\s)\\b(re-?run|rerun|re-?try|retry|fix|finish|continue|run|start|kick off|report back|update you|circle back|get back|let you know|follow up|look into|investigate|dig into|dig in|build|deploy|test|check|verify)\\b",
    // Explicit promise to return.
    "\\b(report back|i['’]?ll report|keep you posted|circle back|follow up (with|on)|update you (shortly|when|once|after)|let you know (when|once|shortly|after))\\b",
    // Explicit hold / in-flight-and-signing-off.
    "\\b(stand ?by|hang tight|hold on|one (sec|second|moment|minute)|give me a (sec|second|moment|minute)|back (shortly|in a (sec|second|moment|minute))|working on it now|on it,? (i['’]?ll|will))\\b",
    // BARE present-participle in-progress narration, with no modal at all
    // ("fixing and re-running"). Present participles cannot be mistaken for a
    // past-tense report — "re-running" is never past, whereas "I re-ran" is —
    // and this is the most common form of the bug, so it must match on its own.
    "\\b(re-?running|rerunning|re-?trying|retrying|kicking (this |it )?off|firing (this |it )?off|spinning (this |it )?up|working on (it|this|that)|digging in(to (it|this|that))?|looking into (it|this|that))\\b",
  ].join('|'),
  'i',
)

/**
 * Strip double-quoted spans before promise-matching. A reply that QUOTES these
 * phrases as examples — explaining this very gate, or citing what not to say —
 * is meta-discussion, not a live promise, and must not trip the block. This was
 * a real observed false positive: the turn that first reported this gate was
 * itself blocked by it.
 *
 * Only DOUBLE quotes are stripped. Stripping single quotes would eat the
 * apostrophes in the contractions the patterns above depend on ("I'll", "it's").
 */
function stripQuotedSpans(text: string): string {
  return text.replace(/"[^"]*"/g, ' ').replace(/[“”][^“”]*[“”]/g, ' ')
}

function assistantCalledReply(entry: TranscriptEntry): boolean {
  if (entry.type !== 'assistant') return false
  const content = entry.message?.content
  if (!Array.isArray(content)) return false
  for (const c of content) {
    if (c && typeof c === 'object') {
      const obj = c as Record<string, unknown>
      if (obj.type !== 'tool_use') continue
      const name = obj.name
      if (typeof name !== 'string') continue
      // MCP wraps tool names as `mcp__<server>__<tool>` — the dev-channel MCP
      // server exposes its `reply` tool as `mcp__<channel>__reply`. Match
      // either the bare `reply` or any `…__reply` suffix. Incident of record
      // (Nova 2026-04-15): `name === 'reply'` never matched the MCP form.
      if (name === 'reply' || name.endsWith('__reply')) return true
    }
  }
  return false
}

async function main(): Promise<void> {
  let input: HookInput = {}
  try {
    const raw = await Bun.stdin.text()
    if (raw.trim()) input = JSON.parse(raw) as HookInput
  } catch (e) {
    log(`bad input: ${e}`)
    process.exit(0)
  }

  // Prevent infinite loops — Claude Code sets this after a previous block.
  if (input.stop_hook_active) {
    log(`stop_hook_active session=${input.session_id}`)
    process.exit(0)
  }

  const path = input.transcript_path
  if (!path) {
    process.exit(0)
  }

  let lines: string[]
  try {
    const text = await Bun.file(path).text()
    lines = text
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
  } catch (e) {
    log(`read transcript failed: ${e}`)
    process.exit(0)
  }

  const transcript: TranscriptEntry[] = []
  for (const line of lines) {
    try {
      transcript.push(JSON.parse(line) as TranscriptEntry)
    } catch {
      // skip malformed
    }
  }

  // Walk backwards to find the last real user message that started this turn.
  // Skip ONLY tool_result entries (type='user' with toolUseResult). Channel
  // messages are injected with isMeta=true, so we must NOT skip isMeta — doing
  // so makes the hook a silent no-op (Nova incident 2026-04-15).
  let lastUserIdx = -1
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i]
    if (e && e.type === 'user' && !e.toolUseResult) {
      lastUserIdx = i
      break
    }
  }

  if (lastUserIdx < 0) {
    process.exit(0)
  }

  const lastUser = transcript[lastUserIdx]
  if (!lastUser || extractChannelText(lastUser.message?.content) === null) {
    // Not a channel-originated turn — nothing to enforce.
    process.exit(0)
  }

  if (isSilentChannelTurn(lastUser.message?.content)) {
    log(`SKIP silent channel turn (system=notice|true) session=${input.session_id}`)
    process.exit(0)
  }

  // Scan assistant entries in the current turn for a reply() tool call.
  const turn = transcript.slice(lastUserIdx + 1)
  const calledReply = turn.some(assistantCalledReply)

  if (calledReply) {
    // `reply()` WAS called — but did that reply promise more work while ending the
    // turn with nothing arranged to carry it out? A channel turn is asynchronous:
    // nothing re-invokes an idle session, so "re-running now / I'll report back"
    // followed by turn-end leaves the owner in silence until they ask for a status.
    // Block ONCE (`stop_hook_active` caps it) unless the turn armed a real
    // continuation mechanism.
    const replyText = stripQuotedSpans(deliveredReplyText(turn))
    if (CONTINUATION_PROMISE_RE.test(replyText) && !turnHasContinuationMechanism(turn)) {
      log(`BLOCK session=${input.session_id} — reply promises continuation with nothing scheduled`)
      const payload = {
        decision: 'block',
        reason:
          'Your reply told the owner you would do more work (e.g. "re-running", "I\'ll report back", ' +
          '"one sec") but you are ending the turn WITHOUT having done it and WITHOUT arranging anything ' +
          'to continue. A channel turn is asynchronous — nothing re-invokes you until the owner messages ' +
          'again, so this leaves them staring at silence. Also note that this turn has already delivered ' +
          'its one reply: the substrate settles a turn on the first reply, so a further reply() call ' +
          'will NOT reach the owner. Do ONE of these before you stop: (1) actually do the work NOW in ' +
          'this same turn, so it is genuinely complete rather than abandoned; or (2) if it must wait on ' +
          'something external, arm the one mechanism that really does wake you again — reminders_create ' +
          '— so a scheduled turn brings you back to finish and report. Note that dispatch_agent does NOT ' +
          'count: its completion is only logged, so it would leave the owner with nothing. ' +
          'If your reply was actually reporting COMPLETED work (past tense, nothing left to do), simply ' +
          'end the turn again.',
      }
      process.stdout.write(JSON.stringify(payload))
      process.exit(0)
    }
    process.exit(0)
  }

  log(`BLOCK session=${input.session_id} — channel turn without reply()`)
  const payload = {
    decision: 'block',
    reason:
      'You responded to a <channel> message without calling the reply() tool. ' +
      'Terminal output is INVISIBLE to the caller — only the reply() tool delivers ' +
      'your response. Call the reply tool now, passing your intended response as the ' +
      'text argument. Do not stop until reply() has been called.',
  }
  process.stdout.write(JSON.stringify(payload))
  process.exit(0)
}

main().catch((e) => {
  log(`unhandled: ${e}`)
  process.exit(0)
})
