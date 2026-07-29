/**
 * @neutronai/onboarding/synthesis — informed-interview question generator
 * (Step 2).
 *
 * The interview session asks questions GROUNDED in the synthesis user-model
 * ("I see you've been on the Apollo launch ~6 months with Sam on
 * compliance — want a dedicated project?") rather than generic "tell me more"
 * prompts. This is the seam the interview engine consumes: given the
 * accumulated `UserModel`, produce an informed question that references real
 * imported content, or `null` when the model is empty (the caller falls back
 * to a generic warm question — e.g. the no-import path before synthesis has
 * stood anything up).
 *
 * Pure + deterministic so it's cheaply unit-testable and never blocks a turn
 * (it draws on the already-synthesized model, not a fresh LLM call). House
 * style: no em dashes in generated copy.
 */

import type { ProjectModel, UserModel } from './types.ts'

export interface InformedQuestion {
  /** The question text to ask the user. */
  text: string
  /** The project slug the question is grounded in (for the accept → populate hop). */
  owner_slug: string
  /** True iff the question references a specific person from the model. */
  references_person: boolean
}

export interface BuildInformedQuestionOptions {
  /** Project slugs already proposed/handled this session — skip them. */
  skip_slugs?: ReadonlyArray<string>
}

/**
 * Build ONE informed question grounded in the user-model. Picks the
 * highest-signal unhandled project (most routed conversations, then richest
 * overview) and weaves in a related person when the model has any. Returns
 * `null` when there is no project to ground a question in.
 */
export function buildInformedQuestion(
  model: UserModel,
  opts: BuildInformedQuestionOptions = {},
): InformedQuestion | null {
  const skip = new Set(opts.skip_slugs ?? [])
  const candidate = pickProject(model.projects, skip)
  if (candidate === null) return null

  const person = model.people.find((p) => p.trim().length > 0) ?? null
  const personClause = person !== null ? ` with ${firstName(person)}` : ''
  const statusClause = candidate.status.length > 0 ? ` (${candidate.status})` : ''

  const text =
    `I see you've been working on ${candidate.name}${statusClause}${personClause}. ` +
    `Want me to set up a dedicated project for it, pre-populated with what I found?`

  return {
    text,
    owner_slug: candidate.slug,
    references_person: person !== null,
  }
}

/**
 * Build the full ordered set of informed questions (one per project, highest
 * signal first). The interview asks them in order, skipping accepted/declined
 * slugs across turns.
 */
export function buildInformedQuestionQueue(model: UserModel): InformedQuestion[] {
  const out: InformedQuestion[] = []
  const handled = new Set<string>()
  for (;;) {
    const q = buildInformedQuestion(model, { skip_slugs: [...handled] })
    if (q === null) break
    out.push(q)
    handled.add(q.owner_slug)
  }
  return out
}

function pickProject(
  projects: ReadonlyArray<ProjectModel>,
  skip: ReadonlySet<string>,
): ProjectModel | null {
  let best: ProjectModel | null = null
  for (const p of projects) {
    if (p.name.trim().length === 0) continue
    if (skip.has(p.slug)) continue
    if (best === null || signal(p) > signal(best)) best = p
  }
  return best
}

/** Higher = more grounded: routed-conversation count dominates, overview length breaks ties. */
function signal(p: ProjectModel): number {
  return p.conversation_ids.length * 1000 + p.overview.length
}

function firstName(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0]
  return first !== undefined && first.length > 0 ? first : fullName.trim()
}
