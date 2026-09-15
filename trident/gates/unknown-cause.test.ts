import { expect, spyOn, test } from 'bun:test'
import { TERMINAL_CAUSE_MAX } from '../inner-loop.ts'
import { unknownCause } from './unknown-cause.ts'

test('refusal cause is bounded in detail and logged once in full with the run id', () => {
  const emitted = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const cause = `recognisable-${'x'.repeat(TERMINAL_CAUSE_MAX)}`
    expect(unknownCause('Host observation failed', cause, 'run-42'))
      .toBe(`Host observation failed: ${cause.slice(0, TERMINAL_CAUSE_MAX)}`)
    expect(emitted).toHaveBeenCalledTimes(1)
    const line = emitted.mock.calls.flat().join(' ')
    expect(line).toContain('event=refusal_cause')
    expect(line).toContain('run_id=run-42')
    expect(line).toContain(cause)
  } finally {
    emitted.mockRestore()
  }
})
