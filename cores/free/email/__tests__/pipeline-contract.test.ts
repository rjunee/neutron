/**
 * The two contract additions the pipeline needs — `modifyMessage` and the
 * generalized `ensureLabel` — across BOTH backends.
 *
 * The in-memory fake and the Google wrapper have to agree, because the poller
 * is tested against the fake and runs against the wrapper.
 *
 * Every fixture address is `*.example.com`.
 */

import { describe, expect, test } from 'bun:test'

import { PROCESSED_LABEL_NAME } from '../src/contract.ts'
import { buildGoogleGmailClient } from '../src/google-client.ts'
import { buildSeededInMemoryGmailClient } from '../src/in-memory.ts'

describe('in-memory backend — modifyMessage / ensureLabel', () => {
  test('modifyMessage add/remove is reflected in a later get and list', async () => {
    const gmail = buildSeededInMemoryGmailClient()
    gmail.seed({
      id: 'm1',
      subject: 'This week at the shop',
      from: 'news@list.example.com',
      label_ids: ['INBOX'],
    })
    const label = await gmail.ensureLabel({ name: PROCESSED_LABEL_NAME })
    const result = await gmail.modifyMessage({
      message_id: 'm1',
      add_label_ids: [label.label_id],
      remove_label_ids: ['INBOX'],
    })
    expect(result.label_ids).toContain(label.label_id)
    expect(result.label_ids).not.toContain('INBOX')

    const fetched = await gmail.getMessage({ message_id: 'm1' })
    expect(fetched.label_ids).toContain(label.label_id)
    expect(fetched.label_ids).not.toContain('INBOX')
    // Archived out of the inbox — the listing no longer returns it.
    expect((await gmail.listMessages({ label: 'INBOX' })).results).toHaveLength(0)
  })

  test('modifyMessage touches ONLY the named message, not its thread', async () => {
    const gmail = buildSeededInMemoryGmailClient()
    gmail.seed({ id: 'a', thread_id: 'shared', subject: 'One', from: 'a@sender.example.com' })
    gmail.seed({ id: 'b', thread_id: 'shared', subject: 'Two', from: 'b@sender.example.com' })
    await gmail.modifyMessage({ message_id: 'a', add_label_ids: [], remove_label_ids: ['INBOX'] })
    expect((await gmail.getMessage({ message_id: 'a' })).label_ids).not.toContain('INBOX')
    expect((await gmail.getMessage({ message_id: 'b' })).label_ids).toContain('INBOX')
  })

  test('ensureLabel is idempotent — created true, then false with the same id', async () => {
    const gmail = buildSeededInMemoryGmailClient()
    const first = await gmail.ensureLabel({ name: PROCESSED_LABEL_NAME })
    expect(first.created).toBe(true)
    expect(first.label_name).toBe(PROCESSED_LABEL_NAME)
    const second = await gmail.ensureLabel({ name: PROCESSED_LABEL_NAME })
    expect(second.created).toBe(false)
    expect(second.label_id).toBe(first.label_id)
  })

  test('ensureLabel and ensureProjectLabel share one registry', async () => {
    const gmail = buildSeededInMemoryGmailClient()
    const viaProject = await gmail.ensureProjectLabel({ project_id: 'alpha' })
    const viaName = await gmail.ensureLabel({ name: viaProject.label_name })
    expect(viaName.label_id).toBe(viaProject.label_id)
    expect(viaName.created).toBe(false)
  })
})

describe('google backend — modifyMessage / ensureLabel', () => {
  test('modifyMessage POSTs /messages/<id>/modify with add + remove label ids', async () => {
    let seenUrl = ''
    let seenBody = ''
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async (input, init) => {
        seenUrl = typeof input === 'string' ? input : input.toString()
        seenBody = typeof init?.body === 'string' ? init.body : ''
        return new Response(
          JSON.stringify({ id: 'gmail-1', labelIds: ['Label_7'] }),
          { status: 200 },
        )
      },
    })
    const result = await client.modifyMessage({
      message_id: 'gmail-1',
      add_label_ids: ['Label_7'],
      remove_label_ids: ['INBOX'],
    })
    expect(seenUrl).toContain('/messages/gmail-1/modify')
    expect(JSON.parse(seenBody)).toEqual({
      addLabelIds: ['Label_7'],
      removeLabelIds: ['INBOX'],
    })
    expect(result).toEqual({ message_id: 'gmail-1', label_ids: ['Label_7'] })
  })

  test('ensureLabel creates the label by NAME on the happy path', async () => {
    let seenBody = ''
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async (input, init) => {
        seenBody = typeof init?.body === 'string' ? init.body : ''
        return new Response(JSON.stringify({ id: 'Label_9', name: PROCESSED_LABEL_NAME }), {
          status: 200,
        })
      },
    })
    const ensured = await client.ensureLabel({ name: PROCESSED_LABEL_NAME })
    expect(JSON.parse(seenBody).name).toBe(PROCESSED_LABEL_NAME)
    expect(ensured).toEqual({
      label_id: 'Label_9',
      label_name: PROCESSED_LABEL_NAME,
      created: true,
    })
  })

  test('ensureLabel falls back to list-and-match on the 409 duplicate', async () => {
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async (input, init) => {
        const method = (init?.method as string) ?? 'GET'
        if (method === 'POST') return new Response('{"error":"exists"}', { status: 409 })
        return new Response(
          JSON.stringify({
            labels: [
              { id: 'Label_1', name: 'Other' },
              { id: 'Label_9', name: PROCESSED_LABEL_NAME },
            ],
          }),
          { status: 200 },
        )
      },
    })
    const ensured = await client.ensureLabel({ name: PROCESSED_LABEL_NAME })
    expect(ensured).toEqual({
      label_id: 'Label_9',
      label_name: PROCESSED_LABEL_NAME,
      created: false,
    })
  })

  test('ensureProjectLabel still resolves through the generalized path', async () => {
    let seenBody = ''
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async (_input, init) => {
        seenBody = typeof init?.body === 'string' ? init.body : ''
        return new Response(JSON.stringify({ id: 'Label_3', name: 'Neutron/alpha' }), {
          status: 200,
        })
      },
    })
    const ensured = await client.ensureProjectLabel({ project_id: 'alpha' })
    expect(JSON.parse(seenBody).name).toBe('Neutron/alpha')
    expect(ensured.label_name).toBe('Neutron/alpha')
    expect(ensured.label_id).toBe('Label_3')
  })
})
