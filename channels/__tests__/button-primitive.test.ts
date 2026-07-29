import { describe, expect, test } from 'bun:test'
import {
  buildButtonPrompt,
  canonicalPromptSeed,
  decodePromptIdWire,
  deriveIdempotencyKey,
  encodePromptIdWire,
  validateButtonPrompt,
  ButtonPrimitiveError,
  CALLBACK_DATA_BYTE_CAP,
  PROMPT_ID_WIRE_LEN,
  ROUTING_PREFIX,
  VALUE_BYTE_CAP,
  type ButtonPrompt,
} from '../button-primitive.ts'

const SAMPLE_UUID = '0123abcd-4567-89ef-0123-456789abcdef'

function basePrompt(overrides: Partial<ButtonPrompt> = {}): ButtonPrompt {
  return {
    prompt_id: SAMPLE_UUID,
    body: 'Pick one',
    options: [
      { label: 'A', body: 'opt a', value: 'a' },
      { label: 'B', body: 'opt b', value: 'b' },
    ],
    allow_freeform: false,
    ...overrides,
  }
}

describe('validateButtonPrompt', () => {
  test('accepts a well-formed prompt', () => {
    expect(() => validateButtonPrompt(basePrompt())).not.toThrow()
  })

  test('rejects a non-UUID prompt_id', () => {
    expect(() => validateButtonPrompt(basePrompt({ prompt_id: 'not-a-uuid' })))
      .toThrowError(ButtonPrimitiveError)
  })

  test('rejects an empty body', () => {
    try {
      validateButtonPrompt(basePrompt({ body: '' }))
    } catch (err) {
      expect(err).toBeInstanceOf(ButtonPrimitiveError)
      expect((err as ButtonPrimitiveError).code).toBe('body_required')
      return
    }
    throw new Error('expected throw')
  })

  test('rejects an options array of length 0', () => {
    try {
      validateButtonPrompt(basePrompt({ options: [] }))
    } catch (err) {
      expect(err).toBeInstanceOf(ButtonPrimitiveError)
      expect((err as ButtonPrimitiveError).code).toBe('no_options')
      return
    }
    throw new Error('expected throw')
  })

  test('rejects a value > 37 bytes UTF-8', () => {
    const overlong = 'x'.repeat(VALUE_BYTE_CAP + 1)
    try {
      validateButtonPrompt(
        basePrompt({
          options: [{ label: 'A', body: 'a', value: overlong }],
        }),
      )
    } catch (err) {
      expect(err).toBeInstanceOf(ButtonPrimitiveError)
      expect((err as ButtonPrimitiveError).code).toBe('value_too_long')
      return
    }
    throw new Error('expected throw')
  })

  test('rejects a value with multibyte UTF-8 over the budget', () => {
    // 4-byte UTF-8 emoji × 10 = 40 bytes — over VALUE_BYTE_CAP (37).
    const value = '🦀'.repeat(10)
    expect(Buffer.byteLength(value, 'utf8')).toBeGreaterThan(VALUE_BYTE_CAP)
    expect(() =>
      validateButtonPrompt(
        basePrompt({ options: [{ label: 'A', body: 'a', value }] }),
      ),
    ).toThrowError(ButtonPrimitiveError)
  })

  test('rejects a duplicate value across options', () => {
    try {
      validateButtonPrompt(
        basePrompt({
          options: [
            { label: 'A', body: 'a', value: 'same' },
            { label: 'B', body: 'b', value: 'same' },
          ],
        }),
      )
    } catch (err) {
      expect(err).toBeInstanceOf(ButtonPrimitiveError)
      expect((err as ButtonPrimitiveError).code).toBe('duplicate_value')
      return
    }
    throw new Error('expected throw')
  })

  test('rejects an empty label', () => {
    try {
      validateButtonPrompt(
        basePrompt({
          options: [{ label: '', body: 'a', value: 'a' }],
        }),
      )
    } catch (err) {
      expect(err).toBeInstanceOf(ButtonPrimitiveError)
      expect((err as ButtonPrimitiveError).code).toBe('invalid_label')
      return
    }
    throw new Error('expected throw')
  })

  test('rejects reserved routing sentinels as option values', () => {
    for (const reserved of ['__freeform__', '__timeout__', '__cancel__']) {
      try {
        validateButtonPrompt(
          basePrompt({
            options: [{ label: 'A', body: 'a', value: reserved }],
          }),
        )
      } catch (err) {
        expect(err).toBeInstanceOf(ButtonPrimitiveError)
        expect((err as ButtonPrimitiveError).code).toBe('reserved_value')
        continue
      }
      throw new Error(`expected throw for reserved value=${reserved}`)
    }
  })
})

describe('buildButtonPrompt', () => {
  test('generates a UUID and validates the result', () => {
    const prompt = buildButtonPrompt({
      body: 'Hi',
      options: [{ label: 'A', body: 'opt', value: 'a' }],
    })
    expect(prompt.prompt_id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(prompt.allow_freeform).toBe(false)
  })

  test('uuid factory is injected for determinism', () => {
    const prompt = buildButtonPrompt({
      body: 'Hi',
      options: [{ label: 'A', body: 'opt', value: 'a' }],
      uuid: () => SAMPLE_UUID,
    })
    expect(prompt.prompt_id).toBe(SAMPLE_UUID)
  })

  test('preserves decoration on options', () => {
    const prompt = buildButtonPrompt({
      body: 'Hi',
      options: [
        {
          label: 'A',
          body: 'opt',
          value: 'a',
          decoration: { style: 'destructive' },
        },
      ],
    })
    expect(prompt.options[0]?.decoration?.style).toBe('destructive')
  })

  test('caller-provided idempotency_key round-trips', () => {
    const prompt = buildButtonPrompt({
      body: 'Hi',
      options: [{ label: 'A', body: 'opt', value: 'a' }],
      idempotency_key: 'caller-supplied',
    })
    expect(prompt.idempotency_key).toBe('caller-supplied')
  })

  test('idempotency triple derives a stable key when no explicit key is set', () => {
    const a = buildButtonPrompt({
      body: 'Hi',
      options: [{ label: 'A', body: 'opt', value: 'a' }],
      idempotency: { project_slug: 't', topic_id: 'top-1', seed: 'x' },
    })
    const b = buildButtonPrompt({
      body: 'Hi',
      options: [{ label: 'A', body: 'opt', value: 'a' }],
      idempotency: { project_slug: 't', topic_id: 'top-1', seed: 'x' },
    })
    expect(a.idempotency_key).toBeDefined()
    expect(a.idempotency_key).toBe(b.idempotency_key)
    expect(a.prompt_id).not.toBe(b.prompt_id)
  })

  test('explicit idempotency_key wins when both key and triple are supplied', () => {
    const prompt = buildButtonPrompt({
      body: 'Hi',
      options: [{ label: 'A', body: 'opt', value: 'a' }],
      idempotency_key: 'explicit',
      idempotency: { project_slug: 't', topic_id: 'top', seed: 's' },
    })
    expect(prompt.idempotency_key).toBe('explicit')
  })
})

describe('encodePromptIdWire / decodePromptIdWire', () => {
  test('round-trips a UUID through 22-char base64url', () => {
    const wire = encodePromptIdWire(SAMPLE_UUID)
    expect(wire).toHaveLength(22)
    const decoded = decodePromptIdWire(wire)
    expect(decoded).toBe(SAMPLE_UUID)
  })

  test('rejects malformed wire input', () => {
    expect(decodePromptIdWire('not-base64')).toBeNull()
    expect(decodePromptIdWire('A'.repeat(20))).toBeNull()
    expect(decodePromptIdWire('A'.repeat(23))).toBeNull()
  })

  test('encoded wire fits within the prompt_id segment width', () => {
    const wire = encodePromptIdWire(SAMPLE_UUID)
    expect(`${ROUTING_PREFIX}${wire}:`.length).toBe(ROUTING_PREFIX.length + PROMPT_ID_WIRE_LEN)
  })

  test('full encoded callback_data with max-length value fits inside Telegram cap', () => {
    const wire = encodePromptIdWire(SAMPLE_UUID)
    const value = 'x'.repeat(VALUE_BYTE_CAP)
    const data = `${ROUTING_PREFIX}${wire}:${value}`
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(CALLBACK_DATA_BYTE_CAP)
  })
})

describe('deriveIdempotencyKey', () => {
  test('is deterministic on (project, topic, seed)', () => {
    const a = deriveIdempotencyKey({ project_slug: 't', topic_id: 'top-1', seed: 'x' })
    const b = deriveIdempotencyKey({ project_slug: 't', topic_id: 'top-1', seed: 'x' })
    expect(a).toBe(b)
  })

  test('changes when any input changes', () => {
    const base = deriveIdempotencyKey({ project_slug: 't', topic_id: 'top-1', seed: 'x' })
    expect(deriveIdempotencyKey({ project_slug: 't2', topic_id: 'top-1', seed: 'x' })).not.toBe(base)
    expect(deriveIdempotencyKey({ project_slug: 't', topic_id: 'top-2', seed: 'x' })).not.toBe(base)
    expect(deriveIdempotencyKey({ project_slug: 't', topic_id: 'top-1', seed: 'y' })).not.toBe(base)
  })

  test('truncates to 16 hex chars (64-bit)', () => {
    const k = deriveIdempotencyKey({ project_slug: 't', topic_id: 'top', seed: 's' })
    expect(k).toHaveLength(16)
    expect(k).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('canonicalPromptSeed', () => {
  test('produces a stable string regardless of options-array order', () => {
    const a = canonicalPromptSeed({ body: 'Hi', options: [{ value: 'a' }, { value: 'b' }] })
    const b = canonicalPromptSeed({ body: 'Hi', options: [{ value: 'a' }, { value: 'b' }] })
    expect(a).toBe(b)
  })

  test('reflects the body change', () => {
    const a = canonicalPromptSeed({ body: 'Hi', options: [{ value: 'a' }] })
    const b = canonicalPromptSeed({ body: 'Bye', options: [{ value: 'a' }] })
    expect(a).not.toBe(b)
  })
})

describe('image-gallery prompt kind (Sprint 28)', () => {
  test('builds an image-gallery prompt with image_url propagated', () => {
    const prompt = buildButtonPrompt({
      body: "Pick your agent's portrait.",
      kind: 'image-gallery',
      options: [
        { label: 'A', body: 'Portrait 1', value: 'cand-A', image_url: '/profile-pic/candidate/cand-A.png' },
        { label: 'B', body: 'Portrait 2', value: 'cand-B', image_url: '/profile-pic/candidate/cand-B.png' },
        { label: 'C', body: 'Skip portrait', value: 'skip-portrait' },
      ],
    })
    expect(prompt.kind).toBe('image-gallery')
    expect(prompt.options[0]?.image_url).toBe('/profile-pic/candidate/cand-A.png')
    expect(prompt.options[2]?.image_url).toBeUndefined()
  })

  test('rejects image-gallery prompt with missing image_url on a non-control option', () => {
    let caught: unknown
    try {
      buildButtonPrompt({
        body: "Pick your agent's portrait.",
        kind: 'image-gallery',
        options: [
          { label: 'A', body: 'Portrait 1', value: 'cand-A' }, // missing image_url
          { label: 'B', body: 'Skip portrait', value: 'skip-portrait' },
        ],
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ButtonPrimitiveError)
    expect((caught as ButtonPrimitiveError).code).toBe('image_url_missing')
  })

  test('non-image-gallery prompts may omit image_url on every option', () => {
    expect(() =>
      buildButtonPrompt({
        body: 'Pick one',
        options: [
          { label: 'A', body: 'a', value: 'a' },
          { label: 'B', body: 'b', value: 'b' },
        ],
      }),
    ).not.toThrow()
  })

  test('control values bypass the image_url requirement', () => {
    expect(() =>
      buildButtonPrompt({
        body: "Pick your agent's portrait.",
        kind: 'image-gallery',
        options: [
          { label: 'A', body: 'Portrait', value: 'cand-A', image_url: '/x.png' },
          { label: 'B', body: 'Regenerate', value: 'regen' },
          { label: 'C', body: 'Skip portrait', value: 'skip-portrait' },
        ],
      }),
    ).not.toThrow()
  })
})
