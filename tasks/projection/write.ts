/**
 * @neutronai/tasks/projection — debounced atomic projection writer (P6).
 *
 * Per the P6 brief § 4.10:
 *
 *   - STATUS.md gets a marked-block rewrite (preserves narrative).
 *   - ACTIONS.md is whole-file regenerated.
 *   - Both writes go through `fs.writeFile(tmp)` + `fs.rename(tmp, dst)`
 *     so a crash mid-write leaves the OLD file intact.
 *   - Mutations coalesce by `(project_slug, project_id)` for 500ms so
 *     a burst of 50 mutations across one project produces ONE write.
 *
 * The writer subscribes to a `TaskStore` mutation stream and resolves
 * the per-project file paths via the injected `resolveProjectDir`
 * function. Composition wires this against `<OWNER_HOME>/Projects/`.
 *
 * Cron-driven recompute does NOT trigger a projection re-write — the
 * cron rewrites `focus_score` but the projection reflects user-visible
 * state changes, not background score sweeps.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../../runtime/atomic-write.ts'
import { NO_PROJECT, type Task, type TaskStore } from '../store.ts'
import {
  renderActionsFile,
  renderStatusBlock,
} from './format.ts'
import { replaceMarkedBlock } from './parse.ts'

export const DEFAULT_PROJECTION_DEBOUNCE_MS = 500

/** Tasks completed within this many ms count as "Done (last 30 days)". */
const DONE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export interface ProjectionContext {
  project_slug: string
  /** Project being rewritten. The empty-string sentinel maps to an instance-level dir. */
  project_id: string
  /** Absolute path to `<OWNER_HOME>/Projects/<id>/`. */
  project_dir: string
  /** Optional display name for the H1 in ACTIONS.md. */
  project_name?: string
}

export interface ProjectionWriterOptions {
  store: TaskStore
  /**
   * Resolve the per-project directory + display name. Returning null
   * skips the projection for that (instance, project) pair entirely —
   * useful for the NO_PROJECT bucket OR an instance that opted out of
   * disk projections.
   */
  resolveProjectDir: (input: {
    project_slug: string
    project_id: string
  }) => { dir: string; name?: string } | null
  /** Override the 500ms coalesce window (testing seam). */
  debounce_ms?: number
  /** Override the wall clock (testing seam). */
  now?: () => number
  /** Override the structured log sink (testing seam). */
  log?: (event: ProjectionLogEvent) => void
}

export interface ProjectionWriter {
  /** Detach the task-store subscription + drain pending writes. */
  stop(): Promise<void>
  /** Force-flush the pending coalesce window (testing seam). */
  flushNow(): Promise<void>
  /** Last write count, observability seam for tests. */
  stats(): { writes: number; coalesced: number }
}

export type ProjectionLogEvent =
  | {
      kind: 'write_ok'
      project_slug: string
      project_id: string
      active: number
      done: number
      status_path: string
      actions_path: string
    }
  | {
      kind: 'write_error'
      project_slug: string
      project_id: string
      message: string
    }
  | {
      kind: 'skipped_no_dir'
      project_slug: string
      project_id: string
    }

interface PendingEntry {
  project_slug: string
  project_id: string
  scheduled_at: number
  timer: ReturnType<typeof setTimeout>
}

export function buildProjectionWriter(
  options: ProjectionWriterOptions,
): ProjectionWriter {
  const debounceMs = options.debounce_ms ?? DEFAULT_PROJECTION_DEBOUNCE_MS
  const now = options.now ?? ((): number => Date.now())
  const log = options.log ?? defaultLog
  const pending = new Map<string, PendingEntry>()
  const stats = { writes: 0, coalesced: 0 }
  let stopped = false

  function key(project_slug: string, project: string): string {
    return `${project_slug}\x00${project}`
  }

  function schedule(project_slug: string, project_id: string): void {
    if (stopped) return
    const k = key(project_slug, project_id)
    const existing = pending.get(k)
    if (existing !== undefined) {
      // Coalesce: clear the in-flight timer + start a fresh window.
      clearTimeout(existing.timer)
      stats.coalesced += 1
    }
    const timer = setTimeout(() => {
      pending.delete(k)
      void doWrite(project_slug, project_id)
    }, debounceMs)
    pending.set(k, {
      project_slug,
      project_id,
      scheduled_at: now(),
      timer,
    })
  }

  async function doWrite(project_slug: string, project_id: string): Promise<void> {
    if (stopped) return
    const resolved = options.resolveProjectDir({ project_slug, project_id })
    if (resolved === null) {
      log({ kind: 'skipped_no_dir', project_slug, project_id })
      return
    }
    try {
      const all = options.store.list({
        project_slug,
        project_id,
        status: 'all',
        order: 'focus_score',
        limit: 500,
      })
      const nowMs = now()
      const active: Task[] = all.filter((t) => t.status === 'open')
      const done: Task[] = all
        .filter((t) => t.status === 'done' && t.completed_at !== null)
        .filter((t) => nowMs - Date.parse(t.completed_at as string) <= DONE_WINDOW_MS)
        .sort(
          (a, b) =>
            Date.parse(b.completed_at as string) - Date.parse(a.completed_at as string),
        )
      const dirArg = resolved.dir
      const nameArg = resolved.name
      const statusPath = join(dirArg, 'STATUS.md')
      const actionsPath = join(dirArg, 'ACTIONS.md')
      mkdirSync(dirArg, { recursive: true })
      const lastUpdated = new Date(nowMs).toISOString()
      const body = renderStatusBlock({
        active,
        done,
        include_project_tag: false,
        include_focus_score: true,
      })
      let existing = ''
      try {
        existing = readFileSync(statusPath, 'utf8')
      } catch {
        existing = ''
      }
      const merged = replaceMarkedBlock(existing, body)
      await atomicWriteFile(statusPath, merged, { mode: 0o600 })
      const actionsInput: Parameters<typeof renderActionsFile>[0] = {
        active,
        done,
        project_id,
        last_updated_iso: lastUpdated,
      }
      if (nameArg !== undefined) actionsInput.project_name = nameArg
      const actionsBody = renderActionsFile(actionsInput)
      await atomicWriteFile(actionsPath, actionsBody, { mode: 0o600 })
      stats.writes += 1
      log({
        kind: 'write_ok',
        project_slug,
        project_id,
        active: active.length,
        done: done.length,
        status_path: statusPath,
        actions_path: actionsPath,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log({ kind: 'write_error', project_slug, project_id, message })
    }
  }

  const unsubscribe = options.store.subscribe((event) => {
    // Drive a write for the (instance, project) of every mutation, plus
    // an extra write for the previous project_id if the row moved
    // projects via update().
    schedule(event.task.project_slug, event.task.project_id)
    if (
      event.kind === 'update' &&
      event.previous !== undefined &&
      event.previous.project_id !== event.task.project_id
    ) {
      schedule(event.previous.project_slug, event.previous.project_id)
    }
  })

  return {
    async stop() {
      stopped = true
      unsubscribe()
      // Flush every pending coalesce window synchronously — tests rely
      // on this for deterministic ordering at shutdown.
      const drains: Array<Promise<void>> = []
      for (const [, entry] of pending) {
        clearTimeout(entry.timer)
        drains.push(doWrite(entry.project_slug, entry.project_id))
      }
      pending.clear()
      await Promise.all(drains)
    },
    async flushNow() {
      const drains: Array<Promise<void>> = []
      for (const [, entry] of pending) {
        clearTimeout(entry.timer)
        drains.push(doWrite(entry.project_slug, entry.project_id))
      }
      pending.clear()
      await Promise.all(drains)
    },
    stats() {
      return { writes: stats.writes, coalesced: stats.coalesced }
    },
  }

  // NO_PROJECT branch is implicit — `resolveProjectDir` can return
  // null for project_id === NO_PROJECT to skip the bucket entirely.
  void NO_PROJECT // silence unused import in some toolchains
}

function defaultLog(_event: ProjectionLogEvent): void {
  // Production callers inject a structured logger; the default is silent
  // to keep the test suite quiet.
}
