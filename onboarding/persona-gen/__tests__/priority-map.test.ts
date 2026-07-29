import { describe, expect, test } from 'bun:test'
import { generatePriorityMapMd } from '../priority-map.ts'
import { deterministicCringe } from '../cringe-check.ts'

describe('generatePriorityMapMd', () => {
  test('renders programs with tiers', () => {
    const md = generatePriorityMapMd({
      programs: [
        { name: 'Revenue', tier: 'P0', rationale: 'first lever' },
        { name: 'Health', tier: 'P2', rationale: 'sustainable pace' },
      ],
    })
    expect(md).toContain('# priority-map.md')
    expect(md).toContain('Revenue')
    expect(md).toContain('P0')
    expect(md).toContain('Health')
    expect(md).toContain('Auto-Resolve')
    expect(md).toContain('Escalation')
  })

  test('People Priority section appears when tier_1_people supplied (v2 § 7.3)', () => {
    const md = generatePriorityMapMd({
      programs: [{ name: 'X', tier: 'P1', rationale: '' }],
      tier_1_people: [{ name: 'Sam', relation: 'Co-founder' }],
    })
    expect(md).toContain('## People Priority')
    expect(md).toContain('Sam')
  })

  test('output passes cringe-check', () => {
    const md = generatePriorityMapMd({
      programs: [
        { name: 'Revenue work', tier: 'P0', rationale: 'core lever' },
      ],
    })
    const r = deterministicCringe(md)
    expect(r.flags).toBe(0)
  })
})
