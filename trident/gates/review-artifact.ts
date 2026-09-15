import { readFile } from 'node:fs/promises'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import type { BuildSnapshot, GateResult } from '../build-run.ts'
import { briefIntegrity } from './brief-integrity.ts'
import { unknownCause } from './unknown-cause.ts'

/** Read back the context produced by prepareWork, through the worker's brief.
 * The host's measured bytes are the reference; a worker trailer is never used.
 */
export async function reviewArtifact(request: BoundedWorkRequest, snapshot: BuildSnapshot,
  read: (path: string) => Promise<string> = path => readFile(path, 'utf8')): Promise<GateResult> {
  const unknown = (detail: string): GateResult => ({ kind: 'unknown', detail })
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(snapshot.head) || !snapshot.diff.trim()) return unknown('Review artifact requires a full head and nonempty measured diff')
  try {
    const path = `${request.brief.path}.context.json`
    const brief = await read(request.brief.path)
    if (briefIntegrity(brief) !== request.brief.integrity || !brief.includes(path)) return unknown('Review brief does not reference its verified context artifact')
    const artifact = JSON.parse(await read(path))
    if (!artifact || artifact.request?.run_id !== request.run_id || artifact.request?.step_id !== request.step_id
      || artifact.request?.role !== 'review') return unknown('Review context artifact is missing the current dispatch identity')
    const observed = artifact.snapshot
    if (!observed || observed.head !== snapshot.head || observed.diff !== snapshot.diff
      || (snapshot.pr === null ? observed.pr !== null : observed.pr?.number !== snapshot.pr.number
        || observed.pr?.head !== snapshot.pr.head || observed.pr?.state !== snapshot.pr.state)) return unknown('Review context artifact disagrees with the measured revision')
    return { kind: 'allow' }
  } catch (error) { return unknownCause('Review context artifact or brief could not be read or decoded', error, request.run_id) }
}
