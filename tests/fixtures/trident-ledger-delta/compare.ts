/**
 * EXACT SINGLE-COMPLETION LEDGER DELTA COMPARATOR (test support).
 *
 * Compares two ledgers decoded by `./decode.ts` and accepts only the one
 * legitimate step a task-sequence handoff may take: the FIRST unchecked task of
 * `before` flips to checked in `after`, and nothing else changes. This is a
 * synthetic fixture comparator for build E2E assertions, NOT the production
 * plan tick, and it imports nothing from the harness.
 *
 * Rules, evaluated in this order; the FIRST violation is reported:
 *   1. both ledgers have the same number of tasks;
 *   2. every task keeps its exact label at its exact index (this rejects
 *      relabeling, insertion, removal and reordering, even when the
 *      completed/remaining totals happen to match a legitimate step);
 *   3. `before` has at least one unchecked task (a fully completed ledger
 *      cannot advance);
 *   4. the first unchecked task of `before` is checked in `after` (rejects the
 *      no-op and the skipped task);
 *   5. every other task keeps its checkbox (rejects reversal and completing
 *      two tasks at once).
 *
 * Pure: the inputs are only read, fresh objects are returned on every call,
 * and `compareLedgerDelta` never throws. Rejection reasons name the violated
 * rule and a zero-based task index only, never any label bytes.
 */

import { summarizeLedger, type DecodedLedger, type LedgerSummary } from './decode.ts'

export type LedgerDeltaResult =
  | { readonly ok: true; readonly completedLabel: string; readonly after: LedgerSummary }
  | { readonly ok: false; readonly reason: string }

function reject(reason: string): LedgerDeltaResult {
  return { ok: false, reason }
}

export function compareLedgerDelta(before: DecodedLedger, after: DecodedLedger): LedgerDeltaResult {
  const beforeTasks = before.tasks
  const afterTasks = after.tasks
  if (beforeTasks.length !== afterTasks.length) return reject('task count differs')
  for (let index = 0; index < beforeTasks.length; index += 1) {
    if (beforeTasks[index]!.label !== afterTasks[index]!.label) return reject(`task ${index}: label differs`)
  }
  const target = beforeTasks.findIndex((task) => !task.completed)
  if (target === -1) return reject('before has no unchecked task')
  if (!afterTasks[target]!.completed) return reject(`task ${target}: first unchecked task not completed`)
  for (let index = 0; index < beforeTasks.length; index += 1) {
    if (index === target) continue
    if (afterTasks[index]!.completed !== beforeTasks[index]!.completed) return reject(`task ${index}: checkbox changed`)
  }
  return { ok: true, completedLabel: beforeTasks[target]!.label, after: summarizeLedger(after) }
}
