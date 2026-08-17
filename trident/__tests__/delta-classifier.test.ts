import { describe, expect, test } from 'bun:test'

const SRC = await Bun.file(new URL('../inner-workflow.mjs', import.meta.url)).text()

/** Brace-match one function out of the source and evaluate it. */
function grab(name: string): string {
  const at = SRC.indexOf(`function ${name}(`)
  if (at === -1) throw new Error(`${name} is missing from inner-workflow.mjs`)
  let depth = 0
  let started = false
  for (let i = at; i < SRC.length; i += 1) {
    const c = SRC[i]
    if (c === '{') {
      depth += 1
      started = true
    } else if (c === '}') {
      depth -= 1
      if (started && depth === 0) return SRC.slice(at, i + 1)
    }
  }
  throw new Error(`could not brace-match ${name}`)
}

type Result = { classification: 'docs-only' | 'full'; reason: string; offenders: string[] }

function loadReal(): {
  classifyDeltaPaths: (paths: unknown) => Result
  classifyDeltaProbe: (probe: unknown) => Result
} {
  // Evaluating only both extracted functions proves they need no module-scope dependencies.
  return new Function(`${grab('classifyDeltaPaths')}\n${grab('classifyDeltaProbe')}\nreturn { classifyDeltaPaths, classifyDeltaProbe }`)() as ReturnType<typeof loadReal>
}

describe('classifyDeltaPaths', () => {
  const classify = () => loadReal().classifyDeltaPaths

  test('all markdown paths are docs-only', () => {
    const out = classify()(['docs/a.md', 'README.md', 'notes/2026-08-16-x.md'])
    expect(out.classification).toBe('docs-only')
    expect(out.reason).toContain('all 3 changed path(s)')
  })

  test('dangerous case: one .ts plus ten .md paths takes the full path', () => {
    const out = classify()(['trident/store.ts', ...Array.from({ length: 10 }, (_, i) => `a${i + 1}.md`)])
    expect(out.classification).toBe('full')
    expect(out.offenders).toEqual(['trident/store.ts'])
    expect(out.reason).toContain('trident/store.ts')
  })

  test.each([
    [['migrations/0130_add_col.sql']],
    [['migrations/README.md']],
    [['.github/workflows/ci.yml']],
    [['.github/PULL_REQUEST_TEMPLATE.md']],
    [['package.json']],
    [['bun.lock']],
  ])('denied or non-doc path %p takes the full path', (paths) => {
    expect(classify()(paths).classification).toBe('full')
  })

  test.each([[['.trident/plans/card.md']], [['.trident/plans/attachment.png']], [['README.MD']]])(
    'positively recognized documentation %p is docs-only',
    (paths) => expect(classify()(paths).classification).toBe('docs-only'),
  )

  test('empty and non-array inputs are full', () => {
    for (const input of [[], undefined, 'docs/a.md']) {
      const out = classify()(input)
      expect(out.classification).toBe('full')
      expect(out.reason).toBe('delta: no changed paths measured — taking the full path')
    }
  })

  test.each([[['../escape.md']], [['/etc/x.md']], [['"docs/we\\nird.md"']], [['a\\b.md']], [[42]], [['  ']]])(
    'suspicious input %p takes the full path',
    (paths) => expect(classify()(paths).classification).toBe('full'),
  )

  test('offender reason truncates while retaining every offender', () => {
    const out = classify()(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'])
    expect(out.reason).toContain('(+2 more)')
    expect(out.offenders).toHaveLength(5)
  })
})

describe('classifyDeltaProbe', () => {
  const classify = () => loadReal().classifyDeltaProbe

  test('successful docs diff is docs-only', () => expect(classify()({ raw: 'docs/a.md\nREADME.md\n', exit_code: 0 }).classification).toBe('docs-only'))
  test('failed probe is full', () => expect(classify()({ raw: 'docs/a.md\n', exit_code: 1 }).reason).toContain('exit=1'))
  test('git error text is full', () => expect(classify()({ raw: 'fatal: not a git repository', exit_code: 0 }).reason).toContain('git error'))
  test('empty diff is full', () => expect(classify()({ raw: '', exit_code: 0 }).classification).toBe('full'))
  test('missing exit is full', () => expect(classify()({}).reason).toContain('exit=unknown'))

  test('every result has a bounded classification and non-empty reason', () => {
    const results = [
      classify()({ raw: 'README.md\n', exit_code: 0 }),
      classify()({ raw: 'src/a.ts\n', exit_code: 0 }),
      classify()({}),
    ]
    for (const out of results) {
      expect(['docs-only', 'full']).toContain(out.classification)
      expect(typeof out.reason).toBe('string')
      expect(out.reason.length).toBeGreaterThan(0)
    }
  })
})
