/**
 * @neutronai/runtime — subagent completion announcement.
 *
 * When a subagent reaches a terminal state, format a structured summary that
 * the parent can splice into its conversation context as a synthetic
 * `tool_result` (or post to the `delivery_target` channel if cron-isolated).
 *
 * Lifted from OpenClaw's `subagent-announce.ts`. Pure formatter — no I/O.
 * The actual injection / delivery happens in the gateway-side caller (S4).
 */

import type { SubagentRecord } from './registry.ts'

export interface AnnouncementPayload {
  run_id: string
  agent_kind: string
  status: SubagentRecord['status']
  duration_ms?: number
  dollars?: number
  summary: string
  deliverables: string[]
  /** When set, the announcement should be posted to this delivery target instead of injected as a tool_result. */
  delivery_target?: { channel: string; binding_id: string }
}

export interface FormatAnnouncementInput {
  record: SubagentRecord
  /** Free-form synthetic summary string the caller assembled (e.g. from the subagent's last assistant message). */
  summary: string
  /** List of deliverables (PR URLs, file paths, dashboard urls) the subagent claims to have produced. */
  deliverables?: string[]
  /** USD cost — populated only for Private substrate runs. */
  dollars?: number
}

export function formatAnnouncement(input: FormatAnnouncementInput): AnnouncementPayload {
  const r = input.record
  const duration_ms =
    r.ended_at !== undefined && r.started_at !== undefined ? r.ended_at - r.started_at : undefined
  const out: AnnouncementPayload = {
    run_id: r.run_id,
    agent_kind: r.agent_kind,
    status: r.status,
    summary: input.summary,
    deliverables: input.deliverables ?? [],
  }
  if (duration_ms !== undefined) out.duration_ms = duration_ms
  if (input.dollars !== undefined) out.dollars = input.dollars
  if (r.delivery_target !== undefined) out.delivery_target = r.delivery_target
  return out
}

/**
 * Render an announcement to the canonical Markdown shape used by parent
 * agents to splice into their context. Stable order so the prompt cache stays
 * warm across nearly-identical announcements.
 */
export function renderAnnouncementMarkdown(p: AnnouncementPayload): string {
  const lines: string[] = []
  lines.push(`### Subagent ${p.agent_kind} (${p.status})`)
  lines.push(`- run_id: \`${p.run_id}\``)
  if (p.duration_ms !== undefined) lines.push(`- duration: ${p.duration_ms}ms`)
  if (p.dollars !== undefined) lines.push(`- cost: $${p.dollars.toFixed(4)}`)
  lines.push('')
  lines.push(p.summary.trim())
  if (p.deliverables.length > 0) {
    lines.push('')
    lines.push('Deliverables:')
    for (const d of p.deliverables) lines.push(`- ${d}`)
  }
  return lines.join('\n')
}
