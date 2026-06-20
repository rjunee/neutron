/**
 * Minimal Draft 2020-12 JSON Schema runner — handles only the subset of
 * keywords emitted by manifest.schema.json. Test-only utility for the
 * round-trip parity check; NOT a general-purpose JSON Schema validator.
 *
 * Supported keywords: $defs, $ref, type, enum, required, properties, items,
 * pattern, minItems, minLength.
 */

interface SchemaNode {
  readonly [key: string]: unknown
}

interface RunnerContext {
  readonly root: SchemaNode
}

export function validateAgainstSchema(
  schema: SchemaNode,
  value: unknown,
): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  const ctx: RunnerContext = { root: schema }
  walk(ctx, schema, value, '', errors)
  return { valid: errors.length === 0, errors }
}

function walk(
  ctx: RunnerContext,
  schema: SchemaNode,
  value: unknown,
  path: string,
  errors: string[],
): void {
  const ref = schema['$ref']
  if (typeof ref === 'string') {
    const resolved = resolveRef(ctx.root, ref)
    if (!resolved) {
      errors.push(`${path}: cannot resolve $ref ${ref}`)
      return
    }
    walk(ctx, resolved, value, path, errors)
    return
  }

  const type = schema['type']
  if (typeof type === 'string') {
    if (!matchesType(type, value)) {
      errors.push(`${path}: expected type ${type}`)
      return
    }
  }

  const enumList = schema['enum']
  if (Array.isArray(enumList)) {
    if (!enumList.some((e) => e === value)) {
      errors.push(`${path}: value not in enum`)
      return
    }
  }

  if (typeof value === 'string') {
    const minLength = schema['minLength']
    if (typeof minLength === 'number' && value.length < minLength) {
      errors.push(`${path}: string shorter than minLength ${minLength}`)
    }
    const pattern = schema['pattern']
    if (typeof pattern === 'string') {
      if (!new RegExp(pattern).test(value)) {
        errors.push(`${path}: string does not match pattern`)
      }
    }
  }

  if (Array.isArray(value)) {
    const minItems = schema['minItems']
    if (typeof minItems === 'number' && value.length < minItems) {
      errors.push(`${path}: array shorter than minItems ${minItems}`)
    }
    const items = schema['items']
    if (items !== undefined && isPlainObject(items)) {
      for (let i = 0; i < value.length; i++) {
        walk(ctx, items as SchemaNode, value[i], `${path}/${i}`, errors)
      }
    }
  }

  if (isPlainObject(value)) {
    const required = schema['required']
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && !(key in value)) {
          errors.push(`${path}/${key}: required field missing`)
        }
      }
    }
    const properties = schema['properties']
    if (isPlainObject(properties)) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in value && isPlainObject(propSchema)) {
          walk(
            ctx,
            propSchema as SchemaNode,
            (value as Record<string, unknown>)[key],
            `${path}/${key}`,
            errors,
          )
        }
      }
    }
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return true
  }
}

function resolveRef(root: SchemaNode, ref: string): SchemaNode | null {
  if (!ref.startsWith('#/')) return null
  const segments = ref.slice(2).split('/')
  let cursor: unknown = root
  for (const seg of segments) {
    if (!isPlainObject(cursor)) return null
    cursor = (cursor as Record<string, unknown>)[seg]
  }
  return isPlainObject(cursor) ? (cursor as SchemaNode) : null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
