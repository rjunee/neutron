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

import type { AgentWatchdogEvent, AgentWatchdogNotifier } from '@neutronai/runtime/subagent/watchdog.ts'
import type { SubagentRecord } from '@neutronai/runtime/subagent/registry.ts'
import type { BootSweepReport } from '@neutronai/runtime/subagent/boot-sweep.ts'
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

/**
 * Adapt the boot reap's `SubagentRecord` report (`runtime/subagent/boot-sweep.ts`)
 * onto the dispatch report-back surface. Reuses `buildDispatchWatchdogNotifier`,
 * so a boot-reaped orphan surfaces exactly like a live watchdog reap — same
 * `crashed` DispatchReport shape, same forge/argus skip (those belong to the
 * Trident loop's own supervision), same best-effort swallow-on-failure.
 *
 * SHARED production code: `open/composer.ts` wires this as the boot sweep's
 * report sink, and the wiring test exercises this exact function — so the test
 * cannot pass against a different/omitted mapping (Codex test-quality point).
 */
export function buildBootSweepReport(report: DispatchReporter): BootSweepReport {
  const notifier = buildDispatchWatchdogNotifier(report)
  return (rec: SubagentRecord) => {
    const detected_at = rec.ended_at ?? Date.now()
    // Age matches what a LIVE watchdog reap reports for the same record. The live
    // watchdog (`runtime/subagent/watchdog.ts`) computes `age_ms = now - progressAt`
    // where `progressAt` is the last PROGRESS timestamp (`last_event_at`, since a
    // prior-process orphan has no live JSONL probe to override it). Using
    // `started_at` here instead would over-report the age by the whole run duration
    // (e.g. started_at=0, last_event_at=900, detected_at=1000 → 1000ms vs the
    // watchdog's 100ms), contradicting the "surfaces exactly like a live reap"
    // contract. Fall back to `started_at` only if a malformed record lacks a
    // progress timestamp.
    const progress_at = rec.last_event_at ?? rec.started_at
    return notifier({
      run_id: rec.run_id,
      agent_kind: rec.agent_kind,
      instance_key: rec.instance_key,
      reason: 'process_dead',
      last_event_at: rec.last_event_at,
      detected_at,
      age_ms: detected_at - progress_at,
      ...(rec.delivery_target !== undefined ? { delivery_target: rec.delivery_target } : {}),
      ...(rec.pid !== undefined ? { pid: rec.pid } : {}),
    })
  }
}
