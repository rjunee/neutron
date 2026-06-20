#!/usr/bin/env bun
/**
 * Stop hook for Neutron persistent-REPL sessions.
 *
 * LIFTED VERBATIM from Nova `gateway/hooks/enforce-reply.ts` (§ 1 #5,
 * ★ CORE-PRESERVED-VERBATIM). The transcript-walk, the `__reply` MCP-name
 * match, and the notice-exempt logic are byte-for-byte the Nova logic. ONLY
 * the block-reason wording is adapted (it no longer mentions Telegram — the
 * reply now resolves a substrate `completion` Event, not a Telegram post) and
 * `SILENT_SYSTEM_META` is inlined (Nova imported it from `gateway-core`).
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
