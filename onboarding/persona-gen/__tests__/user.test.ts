import { describe, expect, test } from 'bun:test'
import { generateUserMd } from '../user.ts'
import { deterministicCringe } from '../cringe-check.ts'

describe('generateUserMd', () => {
  test('renders all sections from full input', () => {
    const md = generateUserMd({
      display_name: 'Alex Example',
      preferred_call_name: 'Alex',
      timezone: 'America/Los_Angeles',
      email: 'alex@example.test',
      role: 'Independent operator',
      inner_circle: [
        { name: 'Sam', relation: 'Co-founder' },
        { name: 'Jordan', relation: 'Spouse' },
      ],
      preferences: [
        { key: 'Coffee', value: 'Pour-over' },
      ],
    })
    expect(md).toContain('# USER.md')
    expect(md).toContain('Alex Example')
    expect(md).toContain('America/Los_Angeles')
    expect(md).toContain('Inner Circle')
    expect(md).toContain('Sam')
    expect(md).toContain('Preferences')
    expect(md).toContain('Coffee')
  })

  test('omits optional sections when fields are empty', () => {
    const md = generateUserMd({ display_name: 'Alex' })
    expect(md).toContain('Alex')
    expect(md).not.toContain('Inner Circle')
    expect(md).not.toContain('Preferences')
  })

  test('deterministic output passes cringe-check', () => {
    const md = generateUserMd({
      display_name: 'Alex',
      role: 'Engineer',
    })
    const r = deterministicCringe(md)
    expect(r.flags).toBe(0)
  })
})
