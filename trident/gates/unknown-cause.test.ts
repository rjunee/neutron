import { expect, test } from 'bun:test'
import { TERMINAL_CAUSE_MAX } from '../inner-loop.ts'
import { unknownCause } from './unknown-cause.ts'

test('unknown gate causes use the terminal cap while the journal keeps the full cause and run id', () => {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  try {
    const marker = `recognisable-${'x'.repeat(TERMINAL_CAUSE_MAX)}`
    const refusal = unknownCause('Gate failed', new Error(marker), 'run-cause-control')
    expect(refusal.kind).toBe('unknown')
    expect(refusal.detail.length).toBe(TERMINAL_CAUSE_MAX)
    expect(refusal.detail).toContain('recognisable-')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('run_id=run-cause-control')
    expect(lines[0]).toContain(marker)
  } finally {
    console.error = original
  }
})
