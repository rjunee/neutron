/**
 * The fired-reminder → app-ws topic routing table (`buildAppWsReminderTopicResolver`).
 *
 * Measured 2026-08-15: 24 reminder fires landed on `app:owner` while the owner
 * was reading (and writing in) `app:owner:neutron-open`. The composer's resolver
 * discarded the reminder's stored destination and always returned General. This
 * pins the replacement: every engine destination shape the dispatcher can hand
 * over, plus the deliberate General fallback for a destination that names no
 * existing project (a row under an unbound topic is a message that vanishes —
 * the #105 lesson).
 */
import { describe, expect, it } from 'bun:test'

import {
  buildAppWsReminderTopicResolver,
  type ReminderTopicDowngrade,
} from '../reminder-topic.ts'

function build(ids: string[]): (explicit_topic: string | null) => string {
  return buildAppWsReminderTopicResolver({
    owner_user_id: 'owner',
    listProjectIds: () => ids,
  })
}

/** A resolver plus the downgrade events it reported, in order. */
function buildReporting(ids: string[]): {
  resolve: (explicit_topic: string | null) => string
  events: ReminderTopicDowngrade[]
} {
  const events: ReminderTopicDowngrade[] = []
  const resolve = buildAppWsReminderTopicResolver({
    owner_user_id: 'owner',
    listProjectIds: () => ids,
    onDowngrade: (e) => events.push(e),
  })
  return { resolve, events }
}

describe('buildAppWsReminderTopicResolver', () => {
  it('no destination → General', () => {
    const resolve = build(['neutron-open'])
    expect(resolve(null)).toBe('app:owner')
    expect(resolve('')).toBe('app:owner')
    expect(resolve('   ')).toBe('app:owner')
  })

  it('a RAW project id (the `reminders_create` shape) → the project topic', () => {
    const resolve = build(['neutron-open'])
    expect(resolve('neutron-open')).toBe('app:owner:neutron-open')
  })

  it('a raw destination naming no existing project → General, never an unread topic', () => {
    const resolve = build(['neutron-open'])
    expect(resolve('ghost')).toBe('app:owner')
  })

  it('`app-project:<id>` (what the app reminders surface stamps) → the project topic', () => {
    const resolve = build(['neutron-open'])
    expect(resolve('app-project:neutron-open')).toBe('app:owner:neutron-open')
    expect(resolve('app-project:')).toBe('app:owner')
  })

  it('legacy `web:<user>[:<project>]` → General / the project topic', () => {
    const resolve = build(['neutron-open'])
    expect(resolve('web:owner')).toBe('app:owner')
    expect(resolve('web:owner:neutron-open')).toBe('app:owner:neutron-open')
  })

  // The `web:` branch used to compute its candidate from the first `:` past the
  // prefix and NEVER look at the user segment, while the `app:` branch beside it
  // validated the owner — so a legacy destination scoped to someone else silently
  // acquired THIS owner's project topic (Argus round 1, confirmed x2).
  it('`web:<other-user>:<project>` is a FOREIGN destination → General, never the owner topic', () => {
    const { resolve, events } = buildReporting(['neutron-open'])
    expect(resolve('web:someoneelse:neutron-open')).toBe('app:owner')
    expect(resolve('web:someoneelse')).toBe('app:owner')
    expect(events.map((e) => e.reason)).toEqual(['foreign_user', 'foreign_user'])
    expect(events[0]!.candidate).toBe('neutron-open')
  })

  it('`web:` boundary shapes do not leak a project topic', () => {
    const { resolve } = buildReporting(['neutron-open'])
    // Empty user segment.
    expect(resolve('web::neutron-open')).toBe('app:owner')
    // Empty project segment on the owner's own scope.
    expect(resolve('web:owner:')).toBe('app:owner')
    // Bare prefix.
    expect(resolve('web:')).toBe('app:owner')
    // A THIRD segment stays part of the project id — it names no project.
    expect(resolve('web:owner:neutron-open:extra')).toBe('app:owner')
  })

  // Every downgrade is REPORTED. The defect was a silent reroute; a resolver
  // that quietly falls back is the same failure in new code.
  it('every downgrade to General is reported with a reason', () => {
    const { resolve, events } = buildReporting(['neutron-open'])
    expect(resolve('ghost')).toBe('app:owner')
    expect(resolve('app-project:')).toBe('app:owner')
    expect(resolve('app:someoneelse:neutron-open')).toBe('app:owner')
    expect(events.map((e) => e.reason)).toEqual([
      'unknown_project',
      'malformed_destination',
      'foreign_user',
    ])
    expect(events[0]!.explicit_topic).toBe('ghost')
    expect(events[0]!.candidate).toBe('ghost')
  })

  it('the DESIGNED General paths are not reported as downgrades', () => {
    const { resolve, events } = buildReporting(['neutron-open'])
    expect(resolve(null)).toBe('app:owner')
    expect(resolve('  ')).toBe('app:owner')
    expect(resolve('app:owner')).toBe('app:owner')
    expect(resolve('web:owner')).toBe('app:owner')
    expect(events).toEqual([])
  })

  // A DB read failure must not masquerade as "this box has no projects" — that
  // would reroute EVERY project reminder to General, silently, which is the exact
  // failure mode this module exists to remove.
  it('a throwing project lister is REPORTED as unavailable, and never escapes', () => {
    const events: ReminderTopicDowngrade[] = []
    const resolve = buildAppWsReminderTopicResolver({
      owner_user_id: 'owner',
      listProjectIds: () => {
        throw new Error('database is locked')
      },
      onDowngrade: (e) => events.push(e),
    })
    // No throw out of `resolve` — `topicFor` runs before the post, and the
    // dispatcher would read a throw as "the post did not happen" and re-fire
    // this reminder every tick forever.
    expect(resolve('neutron-open')).toBe('app:owner')
    expect(events).toHaveLength(1)
    expect(events[0]!.reason).toBe('project_list_unavailable')
    expect(events[0]!.error).toContain('database is locked')
  })

  it('a throwing reporter cannot become a delivery failure', () => {
    const resolve = buildAppWsReminderTopicResolver({
      owner_user_id: 'owner',
      listProjectIds: () => [],
      onDowngrade: () => {
        throw new Error('logger exploded')
      },
    })
    expect(resolve('ghost')).toBe('app:owner')
  })

  // Case drift and padding are NOT projects. Reported, not silently honoured.
  it('a case-drifted or padded destination does not match a project', () => {
    const { resolve, events } = buildReporting(['neutron-open'])
    expect(resolve('Neutron-Open')).toBe('app:owner')
    expect(resolve('app-project: neutron-open')).toBe('app:owner')
    expect(events.every((e) => e.reason === 'unknown_project')).toBe(true)
  })

  it('an already surface-shaped destination is accepted only when this owner binds it', () => {
    const resolve = build(['neutron-open'])
    expect(resolve('app:owner')).toBe('app:owner')
    expect(resolve('app:owner:neutron-open')).toBe('app:owner:neutron-open')
    expect(resolve('app:owner:ghost')).toBe('app:owner')
    expect(resolve('app:someoneelse')).toBe('app:owner')
    expect(resolve('app:someoneelse:neutron-open')).toBe('app:owner')
  })

  it('the project list is dereferenced PER FIRE — a project created after boot routes scoped', () => {
    const ids: string[] = []
    const resolve = build(ids)
    expect(resolve('late-project')).toBe('app:owner')
    ids.push('late-project')
    expect(resolve('late-project')).toBe('app:owner:late-project')
  })
})
