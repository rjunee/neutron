import { join } from 'node:path'

/** Shared by the live panel producer and passive result inspection. */
export function projectReviewArtifacts(evidenceRoot: string, identity: string) {
  const directory = join(evidenceRoot, `review-${identity}`)
  return { directory, brief: join(directory, 'brief.json'), result: join(directory, 'result.json') }
}

export function projectReviewStep(identity: string, round: number, attempt: number): string {
  return `review-${identity}:${round}:${attempt}`
}

export function projectReviewStepIdentity(step: string): string | null {
  const match = /^review-([a-f0-9]{64}):([1-9][0-9]*):([01])$/.exec(step)
  if (!match || !Number.isSafeInteger(Number(match[2]))
    || projectReviewStep(match[1]!, Number(match[2]), Number(match[3])) !== step) return null
  return match[1]!
}
