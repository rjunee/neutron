/**
 * Integration boundary — the email escalation's dedup guarantee must hold on
 * BOTH surfaces, the durable chat row AND the live bubble.
 *
 * The unit tests either side of this seam each pass while the bug is present:
 * `escalate.ts` proves it sends a deterministic `idempotency_key`, and
 * `button-store.ts` proves that key collapses the row. Neither can see that
 * `createDeliver` pushed live REGARDLESS of the collapse — that only appears
 * where the real seam meets the real store, which is why this test uses both
 * concretely and mocks nothing between them.
 *
 * The retry it forces is the one that actually happens in production: deliver
 * SUCCEEDS and the local acknowledgement write (`markEscalated`) throws, so the
 * row stays eligible and the next poll tick escalates it again — the exact
 * split `escalate.ts` deliberately introduced so a bookkeeping failure is never
 * miscounted as a delivery failure.
 *
 *   Given: a real ButtonStore + a real createDeliver over a recording app push,
 *     and an email whose first `markEscalated` throws.
 *   When:  the escalation runs, fails to record, and is retried.
 *   Then:  exactly ONE durable button_prompts row and exactly ONE live emission.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ChatOutbound } from '@neutronai/landing/chat-protocol.ts'
// Relative, not by package name: the root workspace deliberately does not
// depend on the email Core (and the Core deliberately does not depend on the
// gateway). This file is the ONE place the two meet, and it reaches into both
// directly rather than adding a dependency edge in either direction.
import {
  openEmailPipelineStore,
  type EmailPipelineStore,
} from '@neutronai/email-managed-core/pipeline/store'
import { escalateEmail } from '@neutronai/email-managed-core/pipeline/escalate'

import { createDeliver } from '@neutronai/gateway/http/deliver.ts'
import { openMigratedDbAt } from '../support/migrated-db.ts'

const TOPIC = 'app:owner-1'
const EMAIL_ID = 'msg-important-1'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let pipeline: EmailPipelineStore
let live: ChatOutbound[]
let now = 1_700_000_000_000

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-esc-dedup-'))
  db = openMigratedDbAt(join(tmp, 'project.db'))
  buttonStore = new ButtonStore({ db, now: () => now })
  pipeline = openEmailPipelineStore({ owner_home: tmp, now: () => now })
  live = []
  pipeline.insertEmail({
    id: EMAIL_ID,
    thread_id: 'thr-1',
    sender: 'billing@vendor.example.com',
    subject: 'Payment failed',
    received_at: now,
    processed_at: now,
    category: 'billing',
    handling: 'escalate',
  })
})

afterEach(() => {
  pipeline.close()
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function countPrompts(): number {
  const row = db
    .raw()
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM button_prompts`)
    .get()
  return row?.n ?? 0
}

/** The real seam, over a recording live target that always accepts. */
function realDeliver(): ReturnType<typeof createDeliver> {
  return createDeliver({
    buttonStore,
    push: {
      app: (_topic, event) => {
        live.push(event)
        return true
      },
    },
    log: () => {},
  })
}

/**
 * The pipeline store with ONE poisoned acknowledgement. `Object.create` rather
 * than a spread — a spread copies own fields and leaves the prototype methods
 * behind, producing a store that has forgotten how to do anything.
 */
function storeWithFailingAck(fail_times: number): EmailPipelineStore {
  let remaining = fail_times
  const proxy = Object.create(pipeline) as EmailPipelineStore
  Object.defineProperty(proxy, 'markEscalated', {
    value: (id: string, at: number, account_id: string | null = null): void => {
      if (remaining > 0) {
        remaining -= 1
        throw new Error('disk full')
      }
      pipeline.markEscalated(id, at, account_id)
    },
  })
  return proxy
}

describe('email escalation retry — one durable row, one live bubble', () => {
  test('a post-delivery acknowledgement failure does not re-notify a live owner', async () => {
    const deliver = realDeliver()
    const store = storeWithFailingAck(1)
    const email = {
      id: EMAIL_ID,
      sender: 'billing@vendor.example.com',
      subject: 'Payment failed',
      reason: 'a payment method needs attention',
    }
    const deps = {
      deliver,
      topic_id: TOPIC,
      push: null,
      project_slug: 'neutron-open',
      store,
      now: () => now,
    }

    // Attempt one: the owner IS told, the acknowledgement write throws, so the
    // row stays eligible — delivered:true, escalated_at still null.
    const first = await escalateEmail(email, deps)
    expect(first.delivered).toBe(true)
    expect(pipeline.getEmail(EMAIL_ID)?.escalated_at ?? null).toBeNull()
    expect(countPrompts()).toBe(1)
    expect(live.length).toBe(1)

    // The next tick's resume pass retries the same message.
    now += 5 * 60_000
    const second = await escalateEmail(email, deps)
    expect(second.delivered).toBe(true)

    // BOTH surfaces deduped. One row was already pinned by the idempotency key;
    // the live count is the assertion this test exists for.
    expect(countPrompts()).toBe(1)
    expect(live.length).toBe(1)
    expect(pipeline.getEmail(EMAIL_ID)?.escalated_at).toBe(now)
  })

  test('a durable row that never rendered live IS re-rendered on retry', async () => {
    // The other half of the EmitResult contract, and the reason the guard reads
    // `was_delivered` rather than `was_new` alone: a row that landed in the DB
    // while no socket was open must still reach the owner when one appears.
    // Gating on `!was_new` alone would strand it un-rendered forever.
    let online = false
    const deliver = createDeliver({
      buttonStore,
      push: {
        app: (_topic, event) => {
          if (!online) return false
          live.push(event)
          return true
        },
      },
      log: () => {},
    })
    const email = {
      id: EMAIL_ID,
      sender: 'billing@vendor.example.com',
      subject: 'Payment failed',
      reason: 'a payment method needs attention',
    }
    const deps = {
      deliver,
      topic_id: TOPIC,
      push: null,
      project_slug: 'neutron-open',
      store: storeWithFailingAck(1),
      now: () => now,
    }

    await escalateEmail(email, deps)
    expect(countPrompts()).toBe(1)
    expect(live.length).toBe(0)

    online = true
    now += 5 * 60_000
    await escalateEmail(email, deps)
    expect(countPrompts()).toBe(1)
    expect(live.length).toBe(1)
  })
})
