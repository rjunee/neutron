import { describe, expect, test, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateRitualDef,
  createRitualRegistry,
  resolveRitualPromptPath,
  validateRitualFire,
  RITUAL_ID_RE,
  RITUAL_MODEL_TIER,
  RITUAL_TIMEOUT_MS,
  type RitualDef,
} from './rituals.ts'

/** A minimal valid def; override fields per test. */
function def(overrides: Partial<RitualDef> = {}): RitualDef {
  return {
    id: 'morning-brief',
    scope: 'project',
    tool_surface: ['Read', 'Glob', 'Grep'],
    egress: false,
    bridge: false,
    silent: false,
    ...overrides,
  }
}

describe('constants', () => {
  test('model tier is a TIER, timeout is 45min (Vajra parity)', () => {
    expect(RITUAL_MODEL_TIER).toBe('best')
    expect(RITUAL_TIMEOUT_MS).toBe(45 * 60_000)
  })
})

describe('validateRitualDef', () => {
  test('a valid def returns []', () => {
    expect(validateRitualDef(def())).toEqual([])
  })

  test('empty tool_surface is rejected (#361 toolless-class pin)', () => {
    // #361: a ritual with no tools is a silent no-op that looks like it ran —
    // must NEVER validate.
    const reasons = validateRitualDef(def({ tool_surface: [] }))
    expect(reasons.length).toBeGreaterThan(0)
    expect(reasons.some((r) => r.includes('#361'))).toBe(true)
  })

  test('duplicate tool_surface entries are rejected', () => {
    const reasons = validateRitualDef(def({ tool_surface: ['Read', 'Read'] }))
    expect(reasons.some((r) => r.includes('duplicate'))).toBe(true)
  })

  test("'WebSearch' in surface is rejected (must ride egress)", () => {
    const reasons = validateRitualDef(def({ tool_surface: ['Read', 'WebSearch'] }))
    expect(reasons.some((r) => r.includes('egress'))).toBe(true)
  })

  test("'mcp__neutron' in surface is rejected (must ride bridge)", () => {
    const reasons = validateRitualDef(def({ tool_surface: ['Read', 'mcp__neutron'] }))
    expect(reasons.some((r) => r.includes('bridge'))).toBe(true)
  })

  test('bad ids are rejected', () => {
    for (const bad of ['..', 'A/B', 'UPPER', 'a'.repeat(65), '-lead', '', 'has space']) {
      expect(validateRitualDef(def({ id: bad })).length).toBeGreaterThan(0)
    }
  })

  test('RITUAL_ID_RE accepts good ids, rejects bad', () => {
    expect(RITUAL_ID_RE.test('morning-brief')).toBe(true)
    expect(RITUAL_ID_RE.test('a')).toBe(true)
    expect(RITUAL_ID_RE.test('a'.repeat(64))).toBe(true)
    expect(RITUAL_ID_RE.test('a'.repeat(65))).toBe(false)
    expect(RITUAL_ID_RE.test('..')).toBe(false)
    expect(RITUAL_ID_RE.test('A')).toBe(false)
  })
})

describe('createRitualRegistry', () => {
  test('duplicate id throws', () => {
    expect(() => createRitualRegistry([def(), def()])).toThrow(/duplicate/)
  })

  test('invalid def throws', () => {
    expect(() => createRitualRegistry([def({ tool_surface: [] })])).toThrow(/invalid ritual def/)
  })

  test('get() returns the def; unknown id → undefined', () => {
    const reg = createRitualRegistry([def(), def({ id: 'evening-wrap' })])
    expect(reg.get('morning-brief')?.id).toBe('morning-brief')
    expect(reg.get('evening-wrap')?.scope).toBe('project')
    expect(reg.get('nope')).toBeUndefined()
  })

  test('list() returns all defs; the registry is frozen', () => {
    const reg = createRitualRegistry([def(), def({ id: 'evening-wrap' })])
    expect(reg.list().map((d) => d.id).sort()).toEqual(['evening-wrap', 'morning-brief'])
    expect(Object.isFrozen(reg.list())).toBe(true)
    expect(Object.isFrozen(reg.get('morning-brief'))).toBe(true)
  })
})

describe('resolveRitualPromptPath', () => {
  test("'morning-brief' → <root>/rituals/morning-brief.md", () => {
    expect(resolveRitualPromptPath('/prompts', 'morning-brief')).toBe(
      join('/prompts', 'rituals', 'morning-brief.md'),
    )
  })

  test('traversal-shaped id throws (defense-in-depth)', () => {
    expect(() => resolveRitualPromptPath('/prompts', '../etc/passwd')).toThrow(/RITUAL_ID_RE/)
    expect(() => resolveRitualPromptPath('/prompts', 'a/b')).toThrow(/RITUAL_ID_RE/)
  })
})

describe('validateRitualFire', () => {
  function withPromptRoot(fn: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'neutron-rituals-'))
    try {
      mkdirSync(join(root, 'rituals'), { recursive: true })
      fn(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  test('unknown id → unknown_ritual; isApproved NOT called', () => {
    withPromptRoot((promptRoot) => {
      const reg = createRitualRegistry([def()])
      const isApproved = mock(() => true)
      const verdict = validateRitualFire('nope', { registry: reg, promptRoot, isApproved })
      expect(verdict).toEqual({ ok: false, reason: 'unknown_ritual' })
      expect(isApproved).not.toHaveBeenCalled()
    })
  })

  test('known id but no prompt file → missing_prompt; isApproved NOT called', () => {
    withPromptRoot((promptRoot) => {
      const reg = createRitualRegistry([def()])
      const isApproved = mock(() => true)
      const verdict = validateRitualFire('morning-brief', { registry: reg, promptRoot, isApproved })
      expect(verdict).toEqual({ ok: false, reason: 'missing_prompt' })
      expect(isApproved).not.toHaveBeenCalled()
    })
  })

  test('whitespace-only prompt file → missing_prompt (0-byte no-op guard)', () => {
    withPromptRoot((promptRoot) => {
      writeFileSync(join(promptRoot, 'rituals', 'morning-brief.md'), '   \n\t\n')
      const reg = createRitualRegistry([def()])
      const isApproved = mock(() => true)
      const verdict = validateRitualFire('morning-brief', { registry: reg, promptRoot, isApproved })
      expect(verdict).toEqual({ ok: false, reason: 'missing_prompt' })
      expect(isApproved).not.toHaveBeenCalled()
    })
  })

  test('real prompt + isApproved:()=>false → unapproved (fail CLOSED)', () => {
    withPromptRoot((promptRoot) => {
      const MARKER = 'RITUAL-FIXTURE-MARKER-77'
      writeFileSync(join(promptRoot, 'rituals', 'morning-brief.md'), `# brief\n${MARKER}\n`)
      const reg = createRitualRegistry([def()])
      const isApproved = mock(() => false)
      const verdict = validateRitualFire('morning-brief', { registry: reg, promptRoot, isApproved })
      expect(verdict).toEqual({ ok: false, reason: 'unapproved' })
      // Seam was consulted with the def + the exact prompt bytes (task 3 hashes them).
      expect(isApproved).toHaveBeenCalledTimes(1)
      expect(isApproved).toHaveBeenCalledWith(reg.get('morning-brief'), `# brief\n${MARKER}\n`)
    })
  })

  test('real prompt + isApproved:()=>true → ok with prompt bytes (artifact-grounded)', () => {
    withPromptRoot((promptRoot) => {
      const MARKER = 'RITUAL-FIXTURE-MARKER-42'
      const body = `# morning brief\n${MARKER}\nread STATUS.md\n`
      writeFileSync(join(promptRoot, 'rituals', 'morning-brief.md'), body)
      const reg = createRitualRegistry([def()])
      const isApproved = mock(() => true)
      const verdict = validateRitualFire('morning-brief', { registry: reg, promptRoot, isApproved })
      expect(verdict.ok).toBe(true)
      if (verdict.ok) {
        expect(verdict.ritual.id).toBe('morning-brief')
        expect(verdict.promptText).toContain(MARKER)
        expect(verdict.promptText).toBe(body)
      }
      expect(isApproved).toHaveBeenCalledWith(reg.get('morning-brief'), body)
    })
  })
})
