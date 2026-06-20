/**
 * Action 1 — first-week brief.
 *
 * Per docs/plans/P2-onboarding.md § 2.5 #1. Always fires. LAST in
 * dispatch order so it can summarize what fired before it. Synth output
 * to the active topic — no permission gate, no external effect.
 *
 * Reversibility: idempotent. Re-running re-emits the brief; older
 * briefs stay in chat.
 *
 * Failure mode: if the substrate dispatch errors, the action-runner
 * retries once with backoff 30s; second failure → mark
 * `success: false, reason: 'substrate-error'`.
 *
 * Telemetry: `read_status` is best-effort (P2 captures `delivered` ack
 * only — `read` lands when Telegram delivers the eventual read receipt,
 * via the engagement callback path).
 *
 * 2026-05-28 wow-cleanup sprint:
 *  - Welcome line addresses the USER (`phase_state_json.user_first_name`),
 *    not the agent. Sam saw "Welcome rainman" because the engine was
 *    setting `display_name = agent_name`. The action is now defensive
 *    against that even when the engine wiring is stale.
 *  - The brief inlines the actual import items (projects, tasks,
 *    reminders) instead of bare counts so the user can see WHAT is in
 *    the summary, not just how many there are.
 *  - The opaque "I will check in tomorrow morning with the overnight
 *    pass" line is replaced with an explicit preview of what the
 *    overnight pass will work on while the user sleeps.
 *
 * 2026-06-09 (onboarding-wow-handoff-fix, Argus r1 BLOCKER #2):
 *  - The action NO LONGER emits a follow-up button prompt. It used to
 *    emit a single-button [A] Start overnight pass affordance (+
 *    `allow_freeform`) after the brief text and ride the prompt id out
 *    on `WowActionResult.follow_up_prompt_id`. The GAP3 fix in the same
 *    PR made `dispatchWowAndAdvance` ALWAYS advance to `completed` and
 *    emit the final-handoff GUIDE as the terminal General message —
 *    which left that brief affordance as a STALE, still-tappable button
 *    at a terminal phase. Every tap on it returned `noop_terminal` (no
 *    routing, no ack → the deterministic typing indicator spins forever;
 *    the documented r4 stuck-typing class / ISSUES #115). The brief
 *    explicitly warned against leaving "a separate competing prompt."
 *    Fix: deliver ONLY the brief text. There is no competing tappable
 *    surface after the guide. The overnight pass is registered
 *    unconditionally by action-07 regardless of any tap, and the
 *    [A] button gated an unbuilt feature — so removing the affordance
 *    loses no real capability. Post-completion the final-handoff guide
 *    is the single active prompt and itself accepts freeform, so the
 *    user can still ask for changes by typing.
 */

import type { WowActionContext, WowActionModule, WowActionResult } from '../action-types.ts'
import type { ImportResult } from '../../history-import/types.ts'
import type { WowEngagement } from '../telemetry.ts'
import { OvernightQueueStore, type OvernightItem } from '../../overnight/queue-store.ts'

const ACTION_ID = '01-first-week-brief' as const

const INLINE_LIST_CAP = 8
const OVERNIGHT_PREVIEW_CAP = 6

const action01: WowActionModule = {
  action_id: ACTION_ID,

  triggerCondition(_ctx: WowActionContext): boolean {
    return true
  },

  async run(ctx: WowActionContext): Promise<WowActionResult> {
    let body: string
    let tokens_used = 0
    if (ctx.substrate !== undefined) {
      const out = await ctx.substrate.composeBrief({
        project_slug: ctx.project_slug,
        interview: ctx.interview,
        import_result: ctx.import_result,
      })
      body = out.body
      tokens_used = out.tokens_used
    } else {
      body = templateBrief(ctx)
    }
    await ctx.channel.sendText({
      topic_id: ctx.topic_id,
      body,
    })
    // 2026-06-09 (Argus r1 BLOCKER #2) — NO follow-up button prompt.
    // See the file header: the brief affordance became a stale tappable
    // noop after the GAP3 guide-fires change. The brief delivers text
    // only; no `follow_up_prompt_id` so the dispatcher never surfaces a
    // `brief_prompt_id` and the engine has no competing prompt to leave
    // dangling at `completed`.
    return {
      fired: true,
      reason: 'delivered',
      redacted_payload: {
        body_length: body.length,
        tokens_used,
        used_substrate: ctx.substrate !== undefined,
      },
    }
  },

  decodeEngagement(value: string): WowEngagement | null {
    if (value === 'read' || value === 'scrolled' || value === 'idle') return value
    return null
  },
}

/**
 * Template fallback when no substrate is wired. The prose stays terse +
 * specific so it doesn't read as filler — short bullets that cite the
 * captured archetype + name + (when present) the import-result topic
 * count + ritual count. This is the safety-net, not the production
 * path; production wires a real substrate.
 */
function templateBrief(ctx: WowActionContext): string {
  const name = readUserFirstName(ctx) ?? 'friend'
  const archetype = ctx.interview.archetype_blend?.[0] ?? 'guide'
  const lines: string[] = []
  lines.push(`Welcome ${name}. Here is the week ahead through a ${archetype} lens.`)
  lines.push('')
  appendProjectsSection(ctx, lines)
  appendTasksSection(ctx, lines)
  appendRemindersSection(ctx, lines)
  appendRitualsSection(ctx, lines)
  appendOvernightPreview(ctx, lines)
  return lines.join('\n').trimEnd()
}

/**
 * Prefer the user's captured first name; only consult `display_name` as
 * a last-resort fallback because legacy engine wiring conflated it with
 * the agent's name (incident 2026-05-28: "Welcome rainman").
 */
function readUserFirstName(ctx: WowActionContext): string | undefined {
  const ps = ctx.interview.phase_state_json ?? {}
  const v = ps['user_first_name']
  if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  if (
    typeof ctx.interview.display_name === 'string' &&
    ctx.interview.display_name.trim().length > 0
  ) {
    return ctx.interview.display_name.trim()
  }
  return undefined
}

function appendProjectsSection(ctx: WowActionContext, lines: string[]): void {
  const merged = mergeProjects(ctx)
  if (merged.length === 0) return
  lines.push(`Projects on deck (${merged.length}):`)
  for (const p of merged.slice(0, INLINE_LIST_CAP)) {
    lines.push(`- ${p}`)
  }
  if (merged.length > INLINE_LIST_CAP) {
    lines.push(`- …and ${merged.length - INLINE_LIST_CAP} more`)
  }
  lines.push('')
}

function appendTasksSection(ctx: WowActionContext, lines: string[]): void {
  const tasks = ctx.import_result?.proposed_tasks ?? []
  if (tasks.length === 0) return
  lines.push(`Tasks queued (${tasks.length}):`)
  for (const t of tasks.slice(0, INLINE_LIST_CAP)) {
    const due = typeof t.due_at === 'number' ? ` — due ${formatDueDate(t.due_at)}` : ''
    const prio = t.priority_hint !== undefined ? ` [${t.priority_hint}]` : ''
    lines.push(`- ${t.title}${prio}${due}`)
  }
  if (tasks.length > INLINE_LIST_CAP) {
    lines.push(`- …and ${tasks.length - INLINE_LIST_CAP} more`)
  }
  lines.push('')
}

function appendRemindersSection(ctx: WowActionContext, lines: string[]): void {
  const reminders = ctx.import_result?.proposed_reminders ?? []
  if (reminders.length === 0) return
  lines.push(`Reminders suggested (${reminders.length}):`)
  for (const r of reminders.slice(0, INLINE_LIST_CAP)) {
    lines.push(`- ${r.body} (${r.pattern})`)
  }
  if (reminders.length > INLINE_LIST_CAP) {
    lines.push(`- …and ${reminders.length - INLINE_LIST_CAP} more`)
  }
  lines.push('')
}

function appendRitualsSection(ctx: WowActionContext, lines: string[]): void {
  if (ctx.rituals.length === 0) return
  lines.push(`Rituals tracked (${ctx.rituals.length}):`)
  for (const r of ctx.rituals.slice(0, INLINE_LIST_CAP)) {
    lines.push(`- ${r.kind} ${r.label} at ${r.time_of_day}`)
  }
  lines.push('')
}

/**
 * Honest-by-construction overnight section.
 *
 * 2026-06-20 (go-live, brief-truthful, owner decision option A):
 * The brief used to ASSERT "I've queued these to work on overnight while
 * you sleep" + "I'll run the overnight pass at 7am tomorrow" off
 * SPECULATIVE items derived from the dispatch context (stalled threads,
 * proposed tasks). Nothing was ever written to the real `overnight_queue`
 * at onboarding (owner DB: overnight_queue = 0 rows, reminders = 0 rows),
 * so those were FABRICATED claims that must not ship. We now read the
 * real `overnight_queue` for this project at render time:
 *  - if it has genuinely queued / in-flight rows, reflect them (control);
 *  - otherwise (the onboarding reality) emit an OFFER, never a
 *    fabricated schedule. We never claim scheduled overnight work or set
 *    reminders unless the real tables back it.
 * Reading the live table is self-correcting: a later brief reflects
 * whatever was actually queued by then.
 *
 * Option B (actually wiring real overnight work at onboarding) is a
 * logged post-launch follow-up, out of scope here.
 *
 * The per-project pointer ("each project on the left has its own topic")
 * is kept because it IS true: the engine seeds a topic per kept project
 * (engine → onboardingHandoff.emitProjectSeeds).
 */
function appendOvernightPreview(ctx: WowActionContext, lines: string[]): void {
  const queued = readQueuedOvernight(ctx)
  const projects = mergeProjects(ctx)
  if (projects.length > 0) {
    lines.push("Each project on the left has its own topic. Open one to see what's inside.")
    lines.push('')
  }
  if (queued.length > 0) {
    // Control branch — real rows exist; reflect them truthfully.
    lines.push("I've queued these to work on overnight while you sleep:")
    for (const item of queued.slice(0, OVERNIGHT_PREVIEW_CAP)) {
      lines.push(`- ${item.description}`)
    }
    if (queued.length > OVERNIGHT_PREVIEW_CAP) {
      lines.push(`- ...and ${queued.length - OVERNIGHT_PREVIEW_CAP} more`)
    }
    lines.push('')
    lines.push(
      "I'll work through that queue overnight and surface anything that needs you in the morning. You can change what's queued anytime, just tell me.",
    )
    return
  }
  // OFFER branch — nothing is genuinely queued (the onboarding reality).
  // Do NOT claim scheduled/queued overnight work or set reminders. Offer
  // it with a concrete, non-fabricated example drawn from a real kept
  // project when available.
  const exampleProject = projects[0]
  const overnightExample =
    exampleProject !== undefined
      ? `"schedule overnight research on ${exampleProject}"`
      : '"schedule overnight work on a project"'
  lines.push(
    `Nothing is scheduled overnight yet. I can run autonomous overnight work or set reminders whenever you want, just ask (for example ${overnightExample} or "remind me Monday 9am").`,
  )
}

/**
 * Read the genuinely-queued overnight items for this project from the
 * real `overnight_queue` table (the runtime source of truth). Honest
 * default: any read failure returns [], so the brief OFFERS rather than
 * fabricating a schedule it cannot verify. Only `queued` / `in-flight`
 * rows count as "queued to work on" — terminal (completed / failed) rows
 * are history, not a promise.
 */
function readQueuedOvernight(ctx: WowActionContext): OvernightItem[] {
  try {
    const store = new OvernightQueueStore(ctx.db)
    return store
      .listByProject(ctx.project_slug)
      .filter((it) => it.status === 'queued' || it.status === 'in-flight')
  } catch {
    return []
  }
}

function mergeProjects(ctx: WowActionContext): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const p of ctx.captured_projects) {
    const key = p.name.trim().toLowerCase()
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    merged.push(p.name.trim())
  }
  // #309 fix (2026-06-19, owner live-dogfold) — RESPECT THE USER'S TRIM.
  // When the engine observed a `projects_proposed` confirmation
  // (`ctx.projects_confirmed === true`), `ctx.captured_projects` IS the
  // user's kept set (plumbed from `primary_projects_confirmed`). Merging
  // the full `import_result.proposed_projects` back in resurrected every
  // project the user explicitly trimmed away — the owner asked to trim to
  // 4 and the brief still rendered all 9 (`Projects on deck (9)`). Mirror
  // `03-project-shells.mergedProjects`: skip the import merge whenever a
  // confirmation was observed. Legacy / unconfirmed callers keep the
  // dedupe-merge so a fixture with 0 captured + N imported still renders.
  const hasConfirmed = ctx.projects_confirmed === true
  if (!hasConfirmed && ctx.import_result !== null) {
    for (const p of ctx.import_result.proposed_projects) {
      const key = p.name.trim().toLowerCase()
      if (key.length === 0 || seen.has(key)) continue
      seen.add(key)
      merged.push(p.name.trim())
    }
  }
  return merged
}

function formatDueDate(due_at_ms: number): string {
  const d = new Date(due_at_ms)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Retain the export-friendly summary helper for any external caller that
// still wants the bare-count line (telemetry / breakage reports). The
// user-visible brief no longer renders this directly.
export function briefSummaryFromImport(r: ImportResult): string {
  const projects = r.proposed_projects.length
  const tasks = r.proposed_tasks.length
  const reminders = r.proposed_reminders.length
  return `From your import: ${projects} project ideas, ${tasks} pending tasks, ${reminders} suggested reminders.`
}

export default action01
