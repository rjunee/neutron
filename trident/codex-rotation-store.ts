/**
 * @neutronai/trident — persistence for codex seat rotation.
 *
 * Holds only the bookkeeping: which seats exist, their order, whether one is
 * cooling off, and which one the next run should use. The credential bundles
 * themselves stay in the encrypted `project_credentials` store — nothing secret
 * is written here, and nothing here is ever logged.
 *
 * The interface is separated from the SQLite implementation so the policy can be
 * exercised against a literal state, which is the only way to test "what happens
 * when all four seats are capped" without four real subscriptions.
 */

import type { ProjectDb, OwnerHandle } from '@neutronai/persistence/index.ts'
import type { CoolingReason, SlotState } from './codex-rotation.ts'

/** Usage figures worth keeping for the status surface. Never secret. */
export interface SlotUsage {
  used_percent: number | null
  window_minutes: number | null
  resets_at: number | null
  plan_type: string | null
}

/** A slot plus everything the owner-facing status view wants to show. */
export interface SlotRecord extends SlotState {
  label: string | null
  usage: SlotUsage
  last_run_at: number | null
  /**
   * When the bundle currently in this slot was connected.
   *
   * This is the identity boundary between one account and the next in a REUSED
   * directory. Disconnecting a seat cannot remove its `sessions/` tree — for the
   * first seat that tree is the whole `.codex` home and also contains every
   * other seat — so a differently-owned account connected under the same name
   * would otherwise inherit the previous account's usage history and be cooled
   * before it had run once. Harvest ignores anything older than this stamp.
   */
  connected_at: number | null
  /** Last harvest attempt, used to throttle the scan. See `markHarvested`. */
  last_harvest_at: number | null
}

export interface CodexRotationStore {
  listSlots(owner_slug: OwnerHandle): SlotRecord[]
  /** Register a slot (idempotent); appends at the end of the ring when new. */
  upsertSlot(owner_slug: OwnerHandle, slot: string, label: string | null): void
  removeSlot(owner_slug: OwnerHandle, slot: string): void
  getActiveSlot(owner_slug: OwnerHandle): string | null
  setActiveSlot(owner_slug: OwnerHandle, slot: string, now: number): void
  setCooldown(owner_slug: OwnerHandle, slot: string, cooldown: { cooling_until: number; cooling_reason: CoolingReason } | null): void
  recordUsage(owner_slug: OwnerHandle, slot: string, usage: SlotUsage, now: number): void
  /**
   * Mark a (re)connection: stamp `connected_at` and DISCARD everything the
   * previous occupant of this slot left behind — its cooldown and its usage
   * figures. Pasting a fresh bundle is the owner saying "this seat works now",
   * and it is the only thing that clears an `unauthorized` state.
   */
  markConnected(owner_slug: OwnerHandle, slot: string, now: number): void
  /** Record that a harvest was attempted, so the next one can be throttled. */
  markHarvested(owner_slug: OwnerHandle, slot: string, now: number): void
}

interface SlotRow {
  slot: string
  position: number
  label: string | null
  cooling_until: number | null
  cooling_reason: string | null
  last_used_percent: number | null
  last_window_minutes: number | null
  last_resets_at: number | null
  last_plan_type: string | null
  last_run_at: number | null
  connected_at: number | null
  last_harvest_at: number | null
}

const VALID_REASONS: readonly CoolingReason[] = [
  'short-window',
  'long-window',
  'rate-limited',
  'unauthorized',
  'manual',
]

/**
 * Narrow a stored reason string back to the union.
 *
 * An unrecognised value becomes `manual` rather than being trusted through: the
 * one reason with special semantics is `unauthorized` (it never expires on a
 * timer), and inventing that from an unknown string would strand a healthy seat
 * permanently. `manual` still respects `cooling_until`, so a corrupt row heals.
 */
function toReason(raw: string | null): CoolingReason | null {
  if (raw === null) return null
  return VALID_REASONS.includes(raw as CoolingReason) ? (raw as CoolingReason) : 'manual'
}

export class SqliteCodexRotationStore implements CodexRotationStore {
  private readonly db: ProjectDb

  constructor(db: ProjectDb) {
    this.db = db
  }

  listSlots(owner_slug: OwnerHandle): SlotRecord[] {
    const rows = this.db.all<SlotRow>(
      `SELECT slot, position, label, cooling_until, cooling_reason,
              last_used_percent, last_window_minutes, last_resets_at, last_plan_type, last_run_at,
              connected_at, last_harvest_at
         FROM codex_rotation_slots WHERE owner_slug = ? ORDER BY position ASC, slot ASC`,
      [owner_slug],
    )
    return rows.map((r) => ({
      slot: r.slot,
      position: r.position,
      cooling_until: r.cooling_until,
      cooling_reason: toReason(r.cooling_reason),
      label: r.label,
      last_run_at: r.last_run_at,
      connected_at: r.connected_at,
      last_harvest_at: r.last_harvest_at,
      usage: {
        used_percent: r.last_used_percent,
        window_minutes: r.last_window_minutes,
        resets_at: r.last_resets_at,
        plan_type: r.last_plan_type,
      },
    }))
  }

  upsertSlot(owner_slug: OwnerHandle, slot: string, label: string | null): void {
    const existing = this.db.get<{ slot: string }>(
      `SELECT slot FROM codex_rotation_slots WHERE owner_slug = ? AND slot = ?`,
      [owner_slug, slot],
    )
    if (existing !== null) {
      if (label !== null) {
        this.db.runSync(`UPDATE codex_rotation_slots SET label = ? WHERE owner_slug = ? AND slot = ?`, [
          label,
          owner_slug,
          slot,
        ])
      }
      return
    }
    const max = this.db.get<{ m: number }>(
      `SELECT COALESCE(MAX(position), -1) AS m FROM codex_rotation_slots WHERE owner_slug = ?`,
      [owner_slug],
    )
    const position = (max?.m ?? -1) + 1
    this.db.runSync(
      `INSERT INTO codex_rotation_slots (owner_slug, slot, position, label) VALUES (?, ?, ?, ?)`,
      [owner_slug, slot, position, label],
    )
  }

  removeSlot(owner_slug: OwnerHandle, slot: string): void {
    this.db.runSync(`DELETE FROM codex_rotation_slots WHERE owner_slug = ? AND slot = ?`, [owner_slug, slot])
    // Leaving the pointer aimed at a deleted slot would make selection fall back
    // to the ring head silently; clearing it makes the next resolve re-choose.
    if (this.getActiveSlot(owner_slug) === slot) {
      this.db.runSync(`DELETE FROM codex_rotation_active WHERE owner_slug = ?`, [owner_slug])
    }
  }

  getActiveSlot(owner_slug: OwnerHandle): string | null {
    const row = this.db.get<{ active_slot: string }>(
      `SELECT active_slot FROM codex_rotation_active WHERE owner_slug = ?`,
      [owner_slug],
    )
    return row?.active_slot ?? null
  }

  setActiveSlot(owner_slug: OwnerHandle, slot: string, now: number): void {
    this.db.runSync(
      `INSERT INTO codex_rotation_active (owner_slug, active_slot, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(owner_slug) DO UPDATE SET active_slot = excluded.active_slot, updated_at = excluded.updated_at`,
      [owner_slug, slot, now],
    )
  }

  setCooldown(
    owner_slug: OwnerHandle,
    slot: string,
    cooldown: { cooling_until: number; cooling_reason: CoolingReason } | null,
  ): void {
    this.db.runSync(
      `UPDATE codex_rotation_slots SET cooling_until = ?, cooling_reason = ? WHERE owner_slug = ? AND slot = ?`,
      [cooldown?.cooling_until ?? null, cooldown?.cooling_reason ?? null, owner_slug, slot],
    )
  }

  recordUsage(owner_slug: OwnerHandle, slot: string, usage: SlotUsage, now: number): void {
    this.db.runSync(
      `UPDATE codex_rotation_slots
          SET last_used_percent = ?, last_window_minutes = ?, last_resets_at = ?,
              last_plan_type = ?, last_run_at = ?
        WHERE owner_slug = ? AND slot = ?`,
      [usage.used_percent, usage.window_minutes, usage.resets_at, usage.plan_type, now, owner_slug, slot],
    )
  }

  markConnected(owner_slug: OwnerHandle, slot: string, now: number): void {
    // Clearing the cooldown AND the usage figures in the same statement is the
    // point: a reconnect may be a different subscription in the same directory,
    // and carrying either forward would judge the new account on the old one's
    // record.
    this.db.runSync(
      `UPDATE codex_rotation_slots
          SET connected_at = ?, cooling_until = NULL, cooling_reason = NULL,
              last_used_percent = NULL, last_window_minutes = NULL,
              last_resets_at = NULL, last_plan_type = NULL, last_harvest_at = NULL
        WHERE owner_slug = ? AND slot = ?`,
      [now, owner_slug, slot],
    )
  }

  markHarvested(owner_slug: OwnerHandle, slot: string, now: number): void {
    this.db.runSync(`UPDATE codex_rotation_slots SET last_harvest_at = ? WHERE owner_slug = ? AND slot = ?`, [
      now,
      owner_slug,
      slot,
    ])
  }
}
