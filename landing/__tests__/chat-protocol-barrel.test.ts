/**
 * L1 (2026-07) — chat-protocol wire types were extracted verbatim out of
 * `landing/server.ts` into the new leaf module `landing/chat-protocol.ts`
 * (pure type extraction, zero behavior change). `landing/server.ts` keeps a
 * re-export barrel so any importer still on the old specifier during the
 * transition does not break (test-policy §2.2 barrel rule).
 *
 * This is a type-level seam with no runtime values to assert against
 * directly (every moved symbol is an `interface`/`type`, which TypeScript
 * erases). The guard here is therefore twofold:
 *   1. `tsc` compiling this file at all proves both import specifiers
 *      resolve and the barrel's `export type { ... } from './chat-protocol.ts'`
 *      re-export is wired correctly — a broken barrel or a missing symbol on
 *      the leaf fails the type check, not this test body.
 *   2. A `git grep` in the second test that both files declare/re-export
 *      the same protocol symbol set, so a future edit that adds a new
 *      `*Outbound` member to one side without the other regresses loudly.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Importable from BOTH specifiers — proves the barrel re-export in
// landing/server.ts still resolves to the same leaf-defined types.
import type { ChatOutbound as ChatOutboundFromLeaf } from '../chat-protocol.ts'
import type { ChatOutbound as ChatOutboundFromBarrel } from '../server.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')

// Compile-time-only assertion that the two specifiers name the identical
// type. If the barrel ever drifts (e.g. re-exports a stale local copy
// instead of re-exporting from the leaf) this line stops compiling.
type _AssertSameType = ChatOutboundFromLeaf extends ChatOutboundFromBarrel
  ? ChatOutboundFromBarrel extends ChatOutboundFromLeaf
    ? true
    : never
  : never
const _typeCheck: _AssertSameType = true
void _typeCheck

const PROTOCOL_SYMBOLS = [
  'ChatOutbound',
  'AgentMessageOutbound',
  'AgentAckOutbound',
  'RedirectOutbound',
  'SlugRenamedOutbound',
  'AgentTypingStartOutbound',
  'AgentTypingEndOutbound',
  'ErrorOutbound',
  'TopicSwitchedOutbound',
  'SessionReadyOutbound',
  'ImportProgressOutbound',
]

describe('landing/chat-protocol.ts leaf + landing/server.ts barrel', () => {
  test('every protocol symbol is defined on the leaf and re-exported by the barrel', () => {
    const leaf = readFileSync(resolve(REPO_ROOT, 'landing/chat-protocol.ts'), 'utf8')
    const barrel = readFileSync(resolve(REPO_ROOT, 'landing/server.ts'), 'utf8')
    for (const symbol of PROTOCOL_SYMBOLS) {
      expect(leaf).toContain(symbol)
      expect(barrel).toContain(symbol)
    }
    // The barrel must not still declare its own copy of the union — it
    // should only re-export from the leaf. `export type ChatOutbound =`
    // (a fresh declaration) is a regression signal; the barrel form is
    // `export type {\n  ChatOutbound,` inside a re-export block.
    expect(barrel).not.toContain('export type ChatOutbound =')
    expect(barrel).toContain("from './chat-protocol.ts'")
  })
})
