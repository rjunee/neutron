import { describe, expect, test } from 'bun:test'

import {
  REMINDER_PATTERN_NAMES,
  SMART_WRAP_PRELUDE,
  UnknownReminderPatternError,
  buildSmartWrapComposer,
  isReminderPatternName,
} from '../src/smart-wrap.ts'

const FAKE_PATTERN_BODY =
  'PATTERN: nag-until-done\nTAG: FILL:<distinctive-tag>\nGOAL: FILL:<one-sentence>\n\nTASK: Each morning, compose a nudge...'

function fakeLoader(name: string): string {
  if (name === 'nag-until-done') return FAKE_PATTERN_BODY
  if (name === 'escalating-urgency') {
    return 'PATTERN: escalating-urgency\nTAG: FILL:<tag>\nTASK: FILL:<task>\nDEADLINE: FILL:<YYYY-MM-DD>'
  }
  throw new Error(`unrecognized fixture pattern: ${name}`)
}

describe('Shape A — literal', () => {
  test('round-trips the body verbatim and reports composed=false', () => {
    const composer = buildSmartWrapComposer({ loadPattern: fakeLoader })
    const result = composer.compose({
      body: 'ship the cm-engine PR',
      mode: { kind: 'literal' },
    })
    expect(result.message).toBe('ship the cm-engine PR')
    expect(result.composed).toBe(false)
    expect(result.audit.mode).toBe('literal')
    expect(result.audit.pattern_name).toBeUndefined()
  })

  test('preserves whitespace, em dashes, and special characters in the body', () => {
    const composer = buildSmartWrapComposer({ loadPattern: fakeLoader })
    const body = '   walk the dogs — Storm + Luna at 6pm   '
    const result = composer.compose({ body, mode: { kind: 'literal' } })
    expect(result.message).toBe(body)
  })
})

describe('Shape B — smart-wrap', () => {
  test('prepends the LOCKED prelude and appends the body as "Original reminder: <body>"', () => {
    const composer = buildSmartWrapComposer({ loadPattern: fakeLoader })
    const result = composer.compose({
      body: 'walk the dogs',
      mode: { kind: 'smart_wrap' },
    })
    expect(result.composed).toBe(true)
    expect(result.audit.mode).toBe('smart_wrap')
    expect(result.message.startsWith(SMART_WRAP_PRELUDE)).toBe(true)
    expect(result.message.endsWith('Original reminder: walk the dogs')).toBe(true)
  })

  test('locked-prelude SNAPSHOT — fire-time agent branch detection depends on this literal', () => {
    // Pin the byte-exact prelude. ANY change here is a deliberate
    // diff that breaks every existing Shape-B reminder until the
    // fire-time agent prompt is updated in lockstep. Brief § 7
    // invariant 11. C4-a2 (SD1): the home-dir prompt token rename to
    // {{OWNER_HOME}} — lockstep done in the same PR (9 prompt files + the template-alias
    // in prompts/template.ts keeps PRE-rename persisted bodies firing).
    expect(SMART_WRAP_PRELUDE).toBe(
      'Compose a smart version of this reminder using available context ' +
        '(current weather via {{OWNER_HOME}}/scripts/weather.sh --for-reminder, ' +
        'calendar via gog calendar events --today, recent project state from ' +
        '{{OWNER_HOME}}/Projects/<slug>/STATUS.md, time of day). Keep it 1-3 ' +
        'sentences, action-oriented, no preamble, no em dashes. If no useful ' +
        'context is available, deliver the original message verbatim.',
    )
  })

  test('the persisted message contains the verbatim body — fire-time agent reads it', () => {
    const composer = buildSmartWrapComposer({ loadPattern: fakeLoader })
    const body = 'tell me if I need a jacket before walking the dogs'
    const result = composer.compose({ body, mode: { kind: 'smart_wrap' } })
    expect(result.message.includes(body)).toBe(true)
  })
})

describe('Shape C — pattern template', () => {
  test('loads the pattern body verbatim and substitutes FILL: slots', () => {
    const composer = buildSmartWrapComposer({ loadPattern: fakeLoader })
    const result = composer.compose({
      body: 'canton fair preparation',
      mode: {
        kind: 'pattern',
        name: 'nag-until-done',
        slots: {
          '<distinctive-tag>': 'canton-fair-acme',
          '<one-sentence>': 'all flights booked',
        },
      },
    })
    expect(result.composed).toBe(true)
    expect(result.audit.mode).toBe('pattern')
    expect(result.audit.pattern_name).toBe('nag-until-done')
    expect(result.message.startsWith('PATTERN: nag-until-done')).toBe(true)
    expect(result.message.includes('TAG: canton-fair-acme')).toBe(true)
    expect(result.message.includes('GOAL: all flights booked')).toBe(true)
    // The original body lands at the end as a trailing context line.
    expect(result.message.endsWith('Original reminder: canton fair preparation')).toBe(true)
    expect(result.audit.slots_filled).toEqual(['<distinctive-tag>', '<one-sentence>'])
  })

  test('unsubstituted FILL: slots are left literal so the fire-time agent can ask', () => {
    const composer = buildSmartWrapComposer({ loadPattern: fakeLoader })
    const result = composer.compose({
      body: 'no slots given',
      mode: { kind: 'pattern', name: 'nag-until-done' },
    })
    expect(result.message.includes('FILL:<distinctive-tag>')).toBe(true)
    expect(result.audit.slots_filled).toBeUndefined()
  })

  test('throws UnknownReminderPatternError on a bogus pattern name (type-cast bypass)', () => {
    const composer = buildSmartWrapComposer({ loadPattern: fakeLoader })
    expect(() =>
      composer.compose({
        body: 'x',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mode: { kind: 'pattern', name: 'bogus-pattern' as any },
      }),
    ).toThrow(UnknownReminderPatternError)
  })

  test('wraps loader failures as UnknownReminderPatternError for consistent error codes', () => {
    const composer = buildSmartWrapComposer({
      loadPattern: () => {
        throw new Error('boom')
      },
    })
    expect(() =>
      composer.compose({
        body: 'x',
        mode: { kind: 'pattern', name: 'nag-until-done' },
      }),
    ).toThrow(UnknownReminderPatternError)
  })

  test('supports multiple distinct patterns', () => {
    const composer = buildSmartWrapComposer({ loadPattern: fakeLoader })
    const r1 = composer.compose({
      body: 'taxes',
      mode: { kind: 'pattern', name: 'nag-until-done' },
    })
    const r2 = composer.compose({
      body: 'taxes',
      mode: { kind: 'pattern', name: 'escalating-urgency' },
    })
    expect(r1.message.startsWith('PATTERN: nag-until-done')).toBe(true)
    expect(r2.message.startsWith('PATTERN: escalating-urgency')).toBe(true)
  })
})

describe('pattern-name registry', () => {
  test('REMINDER_PATTERN_NAMES contains the five locked patterns', () => {
    expect(new Set(REMINDER_PATTERN_NAMES)).toEqual(
      new Set([
        'nag-until-done',
        'escalating-urgency',
        'daily-countdown',
        'check-in-cadence',
        'context-aware-one-shot',
      ]),
    )
  })

  test('isReminderPatternName narrows correctly', () => {
    expect(isReminderPatternName('nag-until-done')).toBe(true)
    expect(isReminderPatternName('NAG-UNTIL-DONE')).toBe(false)
    expect(isReminderPatternName('unknown')).toBe(false)
    expect(isReminderPatternName(42)).toBe(false)
    expect(isReminderPatternName(null)).toBe(false)
  })
})
