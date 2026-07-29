/**
 * @neutronai/calendar-core — free/busy slot derivation.
 *
 * Pure deterministic function over a per-attendee busy-interval set.
 * Both backends (`buildInMemoryCalendarClient` + `buildGoogleCalendarClient`)
 * delegate to `findFreeSlots` so the slot-selection algorithm matches
 * exactly across in-memory tests and the production Google v3 path.
 *
 * Algorithm:
 *
 *   1. Flatten per-attendee busy arrays into a single "union of busy"
 *      list (each per-attendee row added once).
 *   2. Sort + merge overlapping intervals to get the canonical
 *      "everyone's collective busy" intervals.
 *   3. Walk candidate slot starts on a `granularity_minutes` grid from
 *      `window_start` to `window_end - duration_minutes`.
 *   4. Reject slots whose `[start, start+duration)` overlaps ANY merged
 *      busy interval.
 *   5. Reject slots whose local-hour-of-start falls outside the
 *      `preferred_hours` window (24h tuple, inclusive start exclusive
 *      end). The grid is UTC-anchored but the hours window is local
 *      to the slot's wall-clock hour — Open and Managed both run in
 *      the user's tz, so `getUTCHours()` after offsetting by the
 *      owner's tz would be the right call; for v1 we use
 *      `getHours()` on a regular JS `Date` because production runs in
 *      the user's local tz on the gateway VPS (per Sprint B platform
 *      adapter notes). Tests can override via `clock_local_hour_of`.
 *   6. Return at most `max_slots` slots in chronological order.
 *
 * `attendees` is echoed verbatim on every emitted slot so the caller
 * doesn't have to thread it through the chat-command layer.
 *
 * Why a pure function: the chat-command surface, the
 * `calendar_find_time` MCP tool, and the in-memory client all need
 * identical semantics. Inlining the algorithm into each callsite was
 * the original temptation; it leaves three drift points open.
 */

import type { BusyInterval, FindTimeInput, TimeSlot } from './backend.ts'

/** Default proposed-slot granularity (minutes). */
export const DEFAULT_GRANULARITY_MINUTES = 15
/** Default top-N proposed slots. */
export const DEFAULT_MAX_SLOTS = 5
/** Default preferred-hour window (24h, [start_inclusive, end_exclusive]). */
export const DEFAULT_PREFERRED_HOURS: readonly [number, number] = [9, 18]

export interface FindFreeSlotsInput extends FindTimeInput {
  /** Per-attendee busy arrays, parallel to `attendees`. Same shape
   *  `freebusy(...)` returns. */
  per_attendee_busy: readonly BusyInterval[][]
  /**
   * Test seam — override the "local hour of the slot start" derivation.
   * Production uses `new Date(iso).getHours()`. Tests inject a
   * deterministic resolver so the preferred-hours filter is stable
   * across TZ envs.
   */
  clock_local_hour_of?: (iso: string) => number
}

interface MergedInterval {
  start_ms: number
  end_ms: number
}

/**
 * Merge a list of intervals. Returns sorted-by-start, non-overlapping
 * intervals. Adjacent intervals (`end_ms === next.start_ms`) are
 * coalesced.
 */
export function mergeIntervals(input: readonly BusyInterval[]): MergedInterval[] {
  const parsed: MergedInterval[] = []
  for (const row of input) {
    const start_ms = Date.parse(row.start)
    const end_ms = Date.parse(row.end)
    if (Number.isNaN(start_ms) || Number.isNaN(end_ms) || end_ms <= start_ms) {
      continue
    }
    parsed.push({ start_ms, end_ms })
  }
  parsed.sort((a, b) => a.start_ms - b.start_ms)
  const merged: MergedInterval[] = []
  for (const cur of parsed) {
    const last = merged[merged.length - 1]
    if (last !== undefined && cur.start_ms <= last.end_ms) {
      last.end_ms = Math.max(last.end_ms, cur.end_ms)
    } else {
      merged.push({ ...cur })
    }
  }
  return merged
}

/**
 * Find proposed time slots where every attendee is free. Deterministic;
 * never reaches the network.
 */
export function findFreeSlots(input: FindFreeSlotsInput): TimeSlot[] {
  const granularity = input.granularity_minutes ?? DEFAULT_GRANULARITY_MINUTES
  const max_slots = input.max_slots ?? DEFAULT_MAX_SLOTS
  const preferred = input.preferred_hours ?? DEFAULT_PREFERRED_HOURS
  const localHourOf =
    input.clock_local_hour_of ?? ((iso: string): number => new Date(iso).getHours())

  const window_start_ms = Date.parse(input.window_start)
  const window_end_ms = Date.parse(input.window_end)
  const duration_ms = Math.max(0, Math.round(input.duration_minutes * 60_000))
  if (
    Number.isNaN(window_start_ms) ||
    Number.isNaN(window_end_ms) ||
    duration_ms <= 0 ||
    window_end_ms <= window_start_ms
  ) {
    return []
  }

  // Flatten + merge into a single "everyone busy" interval list.
  const flat: BusyInterval[] = []
  for (const arr of input.per_attendee_busy) {
    for (const row of arr) flat.push(row)
  }
  const merged = mergeIntervals(flat)

  const step_ms = Math.max(1, Math.round(granularity * 60_000))
  const out: TimeSlot[] = []
  for (let t = window_start_ms; t + duration_ms <= window_end_ms; t += step_ms) {
    const slot_end_ms = t + duration_ms
    // Reject overlap with ANY busy interval.
    let overlaps = false
    for (const m of merged) {
      // `[t, slot_end_ms)` overlaps `[m.start_ms, m.end_ms)` iff
      // `t < m.end_ms && slot_end_ms > m.start_ms`.
      if (t < m.end_ms && slot_end_ms > m.start_ms) {
        overlaps = true
        break
      }
    }
    if (overlaps) continue
    // Preferred-hours filter on START's local hour.
    const start_iso = new Date(t).toISOString()
    const hour = localHourOf(start_iso)
    if (hour < preferred[0] || hour >= preferred[1]) continue
    out.push({
      start: start_iso,
      end: new Date(slot_end_ms).toISOString(),
      attendees: [...input.attendees],
    })
    if (out.length >= max_slots) break
  }
  return out
}
