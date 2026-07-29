/**
 * @neutronai/gateway/http — Expo-app current-focus-pick surface (P6.1).
 *
 * Per docs/plans/2026-05-23-002-feat-p6-1-nudge-engine-staleness-current-focus-pick-plan.md
 * Part C.2.
 *
 *   - `GET /api/app/focus/current` → today's nudge pick + the joined
 *     `Task` row + LLM rationale, OR 404 when no row exists for today,
 *     OR 401 on missing / wrong auth.
 *
 * Returns null from the handler for non-matching paths so the
 * compose-chain falls through to sibling surfaces. Mirrors the auth +
 * jsonResponse + bearer-resolution shape of `app-focus-surface.ts`.
 */

import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { jsonResponse, resolveBearer } from './surface-kit.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { NO_PROJECT, type Task } from '@neutronai/tasks/store.ts'
import { resolveOwnerDay, DEFAULT_OWNER_TIMEZONE } from '../tasks/p6/nudge-engine.ts'

const FOCUS_CURRENT_PATH = '/api/app/focus/current'

export interface CurrentFocusPickPayload {
  /** Owner-local YYYY-MM-DD. */
  day: string
  /** Task id of the picked task. */
  task_id: string
  /** The full canonical Task row (joined from `tasks`). */
  task: Task
  /** Single sentence rationale from the LLM (clamped to NUDGE_RATIONALE_MAX_CHARS). */
  llm_rationale: string
  /** ISO-8601 timestamp of the persist (nudge cron tick). */
  created_at: string
  /** Anthropic model id the pick was made with. */
  llm_model: string
}

export interface FocusCurrentResponse {
  ok: true
  project_slug: string
  /** ISO-8601 of the server's wall clock when serving the response. */
  now: string
  pick: CurrentFocusPickPayload
}

export interface AppFocusCurrentSurfaceOptions {
  db: ProjectDb
  auth: AppWsAuthResolver
  /** Override Date.now (test seam). */
  now?: () => number
  /** Override instance timezone (test seam). Production reads instance_metadata. */
  timezone?: string
}

export interface AppFocusCurrentSurface {
  handler: (req: Request) => Promise<Response | null>
}

interface PickRow {
  task_id: string
  llm_rationale: string
  created_at: string
  llm_model: string
}

interface TaskRowFull {
  id: string
  project_slug: string
  project_id: string
  title: string
  description: string | null
  status: 'open' | 'done' | 'cancelled'
  priority: number | null
  due_date: string | null
  owner_persona: string | null
  source: string | null
  focus_score: number | null
  focus_score_updated_at: string | null
  llm_rank: number | null
  llm_reason: string | null
  prioritized_by: 'llm' | 'deterministic' | null
  prioritized_at: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export function createAppFocusCurrentSurface(
  opts: AppFocusCurrentSurfaceOptions,
): AppFocusCurrentSurface {
  const { db, auth } = opts
  const now = opts.now ?? ((): number => Date.now())
  const tz = opts.timezone ?? DEFAULT_OWNER_TIMEZONE
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      if (url.pathname !== FOCUS_CURRENT_PATH) return null

      if (req.method !== 'GET') {
        return jsonResponse(405, {
          ok: false,
          code: 'method_not_allowed',
          message: `expected GET ${FOCUS_CURRENT_PATH}, got ${req.method}`,
        })
      }

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        // Same flattening as app-focus-surface.ts — surface generic
        // 'unauthorized' rather than leaking jose claim-validation
        // detail.
        const wireCode =
          resolved.code === 'missing_bearer' ? 'missing_bearer' : 'unauthorized'
        const wireMessage =
          resolved.code === 'missing_bearer'
            ? resolved.message
            : 'authentication required'
        return jsonResponse(401, {
          ok: false,
          code: wireCode,
          message: wireMessage,
        })
      }

      const nowMs = now()
      const day = resolveOwnerDay(nowMs, tz)

      const pick = db
        .prepare<PickRow, [string, string]>(
          `SELECT task_id, llm_rationale, created_at, llm_model
             FROM current_focus_pick
            WHERE project_slug = ? AND day = ?
            LIMIT 1`,
        )
        .get(resolved.project_slug, day)
      if (pick === null || pick === undefined) {
        return jsonResponse(404, {
          ok: false,
          code: 'no_pick_today',
          message: `no current focus pick for ${resolved.project_slug} on ${day}`,
        })
      }

      const taskRow = db
        .prepare<TaskRowFull, [string, string]>(
          `SELECT id, project_slug, project_id, title, description, status,
                  priority, due_date, owner_persona, source, focus_score,
                  focus_score_updated_at, llm_rank, llm_reason, prioritized_by,
                  prioritized_at, created_at, updated_at, completed_at
             FROM tasks
            WHERE project_slug = ? AND id = ?
            LIMIT 1`,
        )
        .get(resolved.project_slug, pick.task_id)
      if (taskRow === null || taskRow === undefined) {
        // Pick row exists but the task has been hard-deleted. Treat
        // as "stale pick" → 404 so the app hides the hero card. The
        // next cron tick will pick a new task.
        return jsonResponse(404, {
          ok: false,
          code: 'pick_task_missing',
          message: `pick references a task that no longer exists`,
        })
      }

      const task: Task = {
        id: taskRow.id,
        project_slug: taskRow.project_slug,
        project_id:
          taskRow.project_id === NO_PROJECT ? NO_PROJECT : taskRow.project_id,
        title: taskRow.title,
        description: taskRow.description,
        status: taskRow.status,
        priority: taskRow.priority,
        due_date: taskRow.due_date,
        owner_persona: taskRow.owner_persona,
        source: taskRow.source,
        focus_score: taskRow.focus_score,
        focus_score_updated_at: taskRow.focus_score_updated_at,
        llm_rank: taskRow.llm_rank,
        llm_reason: taskRow.llm_reason,
        prioritized_by: taskRow.prioritized_by,
        prioritized_at: taskRow.prioritized_at,
        created_at: taskRow.created_at,
        updated_at: taskRow.updated_at,
        completed_at: taskRow.completed_at,
      }
      const body: FocusCurrentResponse = {
        ok: true,
        project_slug: resolved.project_slug,
        now: new Date(nowMs).toISOString(),
        pick: {
          day,
          task_id: pick.task_id,
          task,
          llm_rationale: pick.llm_rationale,
          created_at: pick.created_at,
          llm_model: pick.llm_model,
        },
      }
      return jsonResponse(200, body)
    },
  }
}

