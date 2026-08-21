import { describe, expect, test } from 'bun:test'
import {
  computeWave,
  parsePlanGraph,
  PlanGraphError,
  renderCheckedOff,
  surfacesOverlap,
  type PlanGraphErrorKind,
} from './plan-graph.ts'

function ids(body: string, maxWaveSize = 10): string[] {
  return computeWave(parsePlanGraph(body), maxWaveSize).map((task) => task.id)
}

function expectPlanError(body: string, kind: PlanGraphErrorKind, message?: string): void {
  let caught: unknown
  try {
    parsePlanGraph(body)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(PlanGraphError)
  expect((caught as PlanGraphError).kind).toBe(kind)
  if (message) expect((caught as Error).message).toContain(message)
}

describe('parsePlanGraph and computeWave', () => {
  // Card falsification criterion #4: absent requires means independent, not previous-line.
  test('makes graph and legacy tasks independent by default', () => {
    const body = [
      '- [ ] T1: one | surface: one.ts',
      '- [ ] T2: two | surface: two.ts',
      '- [ ] T3: three | surface: three.ts',
    ].join('\n')
    expect(ids(body)).toEqual(['T1', 'T2', 'T3'])

    const reordered = [
      '- [ ] T3: three | surface: three.ts',
      '- [ ] T1: one | surface: one.ts',
      '- [ ] T2: two | surface: two.ts',
    ].join('\n')
    expect(ids(reordered)).toEqual(['T3', 'T1', 'T2'])
    expect(parsePlanGraph(reordered).every((task) => task.requires.length === 0)).toBe(true)

    const legacy = parsePlanGraph('- [ ] alpha\n- [ ] beta')
    expect(legacy.map((task) => task.requires)).toEqual([[], []])
    expect(legacy.map((task) => task.requiresDeclared)).toEqual([false, false])
  })

  // Card falsification criterion #2: a genuine chain becomes eligible only after its dependency.
  test('unlocks a dependency chain after the required task is checked', () => {
    const body = [
      '- [ ] T1: first | requires: none | surface: first.ts',
      '- [ ] T2: second | requires: T1 | surface: second.ts',
    ].join('\n')
    expect(ids(body)).toEqual(['T1'])

    const checked = renderCheckedOff(body, ['T1'])
    expect(ids(checked)).toEqual(['T2'])
    expect(ids(body.replace('- [ ] T1:', '- [x] T1:'))).toEqual(['T2'])
    expect(parsePlanGraph(body)[0]!.requiresDeclared).toBe(true)
  })

  // Card falsification criterion #3: cycles are refused, never flattened to serial.
  test('refuses multi-task and self cycles while accepting an acyclic control', () => {
    expectPlanError(
      '- [ ] T1: one | requires: T2\n- [ ] T2: two | requires: T1',
      'cycle',
      'T1 -> T2 -> T1',
    )
    expectPlanError('- [ ] T1: one | requires: T1', 'cycle', 'T1 -> T1')
    expect(parsePlanGraph('- [ ] T1: one\n- [ ] T2: two | requires: T1')).toHaveLength(2)
  })

  test('throws loud typed errors for duplicate ids, unknown ids, and bad fields', () => {
    expectPlanError('- [ ] T1: one\n- [ ] T1: two', 'duplicate-id')
    expectPlanError('- [ ] T1: one | requires: T9', 'unknown-id')
    expectPlanError('- [ ] legacy\n- [ ] T1: graph | requires: L0', 'unknown-id')
    expectPlanError('- [ ] T1: one | requries: T2', 'bad-field')
    expectPlanError('- [ ] T1: one | requires: none | requires: none', 'bad-field')
    expectPlanError('- [ ] T1: one | surface: a.ts | surface: b.ts', 'bad-field')
  })
})

describe('surface-safe waves', () => {
  test('detects segment-aligned overlap after normalization', () => {
    expect(surfacesOverlap(['trident/a.ts'], ['trident/a.ts'])).toBe(true)
    expect(surfacesOverlap(['trident'], ['trident/store.ts'])).toBe(true)
    expect(surfacesOverlap(['trident/a.ts'], ['trident/ab.ts'])).toBe(false)
    expect(surfacesOverlap(['./x'], ['x'])).toBe(true)
    expect(surfacesOverlap(['../x'], ['unrelated/y'])).toBe(true)
    expect(surfacesOverlap(['/abs'], ['unrelated/y'])).toBe(true)
    expect(surfacesOverlap(['a//b///'], ['./a/b'])).toBe(true)
  })

  test('places disjoint declared directories in the same wave', () => {
    const body = [
      '- [ ] T1: one | surface: alpha/a.ts',
      '- [ ] T2: two | surface: beta/b.ts',
    ].join('\n')
    expect(ids(body)).toEqual(['T1', 'T2'])
  })

  test('makes an undeclared first task a wave of one and never adds a later undeclared task', () => {
    const undeclaredFirst = [
      '- [ ] T1: one',
      '- [ ] T2: two | surface: two.ts',
      '- [ ] T3: three | surface: three.ts',
    ].join('\n')
    expect(ids(undeclaredFirst)).toEqual(['T1'])

    const undeclaredLater = [
      '- [ ] T1: one | surface: one.ts',
      '- [ ] T2: two',
      '- [ ] T3: three | surface: three.ts',
    ].join('\n')
    expect(ids(undeclaredLater)).toEqual(['T1', 'T3'])
  })

  test('caps waves in document order and treats a cap below one as one', () => {
    const body = Array.from(
      { length: 5 },
      (_, index) => `- [ ] T${index + 1}: task ${index + 1} | surface: dir${index + 1}/file.ts`,
    ).join('\n')
    expect(ids(body, 3)).toEqual(['T1', 'T2', 'T3'])
    expect(ids(body, 0)).toEqual(['T1'])
  })
})

describe('legacy and rendering compatibility', () => {
  test("keeps plain checklist plans error-free and byte-equivalent to today's serial order", () => {
    const body = '- [ ] first plain task\n- [x] already done\n- [ ] title | requries: whatever'
    const tasks = parsePlanGraph(body)
    expect(tasks.map((task) => task.id)).toEqual(['L0', 'L1', 'L2'])
    expect(tasks.every((task) => task.requires.length === 0 && task.surfaces.length === 0)).toBe(true)
    expect(ids(body)).toEqual(['L0'])
    expect(ids(renderCheckedOff(body, ['L0']))).toEqual(['L2'])
  })

  test('checks off graph and legacy ids byte-precisely and idempotently', () => {
    const body = [
      '# heading',
      '  - [ ] T1: graph | requires: none | surface: graph.ts  ',
      '\t- [ ] legacy title\t',
      '- [x] T2: already | surface: done.ts',
      'tail',
      '',
    ].join('\n')
    const expected = [
      '# heading',
      '  - [x] T1: graph | requires: none | surface: graph.ts  ',
      '\t- [x] legacy title\t',
      '- [x] T2: already | surface: done.ts',
      'tail',
      '',
    ].join('\n')
    const once = renderCheckedOff(body, ['T1', 'L2', 'T2'])
    expect(once).toBe(expected)
    expect(renderCheckedOff(once, ['T1', 'L2', 'T2'])).toBe(once)
  })

  test('throws for an absent render id and preserves missing final newline', () => {
    expect(() => renderCheckedOff('- [ ] T1: one', ['T9'])).toThrow(PlanGraphError)
    try {
      renderCheckedOff('- [ ] T1: one', ['T9'])
    } catch (error) {
      expect((error as PlanGraphError).kind).toBe('unknown-id')
    }

    const rendered = renderCheckedOff('- [ ] T1: one', ['T1'])
    expect(rendered).toBe('- [x] T1: one')
    expect(rendered.endsWith('\n')).toBe(false)
  })

  test('preserves mixed document order and exact line metadata', () => {
    const body = [
      'intro',
      '\t- [ ] T2: graph title | surface: ./graph.ts',
      'not a task',
      ' - [x] legacy | anything at all  ',
    ].join('\n')
    expect(parsePlanGraph(body)).toEqual([
      {
        id: 'T2',
        title: 'graph title',
        checked: false,
        requires: [],
        requiresDeclared: false,
        surfaces: ['./graph.ts'],
        line: 1,
        raw: '\t- [ ] T2: graph title | surface: ./graph.ts',
      },
      {
        id: 'L3',
        title: 'legacy | anything at all  ',
        checked: true,
        requires: [],
        requiresDeclared: false,
        surfaces: [],
        line: 3,
        raw: ' - [x] legacy | anything at all  ',
      },
    ])
  })
})
