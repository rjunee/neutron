import { redactProbeText } from './verdict.ts'

export type EscalationAction = 'continue' | 're-plan' | 'stop'

export interface EscalationDecision {
  action: EscalationAction
  kind: string
  whatIsMissing: string
  triggers: string[]
  evidence: string
  refusedClaim: string
  undecidable: string[]
  round: number
}

const SELF_DECLARED_ESCALATION_KINDS = ['design-gap', 'missing-dependency']
const ARITHMETIC_ESCALATION_KIND = 'not-converging'
const REPEATED_KEYS_MAX = 300

function redactedRepeatedKeys(keys: unknown) {
  return redactProbeText(Array.isArray(keys) ? keys.join(', ') : '').slice(0, REPEATED_KEYS_MAX)
}
const WHAT_IS_MISSING_MAX = 500

export function findingIdentity(f: any) {
  if (f === null || typeof f !== 'object' || Array.isArray(f)) return ''
  if (typeof f.file !== 'string' || typeof f.symbol !== 'string' || typeof f.rule !== 'string') return ''
  const segments = [f.file.trim().replace(/^\.\//, ''), f.symbol.trim(), f.rule.trim()]
  if (segments.some((seg) => seg === '')) return ''
  return segments.join(':')
}

export function roundIdentity(findings: any) {
  if (!Array.isArray(findings)) return { keys: [], unknown: 0, readable: false }
  const keys: string[] = []
  let unknown = 0
  for (const f of findings) {
    const id = findingIdentity(f)
    if (id === '') unknown += 1
    else if (!keys.includes(id)) keys.push(id)
  }
  keys.sort()
  return { keys, unknown, readable: true }
}

export function repeatVerdict(previousFindings: any, currentFindings: any) {
  const before = roundIdentity(previousFindings)
  const after = roundIdentity(currentFindings)
  if (!before.readable || !after.readable) {
    return { outcome: 'undecidable', repeated: [], reason: 'a round reported no readable finding list' }
  }
  const repeated = before.keys.filter((k) => after.keys.includes(k))
  if (repeated.length > 0) return { outcome: 'repeat', repeated, reason: '' }
  const unknown = before.unknown + after.unknown
  if (unknown > 0) {
    return {
      outcome: 'undecidable',
      repeated: [],
      reason: `${unknown} finding(s) across the two rounds carried no stable named identity`,
    }
  }
  return { outcome: 'none', repeated: [], reason: '' }
}

export function blockingFindingCount(findings: any) {
  if (!Array.isArray(findings)) return null
  return findings.filter(
    (f: any) => f !== null && typeof f === 'object' && (f.severity === 'blocker' || f.severity === 'major'),
  ).length
}

export function progressVerdict(counts: any) {
  if (!Array.isArray(counts) || counts.length < 2) return 'undecidable'
  const before = counts[counts.length - 2]
  const after = counts[counts.length - 1]
  if (!Number.isFinite(before) || !Number.isFinite(after)) return 'undecidable'
  return after < before ? 'progress' : 'no-progress'
}

export function validateEscalationClaim(raw: any, claimVerdict?: string | null) {
  const refuse = (why: string) => ({ ok: false, kind: '', whatIsMissing: '', refusedBecause: why })
  if (raw === null || raw === undefined) return refuse('')
  if (typeof raw !== 'object' || Array.isArray(raw)) return refuse('the declared escalation was not an object')
  // Rationale: inner-workflow-rationale.md#rationale-029 (formerly line 3685).
  if (claimVerdict === 'APPROVE') {
    return refuse('the reviewer returned APPROVE and an escalation in the same answer, which cannot both be true — neither half is usable, so the declaration is refused AND the answer may not approve')
  }
  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : ''
  if (!SELF_DECLARED_ESCALATION_KINDS.includes(kind)) {
    return refuse(`the declared escalation kind is not one of ${SELF_DECLARED_ESCALATION_KINDS.join(', ')}`)
  }
  const what = typeof raw.whatIsMissing === 'string' ? raw.whatIsMissing.trim() : ''
  if (what === '') {
    return refuse(`a ${kind} escalation must state whatIsMissing, and this one stated nothing`)
  }
  return { ok: true, kind, whatIsMissing: redactProbeText(what).slice(0, WHAT_IS_MISSING_MAX), refusedBecause: '' }
}

export function decideEscalation(state: any): EscalationDecision {
  const round = Number.isFinite(state && state.round) ? state.round : 0
  const claim = validateEscalationClaim(state ? state.claim : null, state ? state.claimVerdict : null)
  const repeat = repeatVerdict(
    state ? state.previousFindings : null,
    state ? state.currentFindings : null,
  )
  const progress = progressVerdict(state ? state.blockingCounts : null)
  const replansUsed = Number.isFinite(state && state.replansUsed) ? state.replansUsed : 0

  const triggers = []
  if (repeat.outcome === 'repeat') triggers.push('repeat-finding')
  if (progress === 'no-progress') triggers.push('no-progress')
  if (claim.ok) triggers.push(claim.kind)

  const undecidable = []
  if (repeat.outcome === 'undecidable') undecidable.push(`repeat-finding: ${repeat.reason}`)
  if (progress === 'undecidable') undecidable.push('no-progress: fewer than two readable rounds of counts')

  const evidence = [
    `round ${round}`,
    repeat.outcome === 'repeat'
      ? `finding(s) ${redactedRepeatedKeys(repeat.repeated)} survived a fix round`
      : `repeat-finding: ${repeat.outcome}${repeat.reason === '' ? '' : ` (${repeat.reason})`}`,
    `blocker+major counts ${JSON.stringify(Array.isArray(state && state.blockingCounts) ? state.blockingCounts : null)} → ${progress}`,
    claim.ok
      ? `reviewer declared ${claim.kind}`
      : claim.refusedBecause === ''
        ? 'no reviewer declaration'
        : `reviewer declaration REFUSED — ${claim.refusedBecause}`,
    `bounded re-plans used: ${replansUsed}`,
  ].join('; ')

  const base = {
    triggers,
    evidence,
    refusedClaim: claim.refusedBecause,
    undecidable,
    round,
  }

  if (claim.ok && claim.kind === 'design-gap' && replansUsed === 0) {
    return { ...base, action: 're-plan', kind: 'design-gap', whatIsMissing: claim.whatIsMissing }
  }
  if (triggers.length === 0) return { ...base, action: 'continue', kind: '', whatIsMissing: '' }
  // A VALID DECLARATION NAMES THE KIND; the arithmetic alone may not, because the
  // numbers prove only that fixing is not working. See ARITHMETIC_ESCALATION_KIND.
  const kind = claim.ok ? claim.kind : ARITHMETIC_ESCALATION_KIND
  const whatIsMissing = claim.ok
    ? claim.whatIsMissing
    : repeat.outcome === 'repeat'
      ? `the same finding(s) survived a fix round (${redactedRepeatedKeys(repeat.repeated)}), so fixing this diff is not removing them — the plan, not the code, is what needs deciding`
      : 'the blocker+major count stopped falling across two rounds, so the fix rounds are not converging'
  return { ...base, action: 'stop', kind, whatIsMissing }
}
