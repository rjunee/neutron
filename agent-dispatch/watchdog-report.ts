/**
 * @neutronai/agent-dispatch — watchdog → report-back adapter.
 *
 * The already-ported agent-aware watchdog (`runtime/subagent/watchdog.ts`)
 * reaps a stuck/dead LIVE record, marks it `crashed`, and SURFACES a structured
 * `AgentWatchdogEvent` through an injected `notify` sink. This adapter turns
 * that event into a dispatch `report` so a supervised failure reaches the SAME
 * report-back surface a clean completion does — a dispatched agent that wedges
 * or dies never just silently vanishes from `live()`.
 *
 * It only handles the three kinds THIS dispatcher owns (`atlas`/`sentinel`/
 * `core` → research/review/adhoc). A `forge`/`argus` watchdog event belongs to
 * the Trident loop and is skipped (returns without reporting), so wiring this
 * notifier alongside Trident's own supervision does not double-report a build
 * agent.
 */

import type { AgentWatchdogEvent, AgentWatchdogNotifier } from '../runtime/subagent/watchdog.ts'
import { DISPATCH_KIND_BY_AGENT_KIND } from './prompts.ts'
import type { DispatchReport, DispatchReporter } from './service.ts'

/** Build a watchdog notifier that forwards dispatch failures to `report`. */
export function buildDispatchWatchdogNotifier(report: DispatchReporter): AgentWatchdogNotifier {
  return async (event: AgentWatchdogEvent): Promise<void> => {
    const kind = DISPATCH_KIND_BY_AGENT_KIND[event.agent_kind]
    if (kind === undefined) return // forge/argus — Trident's, not ours

    const reasonText =
      event.reason === 'process_dead'
        ? 'the agent process died before reporting a result'
        : 'the agent made no progress past its inactivity threshold and was reaped'
    const markdown = [
      `### Subagent ${event.agent_kind} (crashed — ${event.reason})`,
      `- run_id: \`${event.run_id}\``,
      `- age at reap: ${event.age_ms}ms`,
      '',
      `Supervisor reaped this dispatch: ${reasonText}. No result was delivered.`,
    ].join('\n')

    const out: DispatchReport = {
      run_id: event.run_id,
      kind,
      agent_kind: event.agent_kind,
      status: 'crashed',
      markdown,
      payload: {
        run_id: event.run_id,
        agent_kind: event.agent_kind,
        status: 'crashed',
        summary: `Dispatch reaped by the supervisor (${event.reason}).`,
        deliverables: [],
      },
      result: '',
    }
    if (event.delivery_target !== undefined) out.delivery_target = event.delivery_target

    try {
      await report(out)
    } catch {
      // Best-effort — a report failure must not abort the watchdog tick.
    }
  }
}
