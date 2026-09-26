import { expect, test } from 'bun:test'
import { parseWorkBoardAttempts as phone } from '@neutronai/app/lib/work-board-client'
import { parseWorkBoardAttempts as web } from '@neutronai/landing/chat-react/work-board-client.ts'

for (const [name, parse] of [['phone', phone], ['web', web]] as const) {
  test(`${name} preserves terminal observations and refuses malformed or invented links`, () => {
    const attempt = { run_id: 'run', outcome: 'failed' as const, pr: 12, pr_url: 'https://example.test/pull/12', recorded_at: '2026-09-20' }
    expect(parse([attempt])).toEqual([attempt])
    expect(parse(undefined)).toEqual([])
    expect(parse(null)).toEqual([])
    expect(parse([null, {}, { ...attempt, outcome: 'running' }, { ...attempt, run_id: '' }])).toEqual([])
    for (const pr_url of [null, 'javascript:alert(1)', 'https://user:secret@example.test/pr', '/pull/12']) {
      expect(parse([{ ...attempt, pr_url }])).toEqual([{ ...attempt, pr_url: null }])
    }
    expect(parse([{ ...attempt, pr: null }])).toEqual([{ ...attempt, pr: null, pr_url: null }])
  })
}
