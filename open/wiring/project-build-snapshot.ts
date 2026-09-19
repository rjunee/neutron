/** The outer result contract. Role-specific payload schemas are supplied separately. */
export const PROJECT_SNAPSHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['head', 'diff', 'pr', 'payload'],
  properties: {
    head: { type: 'string', description: 'The measured Git revision for this result.' },
    diff: { type: 'string', description: 'The measured diff bytes, not a filename.' },
    pr: {
      type: ['object', 'null'],
      additionalProperties: false,
      description: 'Copy the host context snapshot.pr unchanged: null when no PR exists, otherwise the complete object. Never a PR number or URL. This is distinct from result.payload.prNumber in the forge payload.',
      required: ['number', 'head', 'state'],
      properties: {
        number: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        head: { type: 'string' },
        state: { type: 'string', enum: ['OPEN', 'CLOSED', 'MERGED'] },
      },
    },
    payload: { description: 'The role-specific plan, forge or verdict object described below.' },
  },
} as const

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Throw only field names and expected shapes; never include worker-controlled values. */
export function assertProjectSnapshot(value: unknown): asserts value is Record<string, unknown> {
  const refuse = (detail: string): never => { throw new Error(`Project snapshot contract: ${detail}`) }
  if (!object(value)) return refuse('result must be an object.')
  if (Object.keys(value).some(field => !Object.hasOwn(PROJECT_SNAPSHOT_SCHEMA.properties, field))) refuse('result contains an unexpected field.')
  for (const field of PROJECT_SNAPSHOT_SCHEMA.required) {
    if (!Object.hasOwn(value, field)) refuse(`result.${field} is required.`)
  }
  for (const field of ['head', 'diff'] as const) {
    if (typeof value[field] !== PROJECT_SNAPSHOT_SCHEMA.properties[field].type) refuse(`result.${field} must be a string.`)
  }
  if (value.pr === null) return
  if (!object(value.pr)) return refuse('result.pr must be null or an object with number, head and state; a numeric PR belongs in result.payload.prNumber.')
  const pr = value.pr
  const schema = PROJECT_SNAPSHOT_SCHEMA.properties.pr
  if (Object.keys(pr).some(field => !Object.hasOwn(schema.properties, field))) refuse('result.pr contains an unexpected field.')
  for (const field of schema.required) {
    if (!Object.hasOwn(pr, field)) refuse(`result.pr.${field} is required.`)
  }
  if (!Number.isSafeInteger(pr.number) || Number(pr.number) < schema.properties.number.minimum) refuse('result.pr.number must be a positive safe integer.')
  if (typeof pr.head !== schema.properties.head.type) refuse('result.pr.head must be a string.')
  if (!(schema.properties.state.enum as readonly unknown[]).includes(pr.state)) refuse('result.pr.state must be OPEN, CLOSED or MERGED.')
}
