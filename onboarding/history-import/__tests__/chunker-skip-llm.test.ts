/**
 * 2026-05-31 — chunker skip_llm pre-filter regression suite.
 *
 * Per the "Import pass-1 — Opus default + parallel + ETA + chunk-size
 * audit" sprint brief (Part D). Conversations where the user only
 * emitted "hi" / "thanks" / "ok" (< MIN_USER_CONTENT_CHARS chars
 * total) trigger a `skip_llm=true` annotation on the chunk so the
 * runner's worker pool persists a placeholder result rather than
 * burning a 30-second Opus call on chunks with no analyzable signal.
 *
 * What this suite proves:
 *   1. The chunker stamps `skip_llm=true` + `skip_llm_user_chars=<N>`
 *      when total user-role content < 500 chars.
 *   2. The chunker leaves `skip_llm` undefined when the threshold is met.
 *   3. Assistant / system / tool message text DOES NOT count toward the
 *      threshold — only user-role text.
 *   4. Setting `min_user_content_chars: 0` disables the pre-filter
 *      entirely (test-seam compat for legacy fixtures).
 *   5. A custom `min_user_content_chars: 50` override drives the cut
 *      threshold deterministically.
 *   6. Chunks that flush mid-conversation each carry their own
 *      skip_llm verdict based on the messages that landed in that
 *      bucket (not the conversation-wide aggregate).
 */

import { expect, test } from 'bun:test'
import { chunkConversations } from '../chunker.ts'
import {
  MIN_USER_CONTENT_CHARS,
  type ConversationRecord,
  type Chunk,
} from '../types.ts'

async function* yieldRecords(records: ConversationRecord[]): AsyncIterable<ConversationRecord> {
  for (const r of records) yield r
}

async function collect(records: ConversationRecord[], opts = {}): Promise<Chunk[]> {
  const out: Chunk[] = []
  for await (const c of chunkConversations(yieldRecords(records), opts)) out.push(c)
  return out
}

test('short user content (< MIN_USER_CONTENT_CHARS) → skip_llm=true with skip_llm_user_chars stamped', async () => {
  const chunks = await collect([
    {
      conversation_id: 'short-1',
      messages: [
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: 'hello back' },
        { role: 'user', text: 'thanks' },
      ],
    },
  ])
  expect(chunks.length).toBe(1)
  expect(chunks[0]!.skip_llm).toBe(true)
  // 'hi' (2) + 'thanks' (6) = 8 user chars
  expect(chunks[0]!.skip_llm_user_chars).toBe(8)
})

test('long user content (>= MIN_USER_CONTENT_CHARS) → skip_llm undefined', async () => {
  const longText = 'x'.repeat(MIN_USER_CONTENT_CHARS + 50)
  const chunks = await collect([
    {
      conversation_id: 'long-1',
      messages: [
        { role: 'user', text: longText },
        { role: 'assistant', text: 'reply' },
      ],
    },
  ])
  expect(chunks.length).toBe(1)
  expect(chunks[0]!.skip_llm).toBeUndefined()
  expect(chunks[0]!.skip_llm_user_chars).toBeUndefined()
})

test('assistant text does NOT count toward the floor (signal is the user/event side, not the LLM reply)', async () => {
  // Big assistant text but tiny user text → still skip_llm=true.
  const chunks = await collect([
    {
      conversation_id: 'asym-1',
      messages: [
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: 'X'.repeat(MIN_USER_CONTENT_CHARS * 2) },
      ],
    },
  ])
  expect(chunks.length).toBe(1)
  expect(chunks[0]!.skip_llm).toBe(true)
  expect(chunks[0]!.skip_llm_user_chars).toBe(2)
})

test('event-role messages (calendar-oauth) DO count toward the floor (Codex r1 fix)', async () => {
  // Calendar imports emit one Conversation per event with a single
  // `role: 'event'` message body. v1 of skip_llm only counted
  // `role === 'user'` text → every calendar chunk would have been
  // silently skipped. Codex r1 broadened to "any non-assistant text".
  const eventBody = 'Quarterly planning meeting with Alice and Bob. '.repeat(15) // ~700 chars
  const chunks = await collect([
    {
      conversation_id: 'cal-event-1',
      messages: [{ role: 'event', text: eventBody }],
    },
  ])
  expect(chunks.length).toBe(1)
  expect(chunks[0]!.skip_llm).toBeUndefined()
})

test('Gmail received-only thread (all role=event) DOES count toward the floor (Codex r1 fix)', async () => {
  // Gmail oauth import labels sent-by-the-owner messages as `role:
  // 'user'` and received messages as `role: 'event'`. A received-only
  // thread (the owner never replied) lands as all-event. v1 would
  // have silently 100%-skipped these.
  const receivedBody = 'Hi — quick update on the Q3 budget review. '.repeat(15) // ~650 chars
  const chunks = await collect([
    {
      conversation_id: 'gmail-recv-1',
      messages: [{ role: 'event', text: receivedBody }],
    },
  ])
  expect(chunks.length).toBe(1)
  expect(chunks[0]!.skip_llm).toBeUndefined()
})

test('tool + system messages count toward the floor (defense-in-depth for non-standard sources)', async () => {
  const chunks = await collect([
    {
      conversation_id: 'tool-only',
      messages: [
        { role: 'tool', text: 'A'.repeat(300) },
        { role: 'system', text: 'B'.repeat(300) },
      ],
    },
  ])
  expect(chunks.length).toBe(1)
  // 300 + 300 = 600 non-assistant chars → above the 500 floor.
  expect(chunks[0]!.skip_llm).toBeUndefined()
})

test('min_user_content_chars: 0 disables the pre-filter (every chunk LLM-bound)', async () => {
  const chunks = await collect(
    [
      {
        conversation_id: 'no-floor',
        messages: [
          { role: 'user', text: 'hi' },
          { role: 'assistant', text: 'hello' },
        ],
      },
    ],
    { min_user_content_chars: 0 },
  )
  expect(chunks.length).toBe(1)
  expect(chunks[0]!.skip_llm).toBeUndefined()
})

test('custom min_user_content_chars: 50 — chunks above 50 user chars are not skipped, below are', async () => {
  const chunks = await collect(
    [
      {
        conversation_id: 'mid-1',
        messages: [
          // 60 chars of user text — above the custom 50 floor
          { role: 'user', text: 'A'.repeat(60) },
          { role: 'assistant', text: 'reply' },
        ],
      },
      {
        conversation_id: 'mid-2',
        messages: [
          // 20 chars of user text — below the custom 50 floor
          { role: 'user', text: 'B'.repeat(20) },
          { role: 'assistant', text: 'reply' },
        ],
      },
    ],
    { min_user_content_chars: 50 },
  )
  expect(chunks.length).toBe(2)
  expect(chunks[0]!.skip_llm).toBeUndefined()
  expect(chunks[1]!.skip_llm).toBe(true)
  expect(chunks[1]!.skip_llm_user_chars).toBe(20)
})

test('skip_llm verdict is per-chunk: a conversation that flushes into 2 chunks gets per-bucket verdicts', async () => {
  // Long user-text first message (over threshold) plus a tiny user
  // tail message in the same conversation. With a small target_tokens
  // override the chunker flushes the long message into chunk 0 and
  // the tiny tail into chunk 1; the per-chunk verdict differs.
  const longUserText = 'Z'.repeat(600)
  const chunks = await collect(
    [
      {
        conversation_id: 'multi-1',
        messages: [
          { role: 'user', text: longUserText },
          { role: 'assistant', text: 'A'.repeat(500) },
          { role: 'user', text: 'thx' },
        ],
      },
    ],
    // Each message is rendered with a `USER: ` / `ASSISTANT: ` prefix
    // (~10 chars) + the text body, so a tight token target forces a
    // flush between messages.
    { target_tokens: 200 }, // 200 * 4 chars/token = 800-char target
  )
  expect(chunks.length).toBe(2)
  // First chunk holds the 600-char user message → above the 500
  // default floor → no skip_llm.
  expect(chunks[0]!.skip_llm).toBeUndefined()
  // Second chunk holds only the 3-char "thx" user tail → skip_llm=true.
  expect(chunks[1]!.skip_llm).toBe(true)
  expect(chunks[1]!.skip_llm_user_chars).toBe(3)
})
