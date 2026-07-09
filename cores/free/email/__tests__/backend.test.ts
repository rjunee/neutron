import { describe, expect, test } from 'bun:test'

import {
  GoogleGmailApiError,
  MessageNotFoundError,
  OAuthMissingError,
  buildGoogleGmailClient,
  buildInMemoryGmailClient,
  buildSeededInMemoryGmailClient,
  buildStubEmailSummarizer,
} from '../index.ts'

describe('buildSeededInMemoryGmailClient', () => {
  test('listMessages returns metadata ordered NEWEST-FIRST by internal_date — the natural inbox semantic', async () => {
    // Regression: inboxes face backward (most recent on top), unlike
    // calendars which face forward (soonest first). Seed three
    // messages in shuffled-time order and assert the list comes back
    // newest-first.
    const c = buildSeededInMemoryGmailClient()
    c.seed({
      id: 'oldest',
      subject: 'old',
      from: 'old@example.com',
      internal_date: '2026-05-01T09:00:00Z',
      label_ids: ['INBOX'],
    })
    c.seed({
      id: 'newest',
      subject: 'new',
      from: 'new@example.com',
      internal_date: '2026-05-10T09:00:00Z',
      label_ids: ['INBOX'],
    })
    c.seed({
      id: 'middle',
      subject: 'mid',
      from: 'mid@example.com',
      internal_date: '2026-05-05T09:00:00Z',
      label_ids: ['INBOX'],
    })
    const { results } = await c.listMessages({})
    expect(results.map((r) => r.id)).toEqual(['newest', 'middle', 'oldest'])
  })

  test('listMessages defaults to label INBOX when caller omits label', async () => {
    const c = buildSeededInMemoryGmailClient()
    c.seed({ id: 'in', subject: 's', from: 'a@x.com', label_ids: ['INBOX'] })
    c.seed({ id: 'out', subject: 'archived', from: 'a@x.com', label_ids: ['SOMETHING_ELSE'] })
    const { results } = await c.listMessages({})
    expect(results.map((r) => r.id)).toEqual(['in'])
  })

  test('listMessages with explicit label filter narrows to that label', async () => {
    const c = buildSeededInMemoryGmailClient()
    c.seed({ id: 'a', subject: 's', from: 'a@x.com', label_ids: ['INBOX', 'IMPORTANT'] })
    c.seed({ id: 'b', subject: 's', from: 'a@x.com', label_ids: ['INBOX'] })
    const { results } = await c.listMessages({ label: 'IMPORTANT' })
    expect(results.map((r) => r.id)).toEqual(['a'])
  })

  test('listMessages respects max_results', async () => {
    const c = buildSeededInMemoryGmailClient()
    for (let i = 0; i < 10; i++) {
      c.seed({
        id: `m-${i}`,
        subject: `s ${i}`,
        from: 'a@x.com',
        internal_date: new Date(2026, 4, i + 1).toISOString(),
        label_ids: ['INBOX'],
      })
    }
    const { results } = await c.listMessages({ max_results: 3 })
    expect(results.length).toBe(3)
  })

  test('getMessage on a missing id throws MessageNotFoundError', async () => {
    const c = buildSeededInMemoryGmailClient()
    await expect(
      c.getMessage({ message_id: 'does-not-exist' }),
    ).rejects.toThrow(MessageNotFoundError)
  })

  test('getMessage returns the full body + to / cc / labels', async () => {
    const c = buildSeededInMemoryGmailClient()
    c.seed({
      id: 'msg-1',
      subject: 'kickoff',
      from: '"Casey" <casey@example.com>',
      to: ['user@example.com'],
      cc: ['nikolai@example.com'],
      body_text: 'Hi Sam,\n\nLet me know.\n\n— A',
      label_ids: ['INBOX', 'IMPORTANT'],
    })
    const full = await c.getMessage({ message_id: 'msg-1' })
    expect(full.subject).toBe('kickoff')
    expect(full.from).toBe('"Casey" <casey@example.com>')
    expect(full.to).toEqual(['user@example.com'])
    expect(full.cc).toEqual(['nikolai@example.com'])
    expect(full.label_ids).toEqual(['INBOX', 'IMPORTANT'])
    expect(full.body_text).toContain('Let me know')
  })

  test('search matches Gmail query operators — from: / subject: / is:unread / bare word fallback', async () => {
    const c = buildSeededInMemoryGmailClient()
    c.seed({
      id: 'a',
      subject: 'invoice for May',
      from: 'billing@stripe.com',
      label_ids: ['INBOX', 'UNREAD'],
      body_text: 'Please pay by 31st',
    })
    c.seed({
      id: 'b',
      subject: 'lunch?',
      from: 'morgan@example.com',
      label_ids: ['INBOX'],
      body_text: 'free tomorrow?',
    })
    c.seed({
      id: 'c',
      subject: 'invoice paid',
      from: 'billing@other.com',
      label_ids: ['INBOX'],
      body_text: 'thanks',
    })

    // from: operator
    let r = await c.search({ query: 'from:stripe.com' })
    expect(r.results.map((m) => m.id)).toEqual(['a'])

    // subject: operator
    r = await c.search({ query: 'subject:invoice' })
    expect(new Set(r.results.map((m) => m.id))).toEqual(new Set(['a', 'c']))

    // is:unread (case-insensitive label match)
    r = await c.search({ query: 'is:unread' })
    expect(r.results.map((m) => m.id)).toEqual(['a'])

    // bare word fallback hits subject OR body
    r = await c.search({ query: 'tomorrow' })
    expect(r.results.map((m) => m.id)).toEqual(['b'])

    // AND across operators
    r = await c.search({ query: 'subject:invoice from:stripe.com' })
    expect(r.results.map((m) => m.id)).toEqual(['a'])
  })

  test('search returns NEWEST-FIRST ordering, NOT created-order', async () => {
    const c = buildSeededInMemoryGmailClient()
    c.seed({
      id: 'old',
      subject: 'invoice March',
      from: 'a@x.com',
      internal_date: '2026-03-01T09:00:00Z',
    })
    c.seed({
      id: 'new',
      subject: 'invoice May',
      from: 'a@x.com',
      internal_date: '2026-05-01T09:00:00Z',
    })
    const { results } = await c.search({ query: 'subject:invoice' })
    expect(results.map((m) => m.id)).toEqual(['new', 'old'])
  })

  test('createDraft creates a DRAFT-labeled message, NOT a sent message — Tier 1 guarantee', async () => {
    const c = buildSeededInMemoryGmailClient({
      nextId: (() => {
        let n = 0
        return () => `id-${n++}`
      })(),
    })
    const result = await c.createDraft({
      to: ['alice@example.com'],
      subject: 'follow-up',
      body: 'Following up on Tuesday.',
    })
    expect(result.draft_id.startsWith('draft-')).toBe(true)
    expect(result.message_id.length).toBeGreaterThan(0)
    expect(result.thread_id.length).toBeGreaterThan(0)

    // The draft lands in the DRAFT label PLUS the Sam 4-point set
    // (INBOX + IMPORTANT + UNREAD applied by the atomic post-create
    // threads.modify call). Pre-Argus regression guard: a stray
    // `await client.send(...)` slipped into the createDraft path
    // would surface here as a missing DRAFT label.
    expect(result.applied_labels).toContain('INBOX')
    expect(result.applied_labels).toContain('IMPORTANT')
    expect(result.applied_labels).toContain('UNREAD')
    const full = await c.getMessage({ message_id: result.message_id })
    expect(full.label_ids).toContain('DRAFT')
    expect(full.label_ids).toContain('INBOX')
    expect(full.label_ids).toContain('IMPORTANT')
    expect(full.label_ids).toContain('UNREAD')
    expect(full.label_ids).not.toContain('SENT')
    expect(full.to).toEqual(['alice@example.com'])
    expect(full.body_text).toBe('Following up on Tuesday.')
  })

  test('createDraft on a reply threads the draft onto the source message thread', async () => {
    const c = buildSeededInMemoryGmailClient()
    c.seed({
      id: 'src',
      thread_id: 'thread-42',
      subject: 'kickoff',
      from: 'casey@example.com',
      label_ids: ['INBOX'],
    })
    const result = await c.createDraft({
      to: ['casey@example.com'],
      subject: 'Re: kickoff',
      body: 'Yes, 2pm works.',
      reply_to_message_id: 'src',
    })
    expect(result.thread_id).toBe('thread-42')
  })

  // Argus r1 IMPORTANT — production Google client throws
  // MessageNotFoundError on a 404 source message (verified by the
  // Codex r1 P2 regression test in this file). Pre-fix the in-memory
  // fakes silently invented a fresh thread, so tests against fakes
  // passed while prod would have rejected the same input. Both
  // fakes must match prod behaviour.
  test('seeded fake: createDraft against an unknown reply_to_message_id throws MessageNotFoundError', async () => {
    const c = buildSeededInMemoryGmailClient()
    await expect(
      c.createDraft({
        to: ['alice@example.com'],
        subject: 'Re: missing',
        body: 'body',
        reply_to_message_id: 'does-not-exist',
      }),
    ).rejects.toThrow(MessageNotFoundError)
  })
})

describe('buildInMemoryGmailClient — reply parity with prod', () => {
  test('createDraft against an unknown reply_to_message_id throws MessageNotFoundError', async () => {
    // The unseeded in-memory client has the same draft-create code
    // path as the seeded variant; both must match the production
    // Google client's 404 behaviour (Argus r1 IMPORTANT).
    const c = buildInMemoryGmailClient()
    await expect(
      c.createDraft({
        to: ['alice@example.com'],
        subject: 'Re: missing',
        body: 'body',
        reply_to_message_id: 'does-not-exist',
      }),
    ).rejects.toThrow(MessageNotFoundError)
  })

  test('createDraft (no reply) still invents a fresh thread', async () => {
    const c = buildInMemoryGmailClient()
    const r = await c.createDraft({
      to: ['x@y.com'],
      subject: 'fresh',
      body: 'body',
    })
    expect(r.thread_id.length).toBeGreaterThan(0)
    expect(r.draft_id.startsWith('draft-')).toBe(true)
  })
})

describe('buildStubEmailSummarizer', () => {
  test('returns the locked structured shape — message_id / from / subject / key_points / sentiment / ask_or_response', async () => {
    const s = buildStubEmailSummarizer()
    const summary = await s.summarize({
      message: {
        id: 'm-1',
        thread_id: 't-1',
        subject: 'Re: kickoff',
        from: '"Casey" <casey@example.com>',
        to: ['user@example.com'],
        cc: [],
        snippet: '',
        internal_date: '2026-05-18T09:00:00Z',
        label_ids: ['INBOX'],
        body_text:
          'Hi Sam. Could you confirm the 2pm slot. Thanks so much for setting this up.',
      },
    })
    expect(summary.message_id).toBe('m-1')
    expect(summary.from).toBe('"Casey" <casey@example.com>')
    expect(summary.subject).toBe('Re: kickoff')
    expect(summary.key_points.length).toBeGreaterThan(0)
    expect(['positive', 'neutral', 'negative', 'urgent']).toContain(summary.sentiment)
    expect(['ask', 'response', 'informational']).toContain(summary.ask_or_response)
  })

  test('classifies urgent keywords as `urgent`, ask language as `ask`', async () => {
    const s = buildStubEmailSummarizer()
    const summary = await s.summarize({
      message: {
        id: 'm-1',
        thread_id: 't-1',
        subject: 'deadline',
        from: 'a@x.com',
        to: [],
        cc: [],
        snippet: '',
        internal_date: '',
        label_ids: [],
        body_text: 'URGENT: please respond by EOD today.',
      },
    })
    expect(summary.sentiment).toBe('urgent')
    expect(summary.ask_or_response).toBe('ask')
  })

  test('classifies positive keywords as `positive` and `Re:` subject as a response', async () => {
    const s = buildStubEmailSummarizer()
    const summary = await s.summarize({
      message: {
        id: 'm-1',
        thread_id: 't-1',
        subject: 'Re: thanks',
        from: 'a@x.com',
        to: [],
        cc: [],
        snippet: '',
        internal_date: '',
        label_ids: [],
        body_text: 'Awesome work last week, great job everyone!',
      },
    })
    expect(summary.sentiment).toBe('positive')
    expect(summary.ask_or_response).toBe('response')
  })

  test('key_points caps at 3 sentences', async () => {
    const s = buildStubEmailSummarizer()
    const summary = await s.summarize({
      message: {
        id: 'm',
        thread_id: 't',
        subject: 'log',
        from: 'a@x.com',
        to: [],
        cc: [],
        snippet: '',
        internal_date: '',
        label_ids: [],
        body_text: 'one. two. three. four. five.',
      },
    })
    expect(summary.key_points).toEqual(['one', 'two', 'three'])
  })
})

describe('buildGoogleGmailClient — OAuth + REST wrapper', () => {
  test('throws OAuthMissingError when the accessor returns null', async () => {
    const client = buildGoogleGmailClient({
      accessToken: async () => null,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    })
    await expect(client.listMessages({})).rejects.toThrow(OAuthMissingError)
  })

  test('listMessages sends Bearer token + labelIds + maxResults query params + parses metadata response', async () => {
    const seenUrls: string[] = []
    const seenAuth: string[] = []
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString()
        seenUrls.push(url)
        const h = new Headers(init?.headers)
        seenAuth.push(h.get('authorization') ?? '')
        if (url.includes('/messages?')) {
          return new Response(
            JSON.stringify({
              messages: [
                { id: 'gmail-1', threadId: 't-1' },
                { id: 'gmail-2', threadId: 't-2' },
              ],
            }),
            { status: 200 },
          )
        }
        // metadata GET for individual messages
        if (url.includes('/messages/gmail-1')) {
          return new Response(
            JSON.stringify({
              id: 'gmail-1',
              threadId: 't-1',
              snippet: 'newest snippet',
              internalDate: '1716000000000',
              labelIds: ['INBOX'],
              payload: {
                headers: [
                  { name: 'Subject', value: 'newer' },
                  { name: 'From', value: '"A" <a@x.com>' },
                ],
              },
            }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({
            id: 'gmail-2',
            threadId: 't-2',
            snippet: 'older snippet',
            internalDate: '1715000000000',
            labelIds: ['INBOX'],
            payload: {
              headers: [
                { name: 'Subject', value: 'older' },
                { name: 'From', value: 'b@x.com' },
              ],
            },
          }),
          { status: 200 },
        )
      },
    })
    const { results } = await client.listMessages({
      label: 'INBOX',
      max_results: 5,
    })
    expect(seenUrls[0]).toContain('/messages')
    expect(seenUrls[0]).toContain('labelIds=INBOX')
    expect(seenUrls[0]).toContain('maxResults=5')
    expect(seenAuth[0]).toBe('Bearer ya29.test')
    // Newest-first ordering — gmail-1 (1716M ms) before gmail-2 (1715M ms).
    expect(results.map((r) => r.id)).toEqual(['gmail-1', 'gmail-2'])
    expect(results[0]?.subject).toBe('newer')
    expect(results[0]?.from).toBe('"A" <a@x.com>')
    expect(results[0]?.label_ids).toEqual(['INBOX'])
    // internalDate (epoch-ms string) converted to ISO-8601.
    expect(results[0]?.internal_date).toContain('T')
  })

  test('listMessages defaults to label INBOX + threads nextPageToken through to next_page_token', async () => {
    let seenUrl = ''
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async (input) => {
        seenUrl = typeof input === 'string' ? input : input.toString()
        return new Response(
          JSON.stringify({
            messages: [],
            nextPageToken: 'page-2',
          }),
          { status: 200 },
        )
      },
    })
    const result = await client.listMessages({})
    expect(seenUrl).toContain('labelIds=INBOX')
    expect(seenUrl).toContain('maxResults=25')
    expect(result.next_page_token).toBe('page-2')
  })

  test('getMessage on 404 surfaces MessageNotFoundError (single-message semantics), NOT GoogleGmailApiError', async () => {
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async () => new Response('{"error":"not found"}', { status: 404 }),
    })
    await expect(client.getMessage({ message_id: 'gone' })).rejects.toThrow(
      MessageNotFoundError,
    )
  })

  test('getMessage extracts text/plain + text/html bodies from MIME tree, splits To / Cc on top-level commas', async () => {
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            id: 'msg-x',
            threadId: 't-x',
            snippet: 'hi',
            internalDate: '1716000000000',
            labelIds: ['INBOX'],
            payload: {
              headers: [
                { name: 'Subject', value: 'multipart' },
                { name: 'From', value: '"Casey" <casey@example.com>' },
                { name: 'To', value: '"Sam, Doe" <user@example.com>, alex@x.com' },
                { name: 'Cc', value: 'nikolai@example.com' },
              ],
              parts: [
                {
                  mimeType: 'text/plain',
                  // base64url("hello world") = aGVsbG8gd29ybGQ
                  body: { data: 'aGVsbG8gd29ybGQ' },
                },
                {
                  mimeType: 'text/html',
                  // base64url("<p>hi</p>") = PHA-aGk8L3A-
                  body: { data: 'PHA-aGk8L3A-' },
                },
              ],
            },
          }),
          { status: 200 },
        ),
    })
    const full = await client.getMessage({ message_id: 'msg-x' })
    expect(full.body_text).toBe('hello world')
    expect(full.body_html).toBe('<p>hi</p>')
    // Address-list split honours quoted commas — `"Sam, Doe"
    // <user@example.com>` is ONE address, not split on the comma
    // inside the quoted display name. Then `alex@x.com` is a
    // second address.
    expect(full.to).toEqual([
      '"Sam, Doe" <user@example.com>',
      'alex@x.com',
    ])
    expect(full.cc).toEqual(['nikolai@example.com'])
  })

  // Argus r1 IMPORTANT — HTML-only Gmail messages must NOT surface an
  // empty body_text. Transactional / automated mail (Stripe receipts,
  // calendar invites, newsletter blasts) often ships text/html WITHOUT
  // a text/plain alternative; pre-fix `email_read` returned an empty
  // body_text and `email_summarize` had nothing to chew on. We derive
  // a stripped-tag plaintext fallback when no text/plain exists.
  test('getMessage on HTML-only message derives a stripped-tag plaintext fallback for body_text', async () => {
    // base64url("<p>Hello <b>Sam</b>,</p><p>Your invoice is
    // <a href=\"https://stripe.com/i/123\">$420.00</a>.</p><br>Thanks!")
    const html =
      '<p>Hello <b>Sam</b>,</p><p>Your invoice is <a href="https://stripe.com/i/123">$420.00</a>.</p><br>Thanks!'
    const b64url = btoa(html)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            id: 'html-only',
            threadId: 't-1',
            snippet: 'Hello Sam, Your invoice is $420.00.',
            internalDate: '1716000000000',
            labelIds: ['INBOX'],
            payload: {
              headers: [
                { name: 'Subject', value: 'invoice' },
                { name: 'From', value: 'billing@stripe.com' },
              ],
              // HTML-only — no text/plain alternative.
              parts: [{ mimeType: 'text/html', body: { data: b64url } }],
            },
          }),
          { status: 200 },
        ),
    })
    const full = await client.getMessage({ message_id: 'html-only' })
    // body_html still surfaces the original HTML verbatim.
    expect(full.body_html).toContain('<p>Hello <b>Sam</b>')
    // body_text contains the stripped text — tags gone, content
    // preserved, paragraph boundaries become newlines.
    expect(full.body_text.length).toBeGreaterThan(0)
    expect(full.body_text).toContain('Hello Sam')
    expect(full.body_text).toContain('Your invoice is $420.00')
    expect(full.body_text).toContain('Thanks!')
    // Tags were stripped.
    expect(full.body_text).not.toContain('<p>')
    expect(full.body_text).not.toContain('<b>')
    expect(full.body_text).not.toContain('<a ')
  })

  test('getMessage on HTML-only message at the payload root (no parts[]) still derives plaintext', async () => {
    const html = '<p>Body.</p>'
    const b64url = btoa(html)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            id: 'html-flat',
            threadId: 't-1',
            snippet: 'Body.',
            internalDate: '1716000000000',
            labelIds: ['INBOX'],
            payload: {
              headers: [{ name: 'Subject', value: 's' }],
              mimeType: 'text/html',
              body: { data: b64url },
            },
          }),
          { status: 200 },
        ),
    })
    const full = await client.getMessage({ message_id: 'html-flat' })
    expect(full.body_text).toBe('Body.')
  })

  test('getMessage prefers an existing text/plain over the HTML fallback', async () => {
    // If a text/plain alternative is present, body_text MUST equal
    // it verbatim — the fallback only fires when text/plain is
    // absent. Defensive guard against the fallback overwriting a
    // legitimate plaintext body.
    const b64plain = btoa('plain text body')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const b64html = btoa('<p>html body</p>')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            id: 'multi',
            threadId: 't-1',
            internalDate: '1716000000000',
            labelIds: ['INBOX'],
            payload: {
              headers: [{ name: 'Subject', value: 's' }],
              parts: [
                { mimeType: 'text/plain', body: { data: b64plain } },
                { mimeType: 'text/html', body: { data: b64html } },
              ],
            },
          }),
          { status: 200 },
        ),
    })
    const full = await client.getMessage({ message_id: 'multi' })
    expect(full.body_text).toBe('plain text body')
    expect(full.body_html).toBe('<p>html body</p>')
  })

  test('createDraft on a reply includes the source threadId in the message payload so Gmail attaches the draft to the existing conversation (Codex r1 P2 regression guard)', async () => {
    // Gmail's drafts.create attaches a draft to an existing thread
    // when the message resource's `threadId` field is set. Headers
    // alone (In-Reply-To / References) are not enough — pre-r1 the
    // wrapper only set the headers, so reply drafts surfaced as
    // brand-new conversations in the Drafts label even though MIME-
    // aware clients would have rendered them as in-thread replies.
    let seenDraftBody = ''
    let seenMetadataPaths: string[] = []
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = (init?.method as string) ?? 'GET'
        if (method === 'GET' && url.includes('/messages/')) {
          seenMetadataPaths.push(url)
          // Return the source message with a threadId + Message-ID
          // header so the wrapper has both pieces of data it needs.
          return new Response(
            JSON.stringify({
              id: 'src-message',
              threadId: 'thread-abc',
              snippet: '',
              internalDate: '1716000000000',
              labelIds: ['INBOX'],
              payload: {
                headers: [
                  { name: 'Message-ID', value: '<orig@mail.gmail.com>' },
                ],
              },
            }),
            { status: 200 },
          )
        }
        if (method === 'POST' && url.includes('/drafts')) {
          seenDraftBody = typeof init?.body === 'string' ? init.body : ''
          return new Response(
            JSON.stringify({
              id: 'draft-99',
              message: { id: 'msg-99', threadId: 'thread-abc' },
            }),
            { status: 200 },
          )
        }
        return new Response('{}', { status: 200 })
      },
    })
    const result = await client.createDraft({
      to: ['alice@example.com'],
      subject: 'Re: kickoff',
      body: 'Yes, 2pm works.',
      reply_to_message_id: 'src-message',
    })
    // The drafts.create payload MUST carry both the raw MIME and the
    // threadId on the message resource.
    const body = JSON.parse(seenDraftBody) as {
      message: { raw: string; threadId?: string }
    }
    expect(body.message.threadId).toBe('thread-abc')
    expect(typeof body.message.raw).toBe('string')
    expect(body.message.raw.length).toBeGreaterThan(0)
    // Decode the raw MIME and verify the headers were still set.
    const padded = body.message.raw
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(
        body.message.raw.length +
          ((4 - (body.message.raw.length % 4)) % 4),
        '=',
      )
    const decoded = atob(padded)
    expect(decoded).toContain('In-Reply-To: <orig@mail.gmail.com>')
    expect(decoded).toContain('References: <orig@mail.gmail.com>')
    // Only ONE metadata GET — pre-r1 the wrapper made two
    // round-trips (fetchFull + a second metadata GET) for the same
    // data; r1 collapses them into one.
    expect(seenMetadataPaths.length).toBe(1)
    expect(result.thread_id).toBe('thread-abc')
  })

  test('createDraft (no reply) does NOT set threadId — fresh thread', async () => {
    let draftBody = ''
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/drafts')) {
          draftBody = typeof init?.body === 'string' ? init.body : ''
          return new Response(
            JSON.stringify({
              id: 'draft-1',
              message: { id: 'msg-1', threadId: 'thread-fresh' },
            }),
            { status: 200 },
          )
        }
        // threads/<id>/modify — the post-create 4-point step.
        return new Response(
          JSON.stringify({
            id: 'thread-fresh',
            labelIds: ['INBOX', 'IMPORTANT', 'UNREAD'],
          }),
          { status: 200 },
        )
      },
    })
    await client.createDraft({
      to: ['x@y.com'],
      subject: 'fresh',
      body: 'fresh body',
    })
    const body = JSON.parse(draftBody) as {
      message: { raw: string; threadId?: string }
    }
    expect(body.message.threadId).toBeUndefined()
  })

  test('createDraft reply against a 404 source surfaces MessageNotFoundError (the source was deleted between fetch + draft) — Codex r1 follow-up: error mapping survives the single-GET refactor', async () => {
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async () => new Response('{"error":"not found"}', { status: 404 }),
    })
    await expect(
      client.createDraft({
        to: ['x@y.com'],
        subject: 'reply',
        body: 'body',
        reply_to_message_id: 'deleted-source',
      }),
    ).rejects.toThrow(MessageNotFoundError)
  })

  test('createDraft POSTs to /drafts with a URL-safe-base64-encoded raw message', async () => {
    const seen: { url: string; method: string; body: string } = {
      url: '',
      method: '',
      body: '',
    }
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/drafts')) {
          seen.url = url
          seen.method = (init?.method as string) ?? 'GET'
          seen.body = typeof init?.body === 'string' ? init.body : ''
          return new Response(
            JSON.stringify({
              id: 'draft-99',
              message: { id: 'msg-99', threadId: 'thread-99' },
            }),
            { status: 200 },
          )
        }
        // Post-create threads.modify (4-point step).
        return new Response(
          JSON.stringify({
            id: 'thread-99',
            labelIds: ['INBOX', 'IMPORTANT', 'UNREAD'],
          }),
          { status: 200 },
        )
      },
    })
    const result = await client.createDraft({
      to: ['alice@example.com'],
      subject: 'hi',
      body: 'hello',
    })
    expect(seen.method).toBe('POST')
    expect(seen.url).toContain('/drafts')
    const body = JSON.parse(seen.body) as { message: { raw: string } }
    expect(typeof body.message.raw).toBe('string')
    // Decode the raw message and assert the headers it contains.
    const padded = body.message.raw
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(body.message.raw.length + ((4 - (body.message.raw.length % 4)) % 4), '=')
    const decoded = atob(padded)
    expect(decoded).toContain('To: alice@example.com')
    expect(decoded).toContain('Subject: hi')
    expect(decoded).toContain('hello')
    expect(result.draft_id).toBe('draft-99')
    expect(result.message_id).toBe('msg-99')
    expect(result.thread_id).toBe('thread-99')
  })

  test('non-2xx responses on collection endpoints throw GoogleGmailApiError with http_status preserved (NOT MessageNotFoundError — list 404 is not a single-message-missing case)', async () => {
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async () => new Response('{"error":"not found"}', { status: 404 }),
    })
    let caught: unknown
    try {
      await client.listMessages({})
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(GoogleGmailApiError)
    expect((caught as GoogleGmailApiError).http_status).toBe(404)
  })

  test('search sends `q` query param + parses metadata response newest-first', async () => {
    let seenSearchUrl = ''
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async (input) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('q=')) {
          seenSearchUrl = url
          return new Response(
            JSON.stringify({
              messages: [{ id: 'a' }, { id: 'b' }],
            }),
            { status: 200 },
          )
        }
        // metadata fetch
        const idMatch = url.match(/\/messages\/([^?]+)/)
        const id = idMatch?.[1] ?? ''
        const dateMs = id === 'a' ? '1715000000000' : '1716000000000'
        return new Response(
          JSON.stringify({
            id,
            threadId: `t-${id}`,
            snippet: '',
            internalDate: dateMs,
            labelIds: ['INBOX'],
            payload: { headers: [{ name: 'Subject', value: `subj-${id}` }] },
          }),
          { status: 200 },
        )
      },
    })
    const { results } = await client.search({
      query: 'from:alice@example.com is:unread',
    })
    expect(seenSearchUrl).toContain('q=from%3Aalice%40example.com+is%3Aunread')
    // b (1716M) is newer than a (1715M).
    expect(results.map((r) => r.id)).toEqual(['b', 'a'])
  })
})

describe('sendMessage — Gmail send (gap-audit P0)', () => {
  test('in-memory: send marks the message SENT and applies the owner visibility labels', async () => {
    const c = buildSeededInMemoryGmailClient()
    const result = await c.sendMessage({
      to: ['alice@example.com'],
      subject: 'hello',
      body: 'body text',
    })
    expect(result.message_id.length).toBeGreaterThan(0)
    expect(result.thread_id.length).toBeGreaterThan(0)
    // Send-path counterpart to the 4-point draft rule: the sent thread
    // surfaces in the inbox via INBOX + IMPORTANT + UNREAD (DRAFT is
    // N/A for a sent message).
    expect(result.applied_labels).toContain('INBOX')
    expect(result.applied_labels).toContain('IMPORTANT')
    expect(result.applied_labels).toContain('UNREAD')
    // The stored message carries SENT, not DRAFT.
    const fetched = await c.getMessage({ message_id: result.message_id })
    expect(fetched.label_ids).toContain('SENT')
    expect(fetched.label_ids).not.toContain('DRAFT')
  })

  test('in-memory: send on a reply threads onto the source message', async () => {
    const c = buildSeededInMemoryGmailClient()
    const srcId = c.seed({ subject: 'Q', from: 'bob@example.com', thread_id: 'thread-xyz' })
    const result = await c.sendMessage({
      to: ['bob@example.com'],
      subject: 'Re: Q',
      body: 'A',
      reply_to_message_id: srcId,
    })
    expect(result.thread_id).toBe('thread-xyz')
  })

  test('in-memory: send rejects header injection in the subject (CRLF)', async () => {
    const c = buildSeededInMemoryGmailClient()
    await expect(
      c.sendMessage({
        to: ['alice@example.com'],
        subject: 'ok\r\nBcc: evil@x.com',
        body: 'b',
      }),
    ).rejects.toThrow(/CR\/LF\/NUL|injection/i)
  })

  test('in-memory: send against an unknown reply_to_message_id throws MessageNotFoundError', async () => {
    const c = buildSeededInMemoryGmailClient()
    await expect(
      c.sendMessage({ to: ['x@y.com'], subject: 's', body: 'b', reply_to_message_id: 'nope' }),
    ).rejects.toBeInstanceOf(MessageNotFoundError)
  })

  test('google client: send POSTs /messages/send then applies visibility labels via threads.modify', async () => {
    let sendBody = ''
    let modifyBody = ''
    let modifyPath = ''
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = (init?.method as string) ?? 'GET'
        if (method === 'POST' && url.includes('/messages/send')) {
          sendBody = typeof init?.body === 'string' ? init.body : ''
          return new Response(
            JSON.stringify({ id: 'sent-1', threadId: 'thread-sent-1' }),
            { status: 200 },
          )
        }
        if (method === 'POST' && url.includes('/threads/') && url.endsWith('/modify')) {
          modifyPath = url
          modifyBody = typeof init?.body === 'string' ? init.body : ''
          return new Response(
            JSON.stringify({ id: 'thread-sent-1', labelIds: ['INBOX', 'IMPORTANT', 'UNREAD'] }),
            { status: 200 },
          )
        }
        return new Response('{}', { status: 200 })
      },
    })
    const result = await client.sendMessage({
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'Body',
    })
    expect(result.message_id).toBe('sent-1')
    expect(result.thread_id).toBe('thread-sent-1')
    expect(result.applied_labels).toEqual(['INBOX', 'IMPORTANT', 'UNREAD'])
    // The send payload carries a base64url raw MIME.
    const parsedSend = JSON.parse(sendBody) as { raw: string; threadId?: string }
    expect(typeof parsedSend.raw).toBe('string')
    expect(parsedSend.raw.length).toBeGreaterThan(0)
    expect(parsedSend.threadId).toBeUndefined()
    // The post-send modify applies exactly the 3 visibility labels.
    expect(modifyPath).toContain('/threads/thread-sent-1/modify')
    expect(JSON.parse(modifyBody)).toEqual({ addLabelIds: ['INBOX', 'IMPORTANT', 'UNREAD'] })
  })

  test('google client: send on a reply sets threadId from the source message', async () => {
    let sendBody = ''
    const client = buildGoogleGmailClient({
      accessToken: async () => 'ya29.test',
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = (init?.method as string) ?? 'GET'
        if (method === 'GET' && url.includes('/messages/')) {
          return new Response(
            JSON.stringify({
              id: 'src',
              threadId: 'thread-reply',
              payload: { headers: [{ name: 'Message-ID', value: '<orig@x>' }] },
            }),
            { status: 200 },
          )
        }
        if (method === 'POST' && url.includes('/messages/send')) {
          sendBody = typeof init?.body === 'string' ? init.body : ''
          return new Response(
            JSON.stringify({ id: 'sent-2', threadId: 'thread-reply' }),
            { status: 200 },
          )
        }
        return new Response(JSON.stringify({ id: 't', labelIds: [] }), { status: 200 })
      },
    })
    const result = await client.sendMessage({
      to: ['bob@example.com'],
      subject: 'Re: x',
      body: 'reply',
      reply_to_message_id: 'src',
    })
    expect(result.thread_id).toBe('thread-reply')
    const parsed = JSON.parse(sendBody) as { raw: string; threadId?: string }
    expect(parsed.threadId).toBe('thread-reply')
    const padded = parsed.raw
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(parsed.raw.length + ((4 - (parsed.raw.length % 4)) % 4), '=')
    expect(atob(padded)).toContain('In-Reply-To: <orig@x>')
  })

  test('google client: a null access token blocks send before any fetch', async () => {
    let calls = 0
    const client = buildGoogleGmailClient({
      accessToken: async () => null,
      fetchImpl: async () => {
        calls++
        return new Response('{}', { status: 200 })
      },
    })
    await expect(
      client.sendMessage({ to: ['a@b.com'], subject: 's', body: 'b' }),
    ).rejects.toBeInstanceOf(OAuthMissingError)
    expect(calls).toBe(0)
  })
})
