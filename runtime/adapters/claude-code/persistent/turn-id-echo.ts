/**
 * turn-id-echo.ts — the dev-channel's stateless reply correlation (S3 #107,
 * REPLACES the deleted shared-mutable `turn-id-fifo.ts`).
 *
 * Reply correlation is now direct request→response: each `/message` carries the
 * substrate's `turn_id` (`<incarnation>:<seq>`), and the reply that answers it
 * echoes that id back so the substrate's `onReply` accepts a reply ONLY for the
 * turn that produced it. Two paths:
 *
 *   • PRIMARY (zero stored state) — the originating message's `meta.turn_id` is
 *     echoed on the reply tool-call context; we forward it verbatim. Each reply
 *     carries its OWN id, so an abandoned turn's late reply (carrying THAT turn's
 *     id) is rejected by the substrate, never mis-attributed.
 *   • FALLBACK (no meta surfaced) — a single reset-per-turn scalar PLUS a
 *     stale-reply DEBT counter. NOT a positional id-queue (no id array, no
 *     dequeue-by-position, no notify-poison): the scalar holds the current turn's
 *     id; the debt counts turns the substrate ABANDONED (timeout/cancel/death)
 *     before their reply arrived. CC processes `<channel>` messages serially and
 *     replies once per message IN ARRIVAL ORDER (Stop-hook enforced), so an
 *     abandoned turn's late reply is the NEXT reply to arrive — we skip exactly
 *     `debt` replies (returning `undefined` → the substrate rejects them) so a
 *     straggler can never steal the live turn's id. A genuine wedge (no replies
 *     ever) times out the next turn too → the watchdog respawns → a fresh
 *     dev-channel resets the state. This is the Codex-r1-P1 fix for the bare
 *     scalar's timeout-path misattribution.
 */

export class TurnIdEcho {
  private currentTurnId: string | undefined
  private debt = 0

  /**
   * Record an injected turn. Call AFTER the channel notification resolves (so a
   * notify failure leaves the state untouched — poison-free). If the prior turn
   * was never replied to (its scalar is still set → abandoned), bank one unit of
   * stale-reply debt so its in-order late reply is skipped rather than mis-tagged.
   */
  onInject(turnId: string | undefined): void {
    if (this.currentTurnId !== undefined) this.debt += 1
    this.currentTurnId = turnId
  }

  /**
   * Resolve the `turn_id` to tag a reply with. The primary `metaTurnId` echo wins
   * when present. Otherwise: consume one unit of stale-reply debt first (return
   * `undefined` → the substrate rejects an abandoned turn's late reply), else
   * read-and-clear the current scalar. `undefined` ⇒ the reply is tagged with no
   * turn_id and the substrate rejects it (never a silent accept).
   */
  onReply(metaTurnId?: string): string | undefined {
    if (typeof metaTurnId === 'string' && metaTurnId.length > 0) {
      // Codex-r1-P2: when the meta echo answers the IN-FLIGHT turn (its id matches
      // the live scalar), CLEAR the scalar — the turn is complete. Leaving it set
      // would make the NEXT `onInject` see a still-populated scalar and bank phantom
      // stale-reply debt for an already-completed turn, which then skips a later
      // legitimate non-meta reply (returning `undefined` → rejected → that turn times
      // out). A mixed meta/no-meta channel (primary echo on turn N, fallback scalar
      // on turn N+1) is exactly where the un-cleared scalar misfired. A meta id that
      // does NOT match the live scalar is a straggler for a different turn: forward it
      // verbatim (the substrate's <incarnation>:<seq> check rejects it) but leave the
      // live scalar intact so the real reply still resolves.
      if (metaTurnId === this.currentTurnId) {
        this.currentTurnId = undefined
      } else if (this.debt > 0) {
        // Codex-r2-P2: a non-matching meta echo is an ABANDONED turn's straggler
        // (its id ≠ the live scalar), so the substrate correctly rejects it. But
        // that straggler is the in-order late reply this `debt` unit was banked to
        // absorb (one abandoned turn → one debt → one skipped straggler). If we
        // forward it WITHOUT consuming the debt, the debt LEAKS: in a mixed
        // meta/no-meta channel the NEXT legit fallback (no-meta) reply then hits
        // `debt>0`, returns `undefined` → the substrate rejects it → that live turn
        // times out despite having replied. Consume one debt unit here so the
        // abandoned turn this straggler belongs to is settled by THIS forward,
        // never stolen from a later real reply.
        this.debt -= 1
      }
      return metaTurnId
    }
    if (this.debt > 0) {
      this.debt -= 1
      return undefined
    }
    const t = this.currentTurnId
    this.currentTurnId = undefined
    return t
  }

  /** Current stale-reply debt (test/telemetry). */
  get staleReplyDebt(): number {
    return this.debt
  }
}
