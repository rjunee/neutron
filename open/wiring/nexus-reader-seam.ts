/**
 * RC3 ([BEHAVIOR]) — the Open composer's agent-nexus READER seam.
 *
 * The composer wires ONE `nexusSnapshot` seam onto `buildLiveAgentTurn` so every
 * orchestrator/chat turn re-grounds on the recent decision/handoff/learning
 * events other agents recorded. This module owns the two load-bearing bits of
 * that wiring — the perfect-recall FLAG GATE and the project SCOPE composition —
 * as a named, testable unit (mirroring RC2's `buildTridentTerminalObserver`),
 * rather than an untestable inline closure in `composer.ts`:
 *
 *   - GATE: when the shared perfect-recall flag is off, `wireMemory` builds no
 *     `NexusStore` (`nexus === null`), so this returns `undefined` and the
 *     composer spreads NO seam — RC3 stays DARK, `buildLiveAgentTurn` behaves
 *     exactly as today.
 *   - SCOPE: the seam maps the per-turn `(project_slug, project_id)` through the
 *     SAME `workBoardScopeKey` RC2's emitters write to (General → owner slug; a
 *     named project → its id), so the reader sees exactly what the producers
 *     wrote for THIS project — no cross-project leak, no General/project mismatch.
 */

import { buildAgentNexusSnapshot } from '@neutronai/gateway/nexus/nexus-fragment.ts'
import type { NexusStore } from '@neutronai/gateway/nexus/nexus-store.ts'
import { workBoardScopeKey } from '@neutronai/work-board/store.ts'

/** The `buildLiveAgentTurn` `nexusSnapshot` seam shape — async because the nexus
 *  sidecar read is async. */
export type NexusReaderSeam = (
  project_slug: string,
  project_id: string | undefined,
) => Promise<string | null>

/**
 * Build the flag-gated, scope-composed nexus reader seam for the live-agent turn.
 * Returns `undefined` when `nexus` is null (perfect-recall off) so the composer
 * wires no seam; otherwise a best-effort reader that formats the `<agent_nexus>`
 * block for the turn's `workBoardScopeKey`-derived project scope.
 */
export function buildNexusReaderSeam(
  nexus: NexusStore | null,
): NexusReaderSeam | undefined {
  if (nexus === null) return undefined
  return (project_slug, project_id): Promise<string | null> =>
    buildAgentNexusSnapshot(nexus, workBoardScopeKey(project_slug, project_id))
}
