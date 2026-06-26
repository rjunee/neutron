/**
 * Unit tests for the pure engagement-mode core (connect/agent-engagement.ts):
 * the `@neutron` mention detector, the routing gate, and the inline-vs-delegate
 * intent classifier. No I/O — these lock the spec's §2/§3/§4 mechanics.
 */

import { describe, expect, test } from 'bun:test'

import {
  ALL_AGENT_ENGAGEMENT_MODES,
  DEFAULT_AGENT_ENGAGEMENT_MODE,
  DEFAULT_AGENT_HANDLES,
  classifyTaggedIntent,
  detectAgentMention,
  isAgentEngagementMode,
  resolveEngagement,
} from '../agent-engagement.ts'

describe('mode vocabulary', () => {
  test('default is all_messages (single-person-chat-consistent)', () => {
    expect(DEFAULT_AGENT_ENGAGEMENT_MODE).toBe('all_messages')
  })
  test('exactly two modes', () => {
    expect([...ALL_AGENT_ENGAGEMENT_MODES].sort()).toEqual([
      'all_messages',
      'tag_gated',
    ])
  })
  test('type guard rejects junk', () => {
    expect(isAgentEngagementMode('tag_gated')).toBe(true)
    expect(isAgentEngagementMode('all_messages')).toBe(true)
    expect(isAgentEngagementMode('whatever')).toBe(false)
    expect(isAgentEngagementMode(null)).toBe(false)
    expect(isAgentEngagementMode(undefined)).toBe(false)
  })
})

describe('detectAgentMention', () => {
  test('plain @neutron mention', () => {
    expect(detectAgentMention('@neutron can you help?')).toBe(true)
  })
  test('case-insensitive', () => {
    expect(detectAgentMention('Hey @Neutron!')).toBe(true)
    expect(detectAgentMention('hey @NEUTRON')).toBe(true)
  })
  test('mid-sentence mention', () => {
    expect(detectAgentMention('I think @neutron should take this')).toBe(true)
  })
  test('alias @claude also triggers', () => {
    expect(detectAgentMention('@claude what do you think')).toBe(true)
  })
  test('no mention → false', () => {
    expect(detectAgentMention('just chatting with the team')).toBe(false)
  })
  test('handle as a bare word (no @) does NOT trigger', () => {
    expect(detectAgentMention('neutron is a particle')).toBe(false)
  })
  test('longer handle (@neutrons) does NOT false-match', () => {
    expect(detectAgentMention('look at these @neutrons flying')).toBe(false)
    expect(detectAgentMention('@neutron_bot is different')).toBe(false)
  })
  test('email address is not a mention', () => {
    expect(detectAgentMention('mail me at ryan@neutron.com')).toBe(false)
  })
  test('doc-quote guard: inline code', () => {
    expect(detectAgentMention('the docs say `@neutron does X`')).toBe(false)
  })
  test('doc-quote guard: fenced code block', () => {
    expect(
      detectAgentMention('```\nping @neutron here\n```'),
    ).toBe(false)
  })
  test('doc-quote guard: blockquote line', () => {
    expect(detectAgentMention('> earlier: @neutron said hi')).toBe(false)
  })
  test('mention outside code but quote inside still triggers', () => {
    expect(
      detectAgentMention('@neutron please look at `the @other thing`'),
    ).toBe(true)
  })
  test('multiple mentions collapse to one trigger (boolean)', () => {
    expect(detectAgentMention('@neutron @neutron @neutron go')).toBe(true)
  })
  test('custom handle set', () => {
    expect(detectAgentMention('@bot hi', { handles: ['bot'] })).toBe(true)
    expect(detectAgentMention('@neutron hi', { handles: ['bot'] })).toBe(false)
  })
  test('default handles export is stable', () => {
    expect(DEFAULT_AGENT_HANDLES).toContain('neutron')
  })
})

describe('resolveEngagement', () => {
  test('all_messages: every post engages, mention irrelevant', () => {
    const d = resolveEngagement({ mode: 'all_messages', text: 'hello team' })
    expect(d.engage).toBe(true)
    expect(d.reason).toBe('all_messages')
    expect(d.mentioned).toBe(false)
  })
  test('all_messages: a mention still engages (and is flagged)', () => {
    const d = resolveEngagement({ mode: 'all_messages', text: '@neutron hi' })
    expect(d.engage).toBe(true)
    expect(d.reason).toBe('all_messages')
    expect(d.mentioned).toBe(true)
  })
  test('tag_gated: no mention → NO agent turn', () => {
    const d = resolveEngagement({ mode: 'tag_gated', text: 'team, lunch?' })
    expect(d.engage).toBe(false)
    expect(d.reason).toBe('no_mention')
    expect(d.mentioned).toBe(false)
  })
  test('tag_gated: @mention → agent turn', () => {
    const d = resolveEngagement({ mode: 'tag_gated', text: '@neutron status?' })
    expect(d.engage).toBe(true)
    expect(d.reason).toBe('mention')
    expect(d.mentioned).toBe(true)
  })
  test('read-only member never engages even when tagging', () => {
    const d = resolveEngagement({
      mode: 'tag_gated',
      text: '@neutron do the thing',
      access: 'read',
    })
    expect(d.engage).toBe(false)
    expect(d.reason).toBe('read_only_member')
    expect(d.mentioned).toBe(true)
  })
  test('write member is the default (engages in all_messages)', () => {
    const d = resolveEngagement({ mode: 'all_messages', text: 'hi', access: 'write' })
    expect(d.engage).toBe(true)
  })
})

describe('classifyTaggedIntent', () => {
  test('conversational question → inline', () => {
    const r = classifyTaggedIntent('@neutron what is the project status?')
    expect(r.intent).toBe('inline')
    expect(r.task).toBe('what is the project status?')
  })
  test('imperative task → delegate (adhoc)', () => {
    const r = classifyTaggedIntent('@neutron build the export pipeline')
    expect(r.intent).toBe('delegate')
    expect(r.kind).toBe('adhoc')
    expect(r.task).toBe('build the export pipeline')
  })
  test('research verb → delegate research', () => {
    const r = classifyTaggedIntent('@neutron research the competitor pricing')
    expect(r.intent).toBe('delegate')
    expect(r.kind).toBe('research')
  })
  test('review verb → delegate review', () => {
    const r = classifyTaggedIntent('@neutron review the latest PR')
    expect(r.intent).toBe('delegate')
    expect(r.kind).toBe('review')
  })
  test('explicit /delegate forces delegation', () => {
    const r = classifyTaggedIntent('@neutron /delegate keep an eye on the deploy')
    expect(r.intent).toBe('delegate')
    expect(r.task).toBe('keep an eye on the deploy')
  })
  test('explicit /delegate research <task> honours kind', () => {
    const r = classifyTaggedIntent('@neutron /delegate research the Q3 numbers')
    expect(r.intent).toBe('delegate')
    expect(r.kind).toBe('research')
    expect(r.task).toBe('the Q3 numbers')
  })
  test('strips multiple leading mentions', () => {
    const r = classifyTaggedIntent('@neutron @claude what time is it?')
    expect(r.intent).toBe('inline')
    expect(r.task).toBe('what time is it?')
  })
})
