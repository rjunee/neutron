/**
 * Telegram adapter — P7.3.1 MarkdownV2 bare-URL preservation.
 *
 * Background: P7.3 (PR #160) introduced MarkdownV2 escape for the
 * doc-link rewrite path. The blanket escape ALSO ran over bare URLs in
 * the body — `https://example.com` shipped as `https://example\.com`
 * which broke Telegram's auto-linkifier for plain URLs in mixed
 * messages. This suite locks the fix: when MarkdownV2 mode triggers,
 * bare http(s) URLs are detected and wrapped as `[url](url)` so they
 * render as tappable inline links instead of escaped prose.
 *
 * Scope assertions:
 *   1. Bare URL + docs:/ marker → URL wrapped, doc-link still rendered.
 *   2. Bare URL + doc_refs trailing block → URL wrapped in body, refs
 *      block unchanged.
 *   3. Bare URL only (no docs:/ marker, no doc_refs) → plain mode kept,
 *      URL ships verbatim for Telegram's native auto-link.
 *   4. URL followed by sentence punctuation (`.` / `,` / `)`) → the
 *      URL match excludes the trailing punctuation; punctuation still
 *      escapes outside the link.
 *   5. URL with query string + special chars (`?` / `&` / `=`) →
 *      preserved inside the link URL payload (only `)` / `\` escape).
 *   6. URL containing balanced parens (Wikipedia-style) → parens kept,
 *      `)` MarkdownV2-escaped inside the link payload.
 *   7. URL that is already the target of a `[label](URL)` markdown
 *      link → NOT double-wrapped.
 *   8. Multiple bare URLs in the same body → each wrapped.
 *   9. Bare URL inside the label span of a docs:/ marker → NOT
 *      double-wrapped (the docs:/ rewrite already owns that span).
 */

import { describe, expect, test } from 'bun:test'

import type { OutgoingMessage, Topic } from '../../../types.ts'
import { TelegramAdapter } from '../index.ts'
import type { TelegramClient } from '../client.ts'
import { NEUTRON_SCHEME } from '@neutronai/runtime'

const topic: Topic = {
  topic_id: 't-1',
  channel_kind: 'telegram',
  channel_topic_id: '12345',
  project_id: null,
  privacy_mode: 'regular',
}

interface CapturedCall {
  chat_id: number | string
  message_thread_id?: number
  text: string
  parse_mode?: 'MarkdownV2'
  reply_markup?: unknown
}

function makeAdapter() {
  const sent: CapturedCall[] = []
  // The bare-URL tests exercise the send path only — `setWebhook`
  // and `answerCallbackQuery` aren't called, so we don't stub them
  // (doing so would force a `Partial<TelegramClient>` shape that the
  // exactOptionalPropertyTypes typecheck rejects when the stub
  // return shape diverges from the strict response type).
  const fake = {
    sendMessage: async (payload: CapturedCall) => {
      sent.push(payload)
      return {
        message_id: sent.length,
        chat: { id: 12345, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
      } as Awaited<ReturnType<TelegramClient['sendMessage']>>
    },
  } as unknown as TelegramClient
  const adapter = new TelegramAdapter({
    client: fake,
    bot_user_id: 1,
    webhook_secret_token: 'secret',
    receiver: { receive: async () => undefined },
  })
  return { adapter, sent }
}

describe('TelegramAdapter — P7.3.1 bare-URL preservation under MarkdownV2', () => {
  test('bare URL beside a docs:/ marker is wrapped as [url](url)', async () => {
    const { adapter, sent } = makeAdapter()
    await adapter.send({
      topic,
      text: 'See https://anthropic.com and [plan](docs:/p/x.md).',
    })
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    expect(sent[0]!.text).toBe(
      'See [https://anthropic\\.com](https://anthropic.com) and ' +
        `[plan](${NEUTRON_SCHEME}://docs/p/x.md)\\.`,
    )
  })

  test('bare URL with sentence-final period is not consumed by the URL', async () => {
    const { adapter, sent } = makeAdapter()
    await adapter.send({
      topic,
      text: 'Check https://x.com. It is great. [plan](docs:/p/x.md)',
    })
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    // The bare URL excludes the trailing `.`; the `.` is an escaped
    // prose char outside the link.
    expect(sent[0]!.text).toBe(
      'Check [https://x\\.com](https://x.com)\\. It is great\\. ' +
        `[plan](${NEUTRON_SCHEME}://docs/p/x.md)`,
    )
  })

  test('bare URL with query string preserves ?/&/= inside the link payload', async () => {
    const { adapter, sent } = makeAdapter()
    await adapter.send({
      topic,
      text: 'Search: https://x.com/p?a=b&c=d here. [plan](docs:/p/x.md)',
    })
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    // Inside the (...) payload, `?`, `=`, `&` are literal. The label
    // span MarkdownV2-escapes `.`, `=`. (`?` and `&` are NOT in the
    // outside-entity escape set per Telegram MD V2 spec, so they ship
    // raw in the label span too.)
    expect(sent[0]!.text).toBe(
      'Search: [https://x\\.com/p?a\\=b&c\\=d](https://x.com/p?a=b&c=d) here\\. ' +
        `[plan](${NEUTRON_SCHEME}://docs/p/x.md)`,
    )
  })

  test('bare URL with balanced parens keeps the parens (escaped inside payload)', async () => {
    const { adapter, sent } = makeAdapter()
    await adapter.send({
      topic,
      text: 'See https://en.wikipedia.org/wiki/Foo_(bar) for context. [plan](docs:/p/x.md)',
    })
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    // Label escapes `.`, `_`, and `(`/`)`. URL payload escapes only
    // `)` and `\` per the Telegram MarkdownV2 link-payload rules.
    expect(sent[0]!.text).toBe(
      'See [https://en\\.wikipedia\\.org/wiki/Foo\\_\\(bar\\)](https://en.wikipedia.org/wiki/Foo_(bar\\)) ' +
        `for context\\. [plan](${NEUTRON_SCHEME}://docs/p/x.md)`,
    )
  })

  test('bare URL inside parens has the trailing ) stripped (sentence punctuation)', async () => {
    const { adapter, sent } = makeAdapter()
    await adapter.send({
      topic,
      text: '(see https://x.com) [plan](docs:/p/x.md)',
    })
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    expect(sent[0]!.text).toBe(
      '\\(see [https://x\\.com](https://x.com)\\) ' +
        `[plan](${NEUTRON_SCHEME}://docs/p/x.md)`,
    )
  })

  test('multiple bare URLs in the same body all get wrapped', async () => {
    const { adapter, sent } = makeAdapter()
    await adapter.send({
      topic,
      text: 'Refs: https://a.com and https://b.com. [plan](docs:/p/x.md)',
    })
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    expect(sent[0]!.text).toBe(
      'Refs: [https://a\\.com](https://a.com) and ' +
        '[https://b\\.com](https://b.com)\\. ' +
        `[plan](${NEUTRON_SCHEME}://docs/p/x.md)`,
    )
  })

  test('URL inside an existing [label](URL) link is NOT double-wrapped', async () => {
    // Existing markdown link `[click](https://x.com)` — the URL is
    // already the target of a markdown link. Wrapping it again would
    // produce nested brackets and corrupt the parent link.
    const { adapter, sent } = makeAdapter()
    await adapter.send({
      topic,
      text: '[click](https://x.com) [plan](docs:/p/x.md)',
    })
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    // The non-docs:/ markdown link is NOT processed as a rewrite
    // (only docs:/ markers are). The blanket escape still applies to
    // it — that's a separate pre-existing bug outside this sprint's
    // scope. The invariant we lock here: the BARE URL detector does
    // not nest a wrapper inside the parent link's `(...)` payload.
    // Concretely: the output must NOT contain `[https://` (nested
    // wrapper opener) and must NOT contain `](https://x.com)](`
    // (double-target).
    expect(sent[0]!.text).not.toContain('[https://')
    expect(sent[0]!.text).not.toContain('](https://x.com)](')
  })

  test('bare URL inside the label of a docs:/ marker is NOT double-wrapped', async () => {
    // The docs:/ rewrite owns the entire `[label](docs:/...)` span;
    // bare URL detection must skip URLs inside that span so the label
    // ships as one MarkdownV2-escaped chunk.
    const { adapter, sent } = makeAdapter()
    await adapter.send({
      topic,
      text: 'See [https://x.com summary](docs:/p/x.md).',
    })
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    expect(sent[0]!.text).toBe(
      `See [https://x\\.com summary](${NEUTRON_SCHEME}://docs/p/x.md)\\.`,
    )
  })

  test('bare URL with NO doc-link trigger keeps plain mode (Telegram auto-link)', async () => {
    // No docs:/ marker, no doc_refs → MarkdownV2 mode NOT triggered →
    // the bare URL ships verbatim and Telegram's native auto-linkifier
    // handles it. This is the pre-P7.3 behaviour we deliberately
    // preserve so 99% of agent messages don't pay the escape cost.
    const { adapter, sent } = makeAdapter()
    await adapter.send({ topic, text: 'See https://anthropic.com for docs.' })
    expect(sent[0]!.parse_mode).toBeUndefined()
    expect(sent[0]!.text).toBe('See https://anthropic.com for docs.')
  })

  test('bare URL alongside doc_refs trailing block is wrapped in body', async () => {
    const { adapter, sent } = makeAdapter()
    await adapter.send({
      topic,
      text: 'Background: https://example.com tells the story.',
      adapter_options: {
        doc_refs: [{ project_id: 'p', path: 'x.md', label: 'Plan' }],
      },
    })
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    expect(sent[0]!.text).toBe(
      'Background: [https://example\\.com](https://example.com) tells the story\\.\n\n' +
        'Linked docs:\n' +
        `• [Plan](${NEUTRON_SCHEME}://docs/p/x.md)`,
    )
  })

  test('http (non-tls) URL is wrapped the same way as https', async () => {
    const { adapter, sent } = makeAdapter()
    await adapter.send({
      topic,
      text: 'Legacy: http://old.example.com OK. [plan](docs:/p/x.md)',
    })
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    expect(sent[0]!.text).toBe(
      'Legacy: [http://old\\.example\\.com](http://old.example.com) OK\\. ' +
        `[plan](${NEUTRON_SCHEME}://docs/p/x.md)`,
    )
  })

  test('URL with trailing comma in a list — comma kept outside the link', async () => {
    const { adapter, sent } = makeAdapter()
    await adapter.send({
      topic,
      text: 'Refs: https://a.com, then https://b.com. [plan](docs:/p/x.md)',
    })
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    expect(sent[0]!.text).toBe(
      'Refs: [https://a\\.com](https://a.com), then ' +
        '[https://b\\.com](https://b.com)\\. ' +
        `[plan](${NEUTRON_SCHEME}://docs/p/x.md)`,
    )
  })

  test('substring-of-word http is not detected (word boundary)', async () => {
    // `xhttps://x.com` is not a URL — the regex requires a word
    // boundary before `http`. The body has no detectable bare URL and
    // the docs:/ marker still triggers MarkdownV2 (escape the rest).
    const { adapter, sent } = makeAdapter()
    await adapter.send({
      topic,
      text: 'note: xhttps://x.com is invalid. [plan](docs:/p/x.md)',
    })
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    // The text inside `xhttps://x.com` ships as escaped prose (no link
    // wrapper around it).
    expect(sent[0]!.text).toBe(
      'note: xhttps://x\\.com is invalid\\. ' +
        `[plan](${NEUTRON_SCHEME}://docs/p/x.md)`,
    )
  })
})
