export type Verdict = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
export type FindingSeverity = 'blocker' | 'major' | 'minor' | 'nit'

export interface ReviewFinding {
  severity: FindingSeverity
  title: string
  evidence: string
  file: string
  symbol: string
  rule: string
  line: number | null
}

export interface VerdictTrailer {
  verdict: Verdict
  findings: ReviewFinding[]
  escalate?: { kind: 'design-gap' | 'missing-dependency'; whatIsMissing: string }
}

export interface MutationClaim {
  file: string
  find: string
  replace: string
  guard: string[]
  control: string[]
  rationale?: string
}

export interface ForgeTrailer {
  mutationClaim: MutationClaim | null
  worktreePath: string
  branch: string
  commitSha: string
  prNumber: number | null
  diffFile: string
  testsPassed: boolean
  deviatedFromSpec?: boolean | null
  suiteOutcome?: 'passed' | 'failed-new' | 'failed-preexisting' | 'not-run' | 'deferred'
  suiteEvidence?: string
}

export interface PlanTrailer {
  implementationPlan: string
  topTask: string
  executionSpec: string
  complexity: 'mechanical' | 'reasoning'
  remainingTasks: number
  branchBrief?: string | null
}

export const BRANCH_BRIEF_MAX_BYTES = 4096

export type TrailerKind = 'verdict' | 'forge' | 'plan'
export type TrailerFor<K extends TrailerKind> = K extends 'verdict'
  ? VerdictTrailer
  : K extends 'forge'
    ? ForgeTrailer
    : PlanTrailer

export type TrailerRejectionReason =
  | 'not-object'
  | 'missing-field'
  | 'unexpected-field'
  | 'wrong-type'
  | 'invalid-enum'

export type TrailerValidation<K extends TrailerKind> =
  | { ok: true; value: TrailerFor<K> }
  | { ok: false; reason: TrailerRejectionReason; path: string }

type ObjectFields = {
  additionalProperties: false
  required: readonly string[]
  properties: Record<string, Rule>
}
type Shape = { type: 'object' } & ObjectFields
type MultiRule = {
  type: readonly ('string' | 'number' | 'integer' | 'boolean' | 'object' | 'null')[]
  additionalProperties?: false
  required?: readonly string[]
  properties?: Record<string, Rule>
}
type Rule =
  | { type: 'string'; enum?: readonly string[] }
  | { type: 'number' | 'integer' | 'boolean' }
  | MultiRule
  | { type: 'array'; items: Rule }
  | ({ type: 'object' } & Shape)

const findingRule: Rule = {
  type: 'object',
  additionalProperties: false,
  required: ['severity', 'title', 'evidence', 'file', 'symbol', 'rule', 'line'],
  properties: {
    severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
    title: { type: 'string' },
    evidence: { type: 'string' },
    file: { type: 'string' },
    symbol: { type: 'string' },
    rule: { type: 'string' },
    line: { type: ['integer', 'null'] },
  },
}

const mutationClaimRule: Rule = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'find', 'replace', 'guard', 'control'],
  properties: {
    file: { type: 'string' },
    find: { type: 'string' },
    replace: { type: 'string' },
    guard: { type: 'array', items: { type: 'string' } },
    control: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string' },
  },
}

const shapes: Record<TrailerKind, Shape> = {
  verdict: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'findings'],
    properties: {
      verdict: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] },
      findings: { type: 'array', items: findingRule },
      escalate: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'whatIsMissing'],
        properties: {
          kind: { type: 'string', enum: ['design-gap', 'missing-dependency'] },
          whatIsMissing: { type: 'string' },
        },
      },
    },
  },
  forge: {
    type: 'object',
    additionalProperties: false,
    required: ['worktreePath', 'branch', 'commitSha', 'prNumber', 'diffFile', 'testsPassed', 'mutationClaim'],
    properties: {
      mutationClaim: { ...mutationClaimRule, type: ['object', 'null'] },
      worktreePath: { type: 'string' },
      branch: { type: 'string' },
      commitSha: { type: 'string' },
      prNumber: { type: ['number', 'null'] },
      diffFile: { type: 'string' },
      testsPassed: { type: 'boolean' },
      deviatedFromSpec: { type: ['boolean', 'null'] },
      suiteOutcome: { type: 'string', enum: ['passed', 'failed-new', 'failed-preexisting', 'not-run', 'deferred'] },
      suiteEvidence: { type: 'string' },
    },
  },
  plan: {
    type: 'object',
    additionalProperties: false,
    required: ['implementationPlan', 'topTask', 'executionSpec', 'complexity', 'remainingTasks'],
    properties: {
      implementationPlan: { type: 'string' },
      topTask: { type: 'string' },
      executionSpec: { type: 'string' },
      complexity: { type: 'string', enum: ['mechanical', 'reasoning'] },
      remainingTasks: { type: 'number' },
      branchBrief: { type: ['string', 'null'] },
    },
  },
}

export const VERDICT_SCHEMA = shapes.verdict
export const FORGE_SCHEMA = shapes.forge
export const PLAN_SCHEMA = shapes.plan

function utf8ByteWidth(codePoint: number): number {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4
}

export function clampBranchBrief(value: string): string {
  const brief = value.trim()
  if (brief === '') return ''
  let bytes = 0
  for (const character of brief) bytes += utf8ByteWidth(character.codePointAt(0)!)
  if (bytes <= BRANCH_BRIEF_MAX_BYTES) return brief

  const marker = `\n[branch-state brief truncated at ${BRANCH_BRIEF_MAX_BYTES} bytes]`
  let markerBytes = 0
  for (const character of marker) markerBytes += utf8ByteWidth(character.codePointAt(0)!)
  const contentLimit = BRANCH_BRIEF_MAX_BYTES - markerBytes
  let bounded = ''
  bytes = 0
  for (const character of brief) {
    const characterBytes = utf8ByteWidth(character.codePointAt(0)!)
    if (bytes + characterBytes > contentLimit) break
    bounded += character
    bytes += characterBytes
  }
  return bounded + marker
}

/** Preserve a plan's shape while bounding its untrusted branch-state summary. */
export function clampPlanBranchBrief(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)
      || !('branchBrief' in payload) || typeof payload.branchBrief !== 'string') return payload

  const branchBrief = clampBranchBrief(payload.branchBrief)
  return branchBrief === payload.branchBrief ? payload : { ...payload, branchBrief }
}

function reject(reason: TrailerRejectionReason, path: string): { ok: false; reason: TrailerRejectionReason; path: string } {
  return { ok: false, reason, path }
}

function validateRule(value: unknown, rule: Rule, path: string): { ok: true } | { ok: false; reason: TrailerRejectionReason; path: string } {
  if (Array.isArray(rule.type)) {
    const multi = rule as MultiRule
    if (multi.type.includes('null') && value === null) return { ok: true }
    const actual = Array.isArray(value) ? 'array' : typeof value
    if (multi.type.includes('integer') && typeof value === 'number' && Number.isInteger(value)) return { ok: true }
    if (!multi.type.includes(actual as never) || (actual === 'object' && value === null)) return reject('wrong-type', path)
    if (actual === 'object' && multi.required && multi.properties) return validateShape(value as Record<string, unknown>, multi as ObjectFields, path)
    return { ok: true }
  }
  if (rule.type === 'array') {
    if (!Array.isArray(value)) return reject('wrong-type', path)
    for (let i = 0; i < value.length; i++) {
      const checked = validateRule(value[i], rule.items, `${path}[${i}]`)
      if (!checked.ok) return checked
    }
    return { ok: true }
  }
  if (rule.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return reject('not-object', path)
    return validateShape(value as Record<string, unknown>, rule as Shape, path)
  }
  if (rule.type === 'integer') return typeof value === 'number' && Number.isInteger(value) ? { ok: true } : reject('wrong-type', path)
  if (typeof value !== rule.type) return reject('wrong-type', path)
  if (rule.type === 'string' && rule.enum && !rule.enum.includes(value as string)) return reject('invalid-enum', path)
  return { ok: true }
}

function validateShape(value: Record<string, unknown>, shape: ObjectFields, path: string) {
  for (const field of shape.required) if (!(field in value)) return reject('missing-field', `${path}.${field}`)
  for (const field of Object.keys(value)) if (!(field in shape.properties)) return reject('unexpected-field', `${path}.${field}`)
  for (const [field, rule] of Object.entries(shape.properties)) {
    if (!(field in value)) continue
    const checked = validateRule(value[field], rule, `${path}.${field}`)
    if (!checked.ok) return checked
  }
  return { ok: true } as const
}

/** Validate a harness trailer without throwing; malformed values return a typed reason. */
export function validateTrailer<K extends TrailerKind>(kind: K, value: unknown): TrailerValidation<K> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return reject('not-object', '$')
  const checked = validateShape(value as Record<string, unknown>, shapes[kind], '$')
  return checked.ok ? { ok: true, value: value as TrailerFor<K> } : checked
}
