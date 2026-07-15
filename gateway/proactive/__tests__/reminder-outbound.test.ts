/**
 * F5 — `buildButtonStoreReminderOutbound` delegates a fired reminder to the ONE
 * {@link Deliver} seam. These pin the boundary the F5 rewrite created: the exact
 * topic/body/`reply`-durability it forwards, and that `post` reports the DURABLE
 * outcome (`persisted`) — a live-push failure never costs the guarantee.
 */
import { describe, expect, it } from 'bun:test'

import { buildButtonStoreReminderOutbound } from '../reminder-outbound.ts'
import type { Deliver, DeliveryEnvelope } from '../../http/deliver.ts'

describe('buildButtonStoreReminderOutbound → Deliver seam', () => {
  it('forwards the topic + body with durability:reply and returns the durable result', async () => {
    const calls: Array<{ topic: string; env: DeliveryEnvelope }> = []
    const deliver: Deliver = async (topic, env) => {
      calls.push({ topic, env })
      return { prompt_id: 'p1', persisted: true, delivered_live: true }
    }
    const ro = buildButtonStoreReminderOutbound({ deliver })
    const ok = await ro.post({ topic_id: 'app:owner', project_slug: 'owner', body: 'take a break', reminder_id: 'r1' })

    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.topic).toBe('app:owner')
    expect(calls[0]!.env).toEqual({ body: 'take a break', durability: 'reply' })
  })

  it('persisted:false → post returns false (no durable row was written)', async () => {
    const deliver: Deliver = async () => ({ prompt_id: null, persisted: false, delivered_live: false })
    const ro = buildButtonStoreReminderOutbound({ deliver })
    expect(await ro.post({ topic_id: 'app:owner', project_slug: 'owner', body: 'hi', reminder_id: 'r1' })).toBe(false)
  })

  it('a LIVE-PUSH failure still returns post(true) — the durable row is the guarantee', async () => {
    // delivered_live:false (offline / no live socket) but persisted:true → the
    // reminder IS durably recorded; post reports success independent of live delivery.
    const deliver: Deliver = async () => ({ prompt_id: 'p1', persisted: true, delivered_live: false })
    const ro = buildButtonStoreReminderOutbound({ deliver })
    expect(await ro.post({ topic_id: 'app:owner', project_slug: 'owner', body: 'hi', reminder_id: 'r1' })).toBe(true)
  })
})
