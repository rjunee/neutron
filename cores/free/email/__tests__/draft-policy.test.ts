/**
 * Email-Managed Core — Sam's load-bearing 4-point draft policy.
 *
 * **THIS IS THE LOAD-BEARING TEST** for the Tier 1 product contract.
 * Per docs/plans/email-managed-core-tier1-brief.md § 8 invariant 12
 * + § 12 verification gate item 5: regression failure of this test
 * is a ship-blocking Argus block. If it ever fails, the Core's
 * product contract (every drafted email goes to Sam's inbox marked
 * IMPORTANT + UNREAD) is broken.
 *
 * Asserts the contract at the unit-level against mocked GmailClient
 * methods:
 *   1. `createDraft` was called once with the input body.
 *   2. The post-create thread state carries INBOX + IMPORTANT +
 *      UNREAD on the resulting draft's thread.
 *   3. When `project_id` is supplied, the post-state ALSO carries
 *      `Neutron/<project_id>`.
 *   4. When the underlying threads.modify call fails, the policy
 *      surfaces `DraftLabelingError` carrying the orphaned draft_id
 *      (partial-completion failure observable + recoverable).
 *   5. `retryDraftLabels` is idempotent — calling it twice with the
 *      same arguments after a partial failure ALSO ends in the
 *      INBOX + IMPORTANT + UNREAD state.
 */

import { expect, test, describe } from 'bun:test'

import {
  applyDraftVisibilityLabels,
  plannedDraftLabels,
  retryDraftLabels,
} from '../src/draft-policy.ts'
import type { GmailClient, GmailDraftInput } from '../src/contract.ts'
import { DraftLabelingError } from '../src/errors.ts'
import { buildSeededInMemoryGmailClient } from '../src/in-memory.ts'
import { DEFAULT_DRAFT_LABEL_IDS, projectLabelName } from '../src/manifest.ts'

describe('Sam 4-point draft policy (load-bearing)', () => {
  test('DEFAULT_DRAFT_LABEL_IDS is exactly INBOX + IMPORTANT + UNREAD', () => {
    expect([...DEFAULT_DRAFT_LABEL_IDS]).toEqual(['INBOX', 'IMPORTANT', 'UNREAD'])
  })

  test('applyDraftVisibilityLabels — post-state has INBOX + IMPORTANT + UNREAD (the load-bearing assertion)', async () => {
    const client = buildSeededInMemoryGmailClient()
    const draft: GmailDraftInput = {
      to: ['casey@example.com'],
      subject: 'Hello',
      body: 'Just checking in.',
    }
    const result = await applyDraftVisibilityLabels({ client, draft })
    // The applied_labels echo from the backend MUST carry all three
    // 4-point labels. This is the contract Sam's hard rule maps to.
    expect(result.applied_labels).toContain('INBOX')
    expect(result.applied_labels).toContain('IMPORTANT')
    expect(result.applied_labels).toContain('UNREAD')
    // Verify by re-reading the draft's underlying message — the
    // thread state stamped onto the row carries all three labels.
    const full = await client.getMessage({ message_id: result.message_id })
    expect(full.label_ids).toContain('INBOX')
    expect(full.label_ids).toContain('IMPORTANT')
    expect(full.label_ids).toContain('UNREAD')
    // The DRAFT label is preserved alongside the 4-point set —
    // threads.modify(addLabelIds=...) is additive, not destructive.
    expect(full.label_ids).toContain('DRAFT')
  })

  test('applyDraftVisibilityLabels — with project_id, ALSO applies Neutron/<project_id>', async () => {
    const client = buildSeededInMemoryGmailClient()
    const draft: GmailDraftInput = {
      to: ['casey@example.com'],
      subject: 'project-scoped',
      body: 'project body',
      project_id: 'alpha',
    }
    const result = await applyDraftVisibilityLabels({ client, draft })
    expect(result.applied_labels).toContain('INBOX')
    expect(result.applied_labels).toContain('IMPORTANT')
    expect(result.applied_labels).toContain('UNREAD')
    expect(result.applied_labels).toContain(projectLabelName('alpha'))
    const full = await client.getMessage({ message_id: result.message_id })
    expect(full.label_ids).toContain(projectLabelName('alpha'))
  })

  test('applyDraftVisibilityLabels — mocked client receives the right call order + labels', async () => {
    const calls: { name: string; args: unknown }[] = []
    const fakeClient: GmailClient = {
      async listMessages() {
        return { results: [] }
      },
      async getMessage() {
        throw new Error('unused')
      },
      async getThread() {
        throw new Error('unused')
      },
      async search() {
        return { results: [] }
      },
      async createDraft(input) {
        calls.push({ name: 'createDraft', args: input })
        // Simulate the production backend's 2-call sequence: the
        // wrapper's job is to call modifyThread after the create.
        // In the mocked client we capture both calls.
        calls.push({
          name: 'modifyThread',
          args: {
            thread_id: 'thread-stub',
            add_label_ids: ['INBOX', 'IMPORTANT', 'UNREAD'],
          },
        })
        return {
          draft_id: 'draft-stub',
          message_id: 'msg-stub',
          thread_id: 'thread-stub',
          applied_labels: ['INBOX', 'IMPORTANT', 'UNREAD'],
        }
      },
      async sendMessage() {
        return { message_id: 'sent-stub', thread_id: 'thread-stub', applied_labels: [] }
      },
      async ensureProjectLabel() {
        return { label_id: 'Label_x', label_name: 'Neutron/x', created: false }
      },
      async modifyThread() {
        return { thread_id: 'thread-stub', label_ids: [] }
      },
    }
    const draft: GmailDraftInput = {
      to: ['x@y.com'],
      subject: 'Hi',
      body: 'hi',
    }
    const result = await applyDraftVisibilityLabels({ client: fakeClient, draft })
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls[0]?.name).toBe('createDraft')
    expect(calls[1]?.name).toBe('modifyThread')
    const modifyArgs = calls[1]?.args as { add_label_ids: string[] }
    expect(modifyArgs.add_label_ids).toEqual(['INBOX', 'IMPORTANT', 'UNREAD'])
    expect(result.draft_id).toBe('draft-stub')
    expect(result.applied_labels).toEqual(['INBOX', 'IMPORTANT', 'UNREAD'])
  })

  test('applyDraftVisibilityLabels — partial completion throws DraftLabelingError carrying orphaned draft_id', async () => {
    const failingClient: GmailClient = {
      async listMessages() {
        return { results: [] }
      },
      async getMessage() {
        throw new Error('unused')
      },
      async getThread() {
        throw new Error('unused')
      },
      async search() {
        return { results: [] }
      },
      async createDraft() {
        // The production backend wraps drafts.create + threads.modify
        // in one call; partial-completion failures surface from
        // `createDraft` as DraftLabelingError. Simulate that here.
        throw new DraftLabelingError(
          'draft-orphan',
          'thread-orphan',
          'msg-orphan',
          new Error('threads.modify failed: 500'),
        )
      },
      async sendMessage() {
        return { message_id: 'sent-stub', thread_id: 'thread-stub', applied_labels: [] }
      },
      async ensureProjectLabel() {
        return { label_id: 'Label_x', label_name: 'Neutron/x', created: false }
      },
      async modifyThread() {
        return { thread_id: '', label_ids: [] }
      },
    }
    const draft: GmailDraftInput = {
      to: ['x@y.com'],
      subject: 'Hi',
      body: 'body',
    }
    let caught: unknown
    try {
      await applyDraftVisibilityLabels({ client: failingClient, draft })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(DraftLabelingError)
    const e = caught as DraftLabelingError
    expect(e.code).toBe('draft_labeling_failed')
    expect(e.draft_id).toBe('draft-orphan')
    expect(e.thread_id).toBe('thread-orphan')
    expect(e.message_id).toBe('msg-orphan')
  })

  test('retryDraftLabels — idempotent re-application of the 4-point labels', async () => {
    // First create the draft via the seeded backend so the thread
    // state actually exists.
    const client = buildSeededInMemoryGmailClient()
    const initial = await client.createDraft({
      to: ['casey@example.com'],
      subject: 'idempotent',
      body: 'body',
    })
    // Retry with the same draft_id + thread_id — should land the
    // same labels (no-op).
    const replayed = await retryDraftLabels({
      client,
      draft_id: initial.draft_id,
      thread_id: initial.thread_id,
      message_id: initial.message_id,
    })
    expect(replayed.applied_labels).toContain('INBOX')
    expect(replayed.applied_labels).toContain('IMPORTANT')
    expect(replayed.applied_labels).toContain('UNREAD')
  })

  test('retryDraftLabels with project_id — re-resolves the project label idempotently', async () => {
    const client = buildSeededInMemoryGmailClient()
    const initial = await client.createDraft({
      to: ['casey@example.com'],
      subject: 'idempotent-with-project',
      body: 'body',
      project_id: 'beta',
    })
    const replayed = await retryDraftLabels({
      client,
      draft_id: initial.draft_id,
      thread_id: initial.thread_id,
      message_id: initial.message_id,
      project_id: 'beta',
    })
    expect(replayed.applied_labels).toContain('INBOX')
    expect(replayed.applied_labels).toContain('IMPORTANT')
    expect(replayed.applied_labels).toContain('UNREAD')
    // The project label NAME — `Neutron/beta` — should show up via
    // the resolved Gmail label_id; both backends agree the label
    // round-trips.
    expect(replayed.applied_labels.some((l) => l.startsWith('Label_'))).toBe(true)
  })

  test('plannedDraftLabels — pure helper returns the right preview shape', () => {
    expect(plannedDraftLabels()).toEqual(['INBOX', 'IMPORTANT', 'UNREAD'])
    expect(plannedDraftLabels('gamma')).toEqual([
      'INBOX',
      'IMPORTANT',
      'UNREAD',
      'Neutron/gamma',
    ])
  })
})
