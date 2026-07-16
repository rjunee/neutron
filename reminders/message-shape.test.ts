import { describe, expect, test } from 'bun:test'

import {
  classifyReminderMessage,
  literalFallback,
  KNOWN_REMINDER_PATTERNS,
} from './message-shape.ts'

describe('classifyReminderMessage', () => {
  test('plain text → literal', () => {
    const s = classifyReminderMessage('take out the trash')
    expect(s.kind).toBe('literal')
    if (s.kind === 'literal') expect(s.body).toBe('take out the trash')
    expect(s.routing_topic).toBeNull()
  })

  test('[smart] prefix → smart-wrap, marker stripped', () => {
    const s = classifyReminderMessage('[smart] compose a weather-aware dog walk nudge')
    expect(s.kind).toBe('smart-wrap')
    if (s.kind === 'smart-wrap') {
      expect(s.instruction).toBe('compose a weather-aware dog walk nudge')
    }
  })

  test('PATTERN: header → pattern with name + full block', () => {
    const msg = 'PATTERN: nag-until-done\nTAG: canton-fair\nGOAL: book the trip'
    const s = classifyReminderMessage(msg)
    expect(s.kind).toBe('pattern')
    if (s.kind === 'pattern') {
      expect(s.pattern).toBe('nag-until-done')
      expect(s.known).toBe(true)
      expect(s.block).toContain('GOAL: book the trip')
    }
  })

  test('unknown PATTERN name → pattern with known=false', () => {
    const s = classifyReminderMessage('PATTERN: made-up-thing\nfoo: bar')
    expect(s.kind).toBe('pattern')
    if (s.kind === 'pattern') {
      expect(s.pattern).toBe('made-up-thing')
      expect(s.known).toBe(false)
    }
  })

  test('[ROUTING] header is parsed off and stripped from the body', () => {
    const msg = '[ROUTING] target_thread: 4242\ntake out the trash'
    const s = classifyReminderMessage(msg)
    expect(s.routing_topic).toBe('4242')
    expect(s.kind).toBe('literal')
    if (s.kind === 'literal') expect(s.body).toBe('take out the trash')
  })

  test('[ROUTING] header combines with a pattern body', () => {
    const msg = '[ROUTING] target_thread: proj-7\nPATTERN: daily-countdown\nEVENT: launch'
    const s = classifyReminderMessage(msg)
    expect(s.routing_topic).toBe('proj-7')
    expect(s.kind).toBe('pattern')
    if (s.kind === 'pattern') expect(s.pattern).toBe('daily-countdown')
  })

  test('[ROUTING] mid-body is NOT treated as a header', () => {
    const msg = 'do the thing\n[ROUTING] target_thread: nope'
    const s = classifyReminderMessage(msg)
    expect(s.routing_topic).toBeNull()
    expect(s.kind).toBe('literal')
  })

  test('every KNOWN pattern classifies as known', () => {
    for (const p of KNOWN_REMINDER_PATTERNS) {
      const s = classifyReminderMessage(`PATTERN: ${p}\nx: y`)
      expect(s.kind).toBe('pattern')
      if (s.kind === 'pattern') expect(s.known).toBe(true)
    }
  })
})

describe('literalFallback', () => {
  test('literal → body verbatim', () => {
    expect(literalFallback(classifyReminderMessage('walk the dogs'))).toBe('walk the dogs')
  })

  test('smart-wrap → instruction text', () => {
    expect(literalFallback(classifyReminderMessage('[smart] ping about standup'))).toBe(
      'ping about standup',
    )
  })

  test('smart-wrap with an "Original reminder:" tail → degrades to the original phrase, not the instruction', () => {
    // The Reminders Core composer persists `[smart] <prelude>\n\nOriginal
    // reminder: <body>`; the no-LLM degrade must post <body>, never the
    // composition prelude. Regression for N7 Codex blocker 1.
    const composed =
      '[smart] Compose a smart version of this reminder using available context ' +
      '(recent project state from STATUS.md, the day of week and time of day).\n\n' +
      'Original reminder: walk the dogs'
    const out = literalFallback(classifyReminderMessage(composed))
    expect(out).toBe('walk the dogs')
    expect(out).not.toContain('Compose a smart version')
  })

  test('pattern → GOAL line, FILL marker stripped, never raw scaffold', () => {
    const out = literalFallback(
      classifyReminderMessage('PATTERN: nag-until-done\nGOAL: FILL:book the Canton Fair trip'),
    )
    expect(out).toBe('book the Canton Fair trip')
    expect(out).not.toContain('PATTERN:')
  })

  test('pattern with no recognizable line → neutral degrade', () => {
    const out = literalFallback(classifyReminderMessage('PATTERN: nag-until-done\nrandom: stuff'))
    expect(out).toBe('You have a reminder due.')
  })
})
