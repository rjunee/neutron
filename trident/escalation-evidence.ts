/**
 * @neutronai/trident — THE ESCALATION VOCABULARY, AND THE ONE DECODER FOR IT.
 *
 * A LEAF MODULE ON PURPOSE, and the reason is the same one that produced
 * `checkpoint-findings.ts`: the STORE has to be able to read this evidence, and
 * `inner-loop.ts` imports a value from `store.ts`, so the store cannot import the decoder
 * back without a cycle. A guard that cannot see the evidence which would satisfy it is
 * unsatisfiable by construction — the exact defect `store.ts`'s findings guard was
 * rewritten to remove — so the evidence has to live somewhere both sides can reach.
 *
 * It owns the VOCABULARY rather than copying it. `inner-loop.ts` re-exports these names,
 * so there is one list of escalation kinds and one function that decodes a declaration,
 * not a second spelling maintained beside the first.
 */

/**
 * The three kinds a terminal result may carry. 'design-gap' and 'missing-dependency' are
 * what a REVIEWER declared (and proved with `whatIsMissing`); 'not-converging' is what the
 * arithmetic measured and it deliberately names no cause — the first two assert a cause a
 * reviewer stated, the third asserts only that fixing stopped working. A gate that let the
 * arithmetic borrow one of the first two names would report a cause nobody measured.
 */
export const ESCALATION_KINDS = ['design-gap', 'missing-dependency', 'not-converging'] as const
export type EscalationKind = (typeof ESCALATION_KINDS)[number]

/** `whatIsMissing` / `evidence` are persisted and delivered to the owner; bound them on
 *  the way in, exactly as the terminal cause is bounded. */
export const ESCALATION_TEXT_MAX = 500

/** A run that STOPPED because its PLAN could not succeed, as reported to the orchestrator. */
export interface InnerEscalation {
  kind: EscalationKind
  /** The SPECIFIC thing the plan got wrong, or the dependency that must land first.
   *  Never empty — this decoder refuses a declaration that states nothing. */
  whatIsMissing: string
  /** EVERY gate that fired. `[]` when the workflow reported none, never a guess. */
  triggers: string[]
  /** The arithmetic the decision was made on, in the workflow's own words. '' when absent. */
  evidence: string
  /** The round it fired at. 0 when the workflow reported none. */
  round: number
}

/**
 * Decode an escalation payload FAIL-CLOSED and AS A WHOLE: a payload missing its kind, or
 * carrying a kind outside the three, or stating nothing in `whatIsMissing`, decodes to
 * `null` rather than to a partially-trusted object. A bare complaint is not an escalation.
 */
export function parseInnerEscalation(raw: unknown): InnerEscalation | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const e = raw as Record<string, unknown>
  const kind = e['kind']
  if (typeof kind !== 'string' || !(ESCALATION_KINDS as readonly string[]).includes(kind)) return null
  const whatIsMissing = typeof e['whatIsMissing'] === 'string' ? (e['whatIsMissing'] as string).trim() : ''
  if (whatIsMissing === '') return null
  const evidence = typeof e['evidence'] === 'string' ? (e['evidence'] as string).trim() : ''
  const round = typeof e['round'] === 'number' && Number.isSafeInteger(e['round']) ? (e['round'] as number) : 0
  return {
    kind: kind as EscalationKind,
    whatIsMissing: whatIsMissing.slice(0, ESCALATION_TEXT_MAX),
    triggers: Array.isArray(e['triggers'])
      ? (e['triggers'] as unknown[])
          .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
          .map((t) => t.trim().slice(0, 64))
      : [],
    evidence: evidence.slice(0, ESCALATION_TEXT_MAX),
    round,
  }
}

/**
 * IS THIS RAW `inner_result` COLUMN A RUN THAT STOPPED AND ESCALATED?
 *
 * The question the STORE has to answer before it can tell a legitimate findings-free
 * rejection from the illegitimate kind. An escalation is a REJECTION WHOSE EVIDENCE IS THE
 * DECLARATION rather than a finding list: a panel that concludes the plan is wrong often
 * has no individual code finding to write, because the code is a faithful implementation
 * of a bad plan.
 *
 * THE KIND AND THE PAYLOAD MUST AGREE, the same pairing every other reader of this
 * distinction requires. `blockKind` is what the outer loop routes on and the payload is
 * what it reports; a result carrying one without the other is a HALF-WRITTEN escalation,
 * and it falls through to the findings requirement rather than being believed on the
 * strength of its label.
 *
 * Fail-closed at every step: an unparseable column, a missing payload, a kind outside the
 * three, a blank `whatIsMissing`, or a routing kind that disagrees all return `false` —
 * and the caller then applies the ordinary rule.
 */
export function resultCarriesEscalation(rawInnerResult: string | null | undefined): boolean {
  if (typeof rawInnerResult !== 'string' || rawInnerResult.trim() === '') return false
  let parsed: unknown
  try {
    parsed = JSON.parse(rawInnerResult)
  } catch {
    return false
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const p = parsed as Record<string, unknown>
  const escalation = parseInnerEscalation(p['escalation'])
  if (escalation === null) return false
  return p['blockKind'] === escalation.kind
}
