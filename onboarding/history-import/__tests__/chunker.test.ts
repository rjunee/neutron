/**
 * Chunker tests.
 *
 * Asserts:
 *   - 50K-token chunking yields one chunk for short conversations and
 *     multiple chunks for long ones
 *   - chunk_hash is deterministic per (conversation_id, chunk_index, byte_length)
 *   - per-conversation chunk_index restarts at 0
 *   - chunk_hash is sha256 (64 hex chars)
 */

import { expect, test } from 'bun:test'
import { chunkConversations, computeChunkHash } from '../chunker.ts'
import {
  CHUNK_TARGET_TOKENS,
  MAX_OAUTH_CHUNK_TARGET_TOKENS,
  type ConversationRecord,
} from '../types.ts'

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of it) out.push(v)
  return out
}

async function* yieldRecords(records: ConversationRecord[]): AsyncIterable<ConversationRecord> {
  for (const r of records) yield r
}

test('one short conversation produces exactly one chunk', async () => {
  const records: ConversationRecord[] = [
    {
      conversation_id: 'c1',
      messages: [
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'hi there' },
      ],
    },
  ]
  const chunks = await collect(chunkConversations(yieldRecords(records)))
  expect(chunks.length).toBe(1)
  expect(chunks[0]?.chunk_index).toBe(0)
  expect(chunks[0]?.conversation_id).toBe('c1')
})

test('long conversation produces multiple chunks at lower target', async () => {
  // 10 messages of ~120 chars each = ~1200 chars.
  const messages = Array.from({ length: 10 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `Message number ${i} `.repeat(8),
  }))
  const records: ConversationRecord[] = [{ conversation_id: 'c1', messages }]
  // target_tokens=20 -> target_chars=80, so each msg becomes its own chunk-ish
  const chunks = await collect(chunkConversations(yieldRecords(records), { target_tokens: 20 }))
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks[0]?.chunk_index).toBe(0)
  expect(chunks[1]?.chunk_index).toBe(1)
})

test('chunk_index resets to 0 per conversation', async () => {
  const records: ConversationRecord[] = [
    {
      conversation_id: 'a',
      messages: [{ role: 'user', text: 'm1' }],
    },
    {
      conversation_id: 'b',
      messages: [{ role: 'user', text: 'm2' }],
    },
  ]
  const chunks = await collect(chunkConversations(yieldRecords(records)))
  expect(chunks.length).toBe(2)
  expect(chunks[0]?.chunk_index).toBe(0)
  expect(chunks[1]?.chunk_index).toBe(0)
})

test('computeChunkHash is deterministic and 64 hex chars', () => {
  const h1 = computeChunkHash('c1', 0, 'some text')
  const h2 = computeChunkHash('c1', 0, 'some text')
  expect(h1).toBe(h2)
  expect(h1.length).toBe(64)
  expect(h1).toMatch(/^[0-9a-f]{64}$/)
})

test('different chunk_index produces different hash', () => {
  const h0 = computeChunkHash('c1', 0, 'same')
  const h1 = computeChunkHash('c1', 1, 'same')
  expect(h0).not.toBe(h1)
})

test('different chunk text produces different hash even when length matches', () => {
  const a = computeChunkHash('c1', 0, 'aaaa')
  const b = computeChunkHash('c1', 0, 'bbbb')
  expect(a).not.toBe(b)
})

test('different conversation_id produces different hash', () => {
  const a = computeChunkHash('c1', 0, 'text')
  const b = computeChunkHash('c2', 0, 'text')
  expect(a).not.toBe(b)
})

test('emits chunks with correct byte_length', async () => {
  const records: ConversationRecord[] = [
    {
      conversation_id: 'c1',
      messages: [{ role: 'user', text: 'hello' }],
    },
  ]
  const chunks = await collect(chunkConversations(yieldRecords(records)))
  expect(chunks[0]?.byte_length).toBeGreaterThan(0)
  expect(chunks[0]?.byte_length).toBe(Buffer.byteLength(chunks[0]!.text, 'utf8'))
})

test('skips empty conversations', async () => {
  const records: ConversationRecord[] = [
    { conversation_id: 'empty', messages: [] },
    { conversation_id: 'has-content', messages: [{ role: 'user', text: 'hi' }] },
  ]
  const chunks = await collect(chunkConversations(yieldRecords(records)))
  expect(chunks.length).toBe(1)
  expect(chunks[0]?.conversation_id).toBe('has-content')
})

// ─────────────────────────────────────────────────────────────────────────────
// v0.1.85 (2026-05-23) — Max OAuth target_tokens regression.
//
// Bug: Anthropic's predictive rate-limit gate rejects 50K-token-per-call
// requests on the Max OAuth path with "This request would exceed your
// account's rate limit" even on the FIRST call when no prior usage
// exists in the window. Max OAuth is designed for interactive Claude
// Code (1-8K tokens/call), not bulk 50K-token batches. The runner
// switches to MAX_OAUTH_CHUNK_TARGET_TOKENS (4096) when the resolved
// credential kind is 'oauth' so the chunker yields many smaller chunks
// that stay under the per-call cap.
//
// These tests assert:
//   1. The new constant is exported and equals 4096.
//   2. 4096 produces MORE chunks than 50K on the same input (the whole
//      point of the override — more chunks → smaller per-call payload).
//   3. Every chunk produced at 4096 fits within ~4096*4=16384 chars
//      (the chunker's approx-chars-per-token proxy).
//   4. The chunker accepts target_tokens=4096 without choking — every
//      emitted chunk has a stable hash + index, same shape contract as
//      the 50K default.
// ─────────────────────────────────────────────────────────────────────────────

test('v0.1.85 — MAX_OAUTH_CHUNK_TARGET_TOKENS is 4096 and < CHUNK_TARGET_TOKENS', () => {
  expect(MAX_OAUTH_CHUNK_TARGET_TOKENS).toBe(4096)
  expect(MAX_OAUTH_CHUNK_TARGET_TOKENS).toBeLessThan(CHUNK_TARGET_TOKENS)
})

test('v0.1.85 — Max-OAuth target (4096) produces more chunks than default (50K) on the same input', async () => {
  // Build one conversation big enough that the default 50K target packs
  // it into a single chunk but the 4096 target requires multiple. At
  // 4 chars/token, 4096 tokens ≈ 16384 chars; we generate ~80K chars
  // (~20K tokens). Default: 1 chunk; Max-OAuth: ~5 chunks.
  const messages = Array.from({ length: 200 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    // ~400 chars per message → 200 messages → ~80K chars total.
    text: `Message ${i} body content `.repeat(20),
  }))
  const records: ConversationRecord[] = [
    { conversation_id: 'big-1', messages },
  ]
  const defaultChunks = await collect(
    chunkConversations(yieldRecords(records), { target_tokens: CHUNK_TARGET_TOKENS }),
  )
  const maxOauthChunks = await collect(
    chunkConversations(yieldRecords(records), {
      target_tokens: MAX_OAUTH_CHUNK_TARGET_TOKENS,
    }),
  )
  expect(maxOauthChunks.length).toBeGreaterThan(defaultChunks.length)
  // The whole point of the override — Max-OAuth chunks at ~4K tokens
  // are well under Anthropic's per-call rate-limit gate.
  for (const c of maxOauthChunks) {
    // 4 chars per token proxy → target_chars ~= 4096 * 4 = 16384.
    // The chunker can exceed this slightly when a single message is
    // larger than the target (degenerate worst-case per chunker.ts
    // "always emit at least one message into a chunk"); we assert a
    // generous 2x ceiling so the test is robust to that edge while
    // still catching a true regression where the override is ignored.
    expect(c.byte_length).toBeLessThan(MAX_OAUTH_CHUNK_TARGET_TOKENS * 4 * 2)
  }
})

test('v0.1.85 — chunker does not choke on the smaller target (every chunk has a stable hash + index)', async () => {
  const messages = Array.from({ length: 50 }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `Body ${i} `.repeat(30),
  }))
  const records: ConversationRecord[] = [
    { conversation_id: 'mx-1', messages },
  ]
  const chunks = await collect(
    chunkConversations(yieldRecords(records), {
      target_tokens: MAX_OAUTH_CHUNK_TARGET_TOKENS,
    }),
  )
  expect(chunks.length).toBeGreaterThan(0)
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!
    expect(c.conversation_id).toBe('mx-1')
    expect(c.chunk_index).toBe(i)
    expect(c.chunk_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(c.byte_length).toBeGreaterThan(0)
    expect(c.text.length).toBeGreaterThan(0)
  }
})

test('chunk text includes role markers and timestamps when present', async () => {
  const records: ConversationRecord[] = [
    {
      conversation_id: 'c1',
      messages: [
        { role: 'user', text: 'hello', created_at: 1714521600000 },
      ],
    },
  ]
  const chunks = await collect(chunkConversations(yieldRecords(records)))
  expect(chunks[0]?.text).toContain('USER')
  expect(chunks[0]?.text).toContain('hello')
  expect(chunks[0]?.text).toMatch(/2024-/)
})
