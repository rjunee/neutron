/**
 * Telegram adapter — P7.3 doc-ref rendering test suite.
 *
 * Asserts the integration contract:
 *
 *   1. Inline `[label](docs:/<project_id>/<path>)` markers in the
 *      outbound message body are rewritten to channel-appropriate
 *      `neutron://docs/...` URLs before send (sprint roadmap § 5).
 *   2. `adapter_options.doc_refs` are resolved via the runtime helper
 *      and appended as a trailing "Linked docs:" block so Telegram's
 *      auto-linkifier picks them up (Telegram doesn't render
 *      markdown links by default).
 *   3. Malformed entries (bad project_id, missing path) are dropped
 *      from the trailing block without crashing the send path.
 *   4. Vault-legacy `https://vault.example.test/...` URLs in the
 *      body pass through untouched.
 *   5. The combined body still flows through `truncateForTelegram`
 *      so the 4096 UTF-16 cap is honoured end-to-end.
 */

import { describe, expect, test } from 'bun:test'

import type { OutgoingMessage, Topic } from '../../../types.ts'
import { TelegramAdapter } from '../index.ts'
import type { TelegramClient } from '../client.ts'
import {
  NEUTRON_SCHEME,
  VAULT_REDIRECTOR_BASE,
} from '@neutronai/runtime'

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

function makeClient(): {
  client: TelegramClient
  sent: CapturedCall[]
} {
  const sent: CapturedCall[] = []
  const fake: Partial<TelegramClient> = {
    sendMessage: async (payload: CapturedCall) => {
      sent.push(payload)
      return {
        message_id: sent.length,
        chat: { id: 12345, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
      } as Awaited<ReturnType<TelegramClient['sendMessage']>>
    },
    setWebhook: async () => true,
    answerCallbackQuery: async () => true,
  }
  return { client: fake as TelegramClient, sent }
}

function makeAdapter() {
  const { client, sent } = makeClient()
  const adapter = new TelegramAdapter({
    client,
    bot_user_id: 1,
    webhook_secret_token: 'secret',
    receiver: { receive: async () => undefined },
  })
  return { adapter, sent }
}

describe('TelegramAdapter — P7.3 doc-link rewriting', () => {
  test('rewrites inline docs:/ marker in body to neutron:// URL with MarkdownV2', async () => {
    // Argus BLOCKING #1: messages with rewritten doc-links MUST ship
    // with parse_mode='MarkdownV2' so Telegram renders the inline
    // link as tappable (in plain mode `[label](url)` rendered as
    // raw text). Non-link prose around the marker is MarkdownV2-
    // escaped (`.` → `\.`).
    const { adapter, sent } = makeAdapter()
    const msg: OutgoingMessage = {
      topic,
      text: 'See [the launch plan](docs:/acme/launch-plan.md) when ready.',
    }
    await adapter.send(msg)
    expect(sent.length).toBe(1)
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    expect(sent[0]!.text).toBe(
      `See [the launch plan](${NEUTRON_SCHEME}://docs/acme/launch-plan.md) when ready\\.`,
    )
  })

  test('rewrites multiple markers in the same body', async () => {
    const { adapter, sent } = makeAdapter()
    const msg: OutgoingMessage = {
      topic,
      text:
        'Look at [A](docs:/proj-a/file-a.md) and also [B](docs:/proj-b/file-b.md).',
    }
    await adapter.send(msg)
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    expect(sent[0]!.text).toBe(
      `Look at [A](${NEUTRON_SCHEME}://docs/proj-a/file-a.md) and also ` +
        `[B](${NEUTRON_SCHEME}://docs/proj-b/file-b.md)\\.`,
    )
  })

  test('passes plain prose without markers through unchanged (no parse_mode)', async () => {
    const { adapter, sent } = makeAdapter()
    const msg: OutgoingMessage = { topic, text: 'just a status update.' }
    await adapter.send(msg)
    expect(sent[0]!.text).toBe('just a status update.')
    // No doc refs → ship as plain text so non-doc-link send paths
    // don't need MarkdownV2 escaping for arbitrary prose.
    expect(sent[0]!.parse_mode).toBeUndefined()
  })

  test('passes vault-legacy vault.example.test URLs through untouched when no docs:/ marker', async () => {
    const { adapter, sent } = makeAdapter()
    const body = `Cross-ref ${VAULT_REDIRECTOR_BASE}/Projects/neutron/STATUS.md please.`
    await adapter.send({ topic, text: body })
    expect(sent[0]!.text).toBe(body)
    expect(sent[0]!.parse_mode).toBeUndefined()
  })

  test('escapes MarkdownV2 special chars in body prose around inline link', async () => {
    // `(`, `)`, `.`, `-`, `!` all require backslash-escape per Telegram
    // MarkdownV2. Colon is NOT in the special-char set so it ships raw.
    const { adapter, sent } = makeAdapter()
    const msg: OutgoingMessage = {
      topic,
      text: 'Note (1): see [plan](docs:/acme/p.md) - done!',
    }
    await adapter.send(msg)
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    expect(sent[0]!.text).toBe(
      `Note \\(1\\): see [plan](${NEUTRON_SCHEME}://docs/acme/p.md) \\- done\\!`,
    )
  })
})

describe('TelegramAdapter — P7.3 doc_refs trailing block', () => {
  test('appends a Linked docs: block as MarkdownV2 inline links when adapter_options.doc_refs present', async () => {
    // Argus BLOCKING #1: the trailing block now renders each ref as
    // `[label](url)` so the link is tappable in MarkdownV2 mode.
    const { adapter, sent } = makeAdapter()
    const msg: OutgoingMessage = {
      topic,
      text: 'Per the latest plan, here are the key references.',
      adapter_options: {
        doc_refs: [
          { label: 'Launch plan', project_id: 'acme', path: 'launch-plan.md' },
          { project_id: 'beacon', path: 'metrics/dashboard.md' },
        ],
      },
    }
    await adapter.send(msg)
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    expect(sent[0]!.text).toBe(
      'Per the latest plan, here are the key references\\.\n\n' +
        'Linked docs:\n' +
        `• [Launch plan](${NEUTRON_SCHEME}://docs/acme/launch-plan.md)\n` +
        `• [dashboard](${NEUTRON_SCHEME}://docs/beacon/metrics/dashboard.md)`,
    )
  })

  test('vault-legacy doc_ref (project_id null) renders the vault.example.test URL', async () => {
    const { adapter, sent } = makeAdapter()
    const msg: OutgoingMessage = {
      topic,
      text: 'Quick context check.',
      adapter_options: {
        doc_refs: [{ project_id: null, path: 'Projects/neutron/STATUS.md' }],
      },
    }
    await adapter.send(msg)
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    expect(sent[0]!.text).toBe(
      'Quick context check\\.\n\n' +
        'Linked docs:\n' +
        `• [STATUS](${VAULT_REDIRECTOR_BASE}/Projects/neutron/STATUS.md)`,
    )
  })

  test('malformed doc_refs entries are dropped silently — healthy ones survive', async () => {
    const { adapter, sent } = makeAdapter()
    const msg: OutgoingMessage = {
      topic,
      text: 'Mixed refs.',
      adapter_options: {
        doc_refs: [
          { project_id: 'acme', path: 'good.md' },
          { project_id: 'bad id', path: 'oops.md' }, // bad project_id
          { project_id: 'acme' }, // missing path
          null,
          'not-an-object',
        ],
      },
    }
    await adapter.send(msg)
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    expect(sent[0]!.text).toBe(
      'Mixed refs\\.\n\n' +
        'Linked docs:\n' +
        `• [good](${NEUTRON_SCHEME}://docs/acme/good.md)`,
    )
  })

  test('empty / non-array doc_refs is a no-op (no parse_mode)', async () => {
    const { adapter, sent } = makeAdapter()
    const msg: OutgoingMessage = {
      topic,
      text: 'no refs.',
      adapter_options: { doc_refs: [] },
    }
    await adapter.send(msg)
    expect(sent[0]!.text).toBe('no refs.')
    expect(sent[0]!.parse_mode).toBeUndefined()

    sent.length = 0
    await adapter.send({
      topic,
      text: 'no refs either.',
      adapter_options: { doc_refs: 'not-an-array' as unknown as DocRefArray },
    })
    expect(sent[0]!.text).toBe('no refs either.')
    expect(sent[0]!.parse_mode).toBeUndefined()
  })

  test('inline marker + doc_refs trailing block render together', async () => {
    const { adapter, sent } = makeAdapter()
    const msg: OutgoingMessage = {
      topic,
      text: 'See [overview](docs:/acme/overview.md).',
      adapter_options: {
        doc_refs: [
          { label: 'Background', project_id: 'acme', path: 'background.md' },
        ],
      },
    }
    await adapter.send(msg)
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    expect(sent[0]!.text).toBe(
      `See [overview](${NEUTRON_SCHEME}://docs/acme/overview.md)\\.\n\n` +
        'Linked docs:\n' +
        `• [Background](${NEUTRON_SCHEME}://docs/acme/background.md)`,
    )
  })

  test('escapes label content with MarkdownV2 special chars', async () => {
    // Labels with `.` / `(` / `)` need escaping per MarkdownV2 spec.
    const { adapter, sent } = makeAdapter()
    const msg: OutgoingMessage = {
      topic,
      text: 'Refs:',
      adapter_options: {
        doc_refs: [
          { label: 'Plan v2.1 (draft)', project_id: 'acme', path: 'p.md' },
        ],
      },
    }
    await adapter.send(msg)
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    expect(sent[0]!.text).toBe(
      'Refs:\n\n' +
        'Linked docs:\n' +
        `• [Plan v2\\.1 \\(draft\\)](${NEUTRON_SCHEME}://docs/acme/p.md)`,
    )
  })
})

describe('TelegramAdapter — P7.3 Argus MINOR #1 (loose marker parser)', () => {
  test('rewrites a marker whose path contains a literal space', async () => {
    // Pre-fix the regex stopped at the first whitespace and left the
    // marker un-rewritten. Post-fix the walker tolerates spaces; the
    // emitted URL is percent-encoded by buildDocLink.
    const { adapter, sent } = makeAdapter()
    const msg: OutgoingMessage = {
      topic,
      text: 'Pull up [plan](docs:/acme/launch plan.md).',
    }
    await adapter.send(msg)
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    expect(sent[0]!.text).toBe(
      `Pull up [plan](${NEUTRON_SCHEME}://docs/acme/launch%20plan.md)\\.`,
    )
  })

  test('rewrites a marker whose path contains balanced parens', async () => {
    const { adapter, sent } = makeAdapter()
    const msg: OutgoingMessage = {
      topic,
      text: 'Cut [v2](docs:/acme/release/v(2).md) tonight.',
    }
    await adapter.send(msg)
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    // Inside a MarkdownV2 link payload, `)` must be backslash-escaped
    // — only the outer link-closer survives unescaped. `(` is literal.
    expect(sent[0]!.text).toBe(
      `Cut [v2](${NEUTRON_SCHEME}://docs/acme/release/v(2\\).md) tonight\\.`,
    )
  })
})

describe('TelegramAdapter — P7.3 Argus BLOCKING #1 (entity-aware truncation)', () => {
  // The truncation logic ensures a doc-link reply that pushes past
  // the 4096-UTF-16-unit cap doesn't leave the composed body with a
  // dangling `\` (broken escape) or an unbalanced `[`/`(`/`)` — any
  // of which makes Telegram reject the whole sendMessage with
  // "can't parse entities".

  test('long body ending in [label](docs:/...) cuts BEFORE the `[`', async () => {
    // Build a body whose composed (escaped) form exceeds 4096 chars,
    // ending in a fresh inline doc-link marker. After truncation, the
    // dangling `[...]( ... )` must be gone — the cut must land in
    // the safe text prefix.
    const { adapter, sent } = makeAdapter()
    // 5000 chars of `.` which escape to `\.` → 10000 escaped chars,
    // way past the 4096 cap. Append a marker at the end.
    const longPlain = '.'.repeat(5000)
    const msg: OutgoingMessage = {
      topic,
      text: `${longPlain}[plan](docs:/acme/launch.md)`,
    }
    await adapter.send(msg)
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    expect(sent[0]!.text.length).toBeLessThanOrEqual(4096)
    // The cut should never leave a dangling `[` opener — every `[`
    // in the truncated body must be paired with a `]( ... )` closer.
    // Easiest invariant to assert: the truncated body contains no
    // `[` at all (the link was wholly past the cut).
    expect(sent[0]!.text).not.toContain('[')
    expect(sent[0]!.text).not.toContain('](')
    // Must end with the truncation ellipsis (not a dangling `\`).
    expect(sent[0]!.text.endsWith('…')).toBe(true)
    // No trailing backslash before the ellipsis.
    expect(sent[0]!.text.endsWith('\\…')).toBe(false)
  })

  test('cut landing inside a link URL rewinds before the `[`', async () => {
    // Construct a body where a single very long link straddles the
    // 4096-char boundary: the `[` opens before the cut and the `)`
    // closer sits past it. After truncation the link must be excised
    // entirely so we don't ship `[label](https://incomp` to Telegram.
    const { adapter, sent } = makeAdapter()
    const prefix = '.'.repeat(2040) // 2040 plain dots → 4080 escaped
    const longLabel = 'L'.repeat(50) // pushes the link well past 4096
    const msg: OutgoingMessage = {
      topic,
      text: `${prefix}[${longLabel}](docs:/acme/launch.md)`,
    }
    await adapter.send(msg)
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    expect(sent[0]!.text.length).toBeLessThanOrEqual(4096)
    expect(sent[0]!.text).not.toContain('[')
    expect(sent[0]!.text).not.toContain('](')
    expect(sent[0]!.text.endsWith('…')).toBe(true)
  })

  test('cut never lands right after a `\\` (no dangling escape)', async () => {
    // The escape inflation factor for `.` is 2 (`\.`). 3000 dots →
    // 6000 escaped chars; the naive cut at 4095 lands BETWEEN a `\`
    // and its escaped char, producing `escaped\` at the end which
    // Telegram refuses as a broken entity. The entity-aware truncator
    // must rewind to leave a complete `\X` pair before the ellipsis.
    const { adapter, sent } = makeAdapter()
    const msg: OutgoingMessage = { topic, text: '.'.repeat(3000) + '[L](docs:/p/x.md)' }
    await adapter.send(msg)
    expect(sent[0]!.parse_mode).toBe('MarkdownV2')
    expect(sent[0]!.text.length).toBeLessThanOrEqual(4096)
    // Strip the trailing ellipsis and assert no dangling `\`.
    const head = sent[0]!.text.replace(/…$/, '')
    expect(head.endsWith('\\')).toBe(false)
    // Every `\` in the truncated body should be followed by a
    // MarkdownV2 special char (the escape arg). The simplest way to
    // assert this: the body must NOT contain a `\` as the last char
    // before the ellipsis.
    expect(sent[0]!.text.endsWith('\\…')).toBe(false)
  })
})

// Local placeholder type for the malformed-doc_refs test.
type DocRefArray = ReadonlyArray<unknown>
