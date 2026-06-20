/**
 * @neutronai/runtime — `InMemoryConsumedTokens` (Sprint B, 2026-05-20).
 *
 * Single-instance Open boxes (and unit tests that don't need replay-
 * survives-restart durability) consume start-token JTIs through this
 * tiny in-memory variant of `ConsumedTokensStore`. Lifted out of
 * `signup/start-token.ts` so Open code can import the in-memory store
 * without pulling the entire Managed `signup/` tree.
 *
 * The production Managed-tier SQLite-backed `SqliteConsumedTokens` stays
 * at `signup/consumed-tokens-sqlite.ts` — Open self-hosted boxes have
 * no identity service to mint start-tokens against, so the in-memory
 * variant is the only one Open ever instantiates.
 *
 * Atomicity note: `Map.set` + `Map.has` are synchronous in V8, so the
 * combined check-then-set inside `claim()` runs without intervening task
 * scheduling. Concurrent callers always see deterministic order.
 */

import type { ConsumedTokensStore } from './start-token-types.ts'

export class InMemoryConsumedTokens implements ConsumedTokensStore {
  private readonly map = new Map<string, number>()
  private readonly now: () => number

  constructor(now?: () => number) {
    this.now = now ?? ((): number => Date.now())
  }

  async claim(jti: string, expires_at_ms: number): Promise<boolean> {
    const existing = this.map.get(jti)
    const now = this.now()
    if (existing !== undefined && existing > now) return false
    this.map.set(jti, expires_at_ms)
    return true
  }
}
