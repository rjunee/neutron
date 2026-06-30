import { describe, expect, it } from 'bun:test'

import { NEUTRON_SCHEME, VAULT_REDIRECTOR_BASE, WEB_APP_BASE } from '@neutronai/runtime'
import type { IncomingEvent, OutgoingMessage, Topic } from '../../../types.ts'
import { AppWsAdapter, optionsToInlineChoices } from '../adapter.ts'
import { InMemoryAppWsSessionRegistry } from '../session-registry.ts'
import {
  appWsTopicId,
  parseAppWsTopicId,
  decodeAppWsInbound,
  sanitizePlatform,
  sanitizeProjectId,
  MAX_PROJECT_ID_LEN,
  type AppWsOutbound,
} from '../envelope.ts'

const FROZEN_NOW = 1_700_000_000_000

function setup() {
  const registry = new InMemoryAppWsSessionRegistry()
  let receivedEvents: IncomingEvent[] = []
  let messageIdCounter = 0
  const adapter = new AppWsAdapter({
    registry,
    receiver: { receive: async (e) => { receivedEvents.push(e) } },
    now: () => FROZEN_NOW,
    generate_message_id: () => `msg-${++messageIdCounter}`,
  })
  return { adapter, registry, receivedEvents: () => receivedEvents, reset: () => { receivedEvents = [] } }
}

const topic: Topic = {
  topic_id: 'topic-abc',
  channel_kind: 'app_socket',
  channel_topic_id: 'app:sam',
  project_id: null,
  privacy_mode: 'regular',
}

describe('AppWsAdapter — manifest', () => {
  it('declares the app_socket channel kind', () => {
    const { adapter } = setup()
    expect(adapter.manifest.kind).toBe('app_socket')
    expect(adapter.manifest.supports_inline_choices).toBe(true)
  })
})

describe('AppWsAdapter.send — outgoing → envelope', () => {
  it('routes a text-only message to the registered socket', async () => {
    const { adapter, registry } = setup()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    const msg: OutgoingMessage = { topic, text: 'Hello, **world**!' }
    const id = await adapter.send(msg)
    expect(id).toBe('app-ws:msg-1')
    expect(captured.length).toBe(1)
    expect(captured[0]).toMatchObject({
      v: 1,
      type: 'agent_message',
      body: 'Hello, **world**!',
      message_id: 'msg-1',
      ts: FROZEN_NOW,
    })
  })

  it('returns a dropped-marker when no socket is registered', async () => {
    const { adapter } = setup()
    const msg: OutgoingMessage = { topic, text: 'goes nowhere' }
    const id = await adapter.send(msg)
    expect(id.startsWith('app-ws:dropped:')).toBe(true)
  })

  it('renders inline_choices as options', async () => {
    const { adapter, registry } = setup()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    const msg: OutgoingMessage = {
      topic,
      text: 'Pick one',
      inline_choices: [
        { label: 'Yes', callback_data: 'yes' },
        { label: 'No', callback_data: 'no' },
      ],
    }
    await adapter.send(msg)
    const env = captured[0]
    if (env === undefined || env.type !== 'agent_message') throw new Error('expected agent_message')
    expect(env.options).toEqual([
      { label: 'Yes', body: 'Yes', value: 'yes' },
      { label: 'No', body: 'No', value: 'no' },
    ])
    expect(env.allow_freeform).toBe(false)
  })

  it('optionsToInlineChoices → adapter render preserves the human option text (Codex P2)', async () => {
    // Regression: onboarding option buttons carry a letter legend in `label`
    // ("A"/"B") and the human text in `body`. The producer helper must put the
    // HUMAN text into InlineChoice.label so the live-rendered option `body`
    // (which the client paints) shows "Marcus Aurelius", not "A".
    const choices = optionsToInlineChoices([
      { label: 'A', body: 'Marcus Aurelius', value: 'Marcus Aurelius' },
      { label: 'B', body: 'Hermione Granger', value: 'Hermione Granger' },
    ])
    expect(choices).toEqual([
      { label: 'Marcus Aurelius', callback_data: 'Marcus Aurelius' },
      { label: 'Hermione Granger', callback_data: 'Hermione Granger' },
    ])
    const { adapter, registry } = setup()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    await adapter.send({ topic, text: 'Whose voice should I take on?', inline_choices: choices })
    const env = captured[0]
    if (env === undefined || env.type !== 'agent_message') throw new Error('expected agent_message')
    // The client renders option.body — it must be the human text, not "A"/"B".
    expect(env.options?.map((o) => o.body)).toEqual(['Marcus Aurelius', 'Hermione Granger'])
    expect(env.options?.map((o) => o.value)).toEqual(['Marcus Aurelius', 'Hermione Granger'])
  })

  it('optionsToInlineChoices falls back to the legend label when body is empty', () => {
    expect(optionsToInlineChoices([{ label: 'A', body: '', value: 'x' }])).toEqual([
      { label: 'A', callback_data: 'x' },
    ])
    expect(optionsToInlineChoices([{ label: 'A', value: 'x' }])).toEqual([
      { label: 'A', callback_data: 'x' },
    ])
  })

  it('honours adapter_options pass-through: prompt_id, citations, image_urls', async () => {
    const { adapter, registry } = setup()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    const msg: OutgoingMessage = {
      topic,
      text: 'cited body',
      adapter_options: {
        prompt_id: 'p-1',
        citations: [{ title: 'Wiki', url: 'https://en.wikipedia.org' }],
        image_urls: ['https://cdn.example/a.png'],
        kind: 'image-gallery',
        allow_freeform: true,
      },
    }
    await adapter.send(msg)
    const env = captured[0]
    if (env === undefined || env.type !== 'agent_message') throw new Error('expected agent_message')
    expect(env.prompt_id).toBe('p-1')
    expect(env.citations).toEqual([{ title: 'Wiki', url: 'https://en.wikipedia.org' }])
    expect(env.image_urls).toEqual(['https://cdn.example/a.png'])
    expect(env.kind).toBe('image-gallery')
    expect(env.allow_freeform).toBe(true)
  })

  it('honours a valid upload_affordance source (M2 chat-upload UX)', async () => {
    const { adapter, registry } = setup()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    const msg: OutgoingMessage = {
      topic,
      text: 'Drag your ChatGPT export ZIP.',
      adapter_options: { upload_affordance: { source: 'chatgpt' } },
    }
    await adapter.send(msg)
    const env = captured[0]
    if (env === undefined || env.type !== 'agent_message') throw new Error('expected agent_message')
    expect(env.upload_affordance).toEqual({ source: 'chatgpt' })
  })

  // remove-both-import-option (2026-06-06, Codex r1) — a prompt persisted by
  // the removed two-upload 'both' flow carries `{source:'both'}`; on a
  // post-deploy reconnect it is replayed verbatim. The sanitizer must
  // NORMALIZE legacy 'both' to 'chatgpt' (not drop it), else the Expo client
  // hides the upload bar while the body still asks for a ZIP — a
  // deploy-window dead-end.
  it("normalizes a legacy 'both' upload_affordance to chatgpt (deploy-window replay)", async () => {
    const { adapter, registry } = setup()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    const msg: OutgoingMessage = {
      topic,
      text: 'Drag your export ZIP.',
      adapter_options: { upload_affordance: { source: 'both' } },
    }
    await adapter.send(msg)
    const env = captured[0]
    if (env === undefined || env.type !== 'agent_message') throw new Error('expected agent_message')
    expect(env.upload_affordance).toEqual({ source: 'chatgpt' })
  })

  it('drops an unrecognised upload_affordance source', async () => {
    const { adapter, registry } = setup()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    const msg: OutgoingMessage = {
      topic,
      text: 'body',
      adapter_options: { upload_affordance: { source: 'gemini' } },
    }
    await adapter.send(msg)
    const env = captured[0]
    if (env === undefined || env.type !== 'agent_message') throw new Error('expected agent_message')
    expect(env.upload_affordance).toBeUndefined()
  })

  it('threads project_id from adapter_options onto the outbound envelope (P5.2)', async () => {
    const { adapter, registry } = setup()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    const msg: OutgoingMessage = {
      topic,
      text: 'agent reply in acme',
      adapter_options: { project_id: 'acme' },
    }
    await adapter.send(msg)
    const env = captured[0]
    if (env === undefined || env.type !== 'agent_message') throw new Error('expected agent_message')
    expect(env.project_id).toBe('acme')
  })

  it('drops malformed project_id from adapter_options (P5.2)', async () => {
    const { adapter, registry } = setup()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    const msg: OutgoingMessage = {
      topic,
      text: 'agent reply',
      adapter_options: { project_id: 'bad / id' },
    }
    await adapter.send(msg)
    const env = captured[0]
    if (env === undefined || env.type !== 'agent_message') throw new Error('expected agent_message')
    expect(env.project_id).toBeUndefined()
  })

  it('rewrites inline docs:/<project_id>/<path> markers in body to neutron:// URLs (P7.3)', async () => {
    const { adapter, registry } = setup()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    const msg: OutgoingMessage = {
      topic,
      text: 'See [the plan](docs:/acme/launch-plan.md) when ready.',
    }
    await adapter.send(msg)
    const env = captured[0]
    if (env === undefined || env.type !== 'agent_message') throw new Error('expected agent_message')
    expect(env.body).toBe(
      `See [the plan](${NEUTRON_SCHEME}://docs/acme/launch-plan.md) when ready.`,
    )
  })

  it('passes a body with no docs:/ markers through unchanged (P7.3)', async () => {
    const { adapter, registry } = setup()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    await adapter.send({ topic, text: 'just text, no refs' })
    const env = captured[0]
    if (env === undefined || env.type !== 'agent_message') throw new Error('expected agent_message')
    expect(env.body).toBe('just text, no refs')
  })

  it('resolves adapter_options.doc_refs into envelope.doc_refs as neutron:// URLs (P7.3)', async () => {
    const { adapter, registry } = setup()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    const msg: OutgoingMessage = {
      topic,
      text: 'plain body',
      adapter_options: {
        doc_refs: [
          { label: 'Launch plan', project_id: 'acme', path: 'launch-plan.md' },
          { project_id: 'beacon', path: 'sub/file.md' },
        ],
      },
    }
    await adapter.send(msg)
    const env = captured[0]
    if (env === undefined || env.type !== 'agent_message') throw new Error('expected agent_message')
    expect(env.doc_refs).toEqual([
      {
        label: 'Launch plan',
        url: `${NEUTRON_SCHEME}://docs/acme/launch-plan.md`,
        project_id: 'acme',
        path: 'launch-plan.md',
      },
      {
        label: 'file',
        url: `${NEUTRON_SCHEME}://docs/beacon/sub/file.md`,
        project_id: 'beacon',
        path: 'sub/file.md',
      },
    ])
  })

  it('drops malformed doc_refs entries without poisoning the rest (P7.3)', async () => {
    const { adapter, registry } = setup()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    const msg: OutgoingMessage = {
      topic,
      text: 'plain body',
      adapter_options: {
        doc_refs: [
          { project_id: 'acme', path: 'good.md' },
          { project_id: 'bad id', path: 'oops.md' },
          { project_id: 'acme' /* no path */ },
          null,
          'string',
        ],
      },
    }
    await adapter.send(msg)
    const env = captured[0]
    if (env === undefined || env.type !== 'agent_message') throw new Error('expected agent_message')
    expect(env.doc_refs).toEqual([
      {
        label: 'good',
        url: `${NEUTRON_SCHEME}://docs/acme/good.md`,
        project_id: 'acme',
        path: 'good.md',
      },
    ])
  })

  it('vault-legacy doc_ref (project_id null) resolves to vault.example.test URL (P7.3)', async () => {
    const { adapter, registry } = setup()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    const msg: OutgoingMessage = {
      topic,
      text: 'plain body',
      adapter_options: {
        doc_refs: [{ project_id: null, path: 'Projects/neutron/STATUS.md' }],
      },
    }
    await adapter.send(msg)
    const env = captured[0]
    if (env === undefined || env.type !== 'agent_message') throw new Error('expected agent_message')
    expect(env.doc_refs).toEqual([
      {
        label: 'STATUS',
        url: `${VAULT_REDIRECTOR_BASE}/Projects/neutron/STATUS.md`,
        project_id: null,
        path: 'Projects/neutron/STATUS.md',
      },
    ])
  })

  it('omits doc_refs from envelope when input array is empty (P7.3)', async () => {
    const { adapter, registry } = setup()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    await adapter.send({
      topic,
      text: 'plain body',
      adapter_options: { doc_refs: [] },
    })
    const env = captured[0]
    if (env === undefined || env.type !== 'agent_message') throw new Error('expected agent_message')
    expect(env.doc_refs).toBeUndefined()
  })

  describe('Argus BLOCKING #2 — platform-aware doc-link channel', () => {
    it('renders inline docs:/ markers as neutron:// URLs for native clients', async () => {
      const { adapter, registry } = setup()
      const captured: AppWsOutbound[] = []
      registry.register('app:sam', (e) => captured.push(e), { platform: 'native' })
      await adapter.send({
        topic,
        text: 'See [plan](docs:/acme/p.md).',
      })
      const env = captured[0]
      if (env === undefined || env.type !== 'agent_message') throw new Error('expected agent_message')
      expect(env.body).toBe(`See [plan](${NEUTRON_SCHEME}://docs/acme/p.md).`)
    })

    it('renders inline docs:/ markers as https web URLs for web clients', async () => {
      // Web build runs `Linking.openURL` → `window.open`, which can't
      // dispatch `neutron://`. Web clients MUST get the web fallback.
      // Argus r4 BLOCKING #1: web shape targets the existing Expo
      // route at `app/app/projects/[id]/docs.tsx`.
      const { adapter, registry } = setup()
      const captured: AppWsOutbound[] = []
      registry.register('app:sam', (e) => captured.push(e), { platform: 'web' })
      await adapter.send({
        topic,
        text: 'See [plan](docs:/acme/p.md).',
      })
      const env = captured[0]
      if (env === undefined || env.type !== 'agent_message') throw new Error('expected agent_message')
      expect(env.body).toBe(
        `See [plan](${WEB_APP_BASE}/projects/acme/docs?path=p.md).`,
      )
    })

    it('resolves doc_refs against the web channel for web clients', async () => {
      const { adapter, registry } = setup()
      const captured: AppWsOutbound[] = []
      registry.register('app:sam', (e) => captured.push(e), { platform: 'web' })
      await adapter.send({
        topic,
        text: 'refs',
        adapter_options: {
          doc_refs: [
            { project_id: 'acme', path: 'p.md' },
            { project_id: null, path: 'Projects/neutron/STATUS.md' },
          ],
        },
      })
      const env = captured[0]
      if (env === undefined || env.type !== 'agent_message') throw new Error('expected agent_message')
      expect(env.doc_refs).toEqual([
        {
          label: 'p',
          url: `${WEB_APP_BASE}/projects/acme/docs?path=p.md`,
          project_id: 'acme',
          path: 'p.md',
        },
        {
          // Vault-legacy fallback is uniform across all channels.
          label: 'STATUS',
          url: `${VAULT_REDIRECTOR_BASE}/Projects/neutron/STATUS.md`,
          project_id: null,
          path: 'Projects/neutron/STATUS.md',
        },
      ])
    })

    it('defaults to native (neutron://) when the session has no registered platform', async () => {
      // Back-compat with P5.1 clients that don't send `platform` on
      // the upgrade query string — keep native behaviour so an old
      // Expo iOS/Android build doesn't suddenly receive https URLs
      // that won't trigger its deep-link handler.
      const { adapter, registry } = setup()
      const captured: AppWsOutbound[] = []
      registry.register('app:sam', (e) => captured.push(e))
      await adapter.send({
        topic,
        text: 'See [plan](docs:/acme/p.md).',
      })
      const env = captured[0]
      if (env === undefined || env.type !== 'agent_message') throw new Error('expected agent_message')
      expect(env.body).toBe(`See [plan](${NEUTRON_SCHEME}://docs/acme/p.md).`)
    })
  })
})

describe('AppWsAdapter.dispatchInbound — incoming → receiver', () => {
  it('normalises into an IncomingEvent and pushes to the receiver', async () => {
    const { adapter, receivedEvents } = setup()
    await adapter.dispatchInbound({
      user_id: 'sam',
      channel_topic_id: 'app:sam',
      body: 'hi there',
    })
    const evs = receivedEvents()
    expect(evs.length).toBe(1)
    expect(evs[0]).toMatchObject({
      channel_kind: 'app_socket',
      channel_topic_id: 'app:sam',
      body: { text: 'hi there' },
    })
    expect(evs[0]?.user.channel_user_id).toBe('sam')
    // No project_id supplied → no adapter_metadata.
    expect(evs[0]?.adapter_metadata).toBeUndefined()
  })

  it('stashes project_id on adapter_metadata when present (P5.2)', async () => {
    const { adapter, receivedEvents } = setup()
    await adapter.dispatchInbound({
      user_id: 'sam',
      channel_topic_id: 'app:sam',
      body: 'in project',
      project_id: 'acme',
    })
    const evs = receivedEvents()
    expect(evs[0]?.adapter_metadata).toEqual({ project_id: 'acme' })
  })
})

describe('AppWsAdapter.emitUserMessageEcho', () => {
  it('writes the locked user-message echo envelope', () => {
    const { adapter, registry } = setup()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    const id = adapter.emitUserMessageEcho({
      channel_topic_id: 'app:sam',
      user_id: 'sam',
      body: 'echo me',
      client_msg_id: 'c-1',
    })
    expect(id).toBe('msg-1')
    expect(captured[0]).toEqual({
      v: 1,
      type: 'user_message',
      user_id: 'sam',
      body: 'echo me',
      message_id: 'msg-1',
      ts: FROZEN_NOW,
      client_msg_id: 'c-1',
    })
  })

  it('echoes project_id when set (P5.2)', () => {
    const { adapter, registry } = setup()
    const captured: AppWsOutbound[] = []
    registry.register('app:sam', (e) => captured.push(e))
    adapter.emitUserMessageEcho({
      channel_topic_id: 'app:sam',
      user_id: 'sam',
      body: 'in project',
      project_id: 'acme',
    })
    if (captured[0]?.type !== 'user_message') throw new Error('expected echo')
    expect(captured[0]?.project_id).toBe('acme')
  })

  it('silently drops when no socket is registered', () => {
    const { adapter } = setup()
    expect(() =>
      adapter.emitUserMessageEcho({
        channel_topic_id: 'app:nobody',
        user_id: 'nobody',
        body: 'no socket',
      }),
    ).not.toThrow()
  })
})

describe('AppWsAdapter — registry identity-aware unregister', () => {
  it('does not delete the entry when a stale send unregisters', () => {
    const registry = new InMemoryAppWsSessionRegistry()
    const sendA = (_e: AppWsOutbound) => undefined
    const sendB = (_e: AppWsOutbound) => undefined
    registry.register('app:sam', sendA)
    registry.register('app:sam', sendB) // reconnect overrides
    registry.unregister('app:sam', sendA) // old socket's close fires
    expect(registry.has('app:sam')).toBe(true)
    registry.unregister('app:sam', sendB)
    expect(registry.has('app:sam')).toBe(false)
  })
})

describe('InMemoryAppWsSessionRegistry — closed-socket downgrade (Codex P2 fix)', () => {
  it('returns false + evicts the entry when the send lambda throws', async () => {
    const { adapter, registry } = setup()
    const throwingSend = (_e: AppWsOutbound) => {
      throw new Error('socket closed')
    }
    registry.register('app:sam', throwingSend)
    expect(registry.has('app:sam')).toBe(true)
    const id = await adapter.send({ topic, text: 'hi' })
    // Adapter.send -> registry.send returns false on throw → adapter
    // returns the dropped marker rather than the success marker.
    expect(id.startsWith('app-ws:dropped:')).toBe(true)
    // The throwing entry was evicted so the next .send returns
    // dropped without invoking the dead lambda again.
    expect(registry.has('app:sam')).toBe(false)
  })
})

describe('envelope helpers', () => {
  it('appWsTopicId / parseAppWsTopicId round-trip', () => {
    expect(appWsTopicId('sam')).toBe('app:sam')
    expect(parseAppWsTopicId('app:sam')).toBe('sam')
    expect(parseAppWsTopicId('telegram:1:2')).toBe(null)
  })

  it('decodeAppWsInbound rejects malformed shapes', () => {
    expect(decodeAppWsInbound({ v: 1, type: 'user_message', body: 'hi' })).toMatchObject({
      v: 1,
      type: 'user_message',
      body: 'hi',
    })
    expect(decodeAppWsInbound({ v: 2, type: 'user_message', body: 'hi' })).toBeNull()
    expect(decodeAppWsInbound({ v: 1, type: 'agent_message', body: 'hi' })).toBeNull()
    expect(decodeAppWsInbound({ v: 1, type: 'user_message', body: '' })).toBeNull()
    expect(decodeAppWsInbound('not-an-object')).toBeNull()
    expect(decodeAppWsInbound(null)).toBeNull()
  })

  it('decodeAppWsInbound carries project_id through when valid (P5.2)', () => {
    expect(
      decodeAppWsInbound({
        v: 1,
        type: 'user_message',
        body: 'hi',
        project_id: 'acme',
      }),
    ).toEqual({ v: 1, type: 'user_message', body: 'hi', project_id: 'acme' })
  })

  it('decodeAppWsInbound drops malformed project_id but keeps the message (P5.2)', () => {
    // Disallowed char class — slashes, spaces, etc. The whole frame
    // remains valid; only the project_id is stripped.
    expect(
      decodeAppWsInbound({ v: 1, type: 'user_message', body: 'hi', project_id: 'bad / id' }),
    ).toEqual({ v: 1, type: 'user_message', body: 'hi' })
    // Wrong type → stripped.
    expect(
      decodeAppWsInbound({ v: 1, type: 'user_message', body: 'hi', project_id: 123 }),
    ).toEqual({ v: 1, type: 'user_message', body: 'hi' })
    // Empty → stripped.
    expect(
      decodeAppWsInbound({ v: 1, type: 'user_message', body: 'hi', project_id: '' }),
    ).toEqual({ v: 1, type: 'user_message', body: 'hi' })
  })

  it('sanitizeProjectId accepts uuid-like + slug forms', () => {
    expect(sanitizeProjectId('acme')).toBe('acme')
    expect(sanitizeProjectId('proj_42')).toBe('proj_42')
    expect(sanitizeProjectId('proj-42')).toBe('proj-42')
    expect(sanitizeProjectId('proj.42')).toBe('proj.42')
    expect(sanitizeProjectId('ABCDEF0123')).toBe('ABCDEF0123')
  })

  it('sanitizePlatform accepts only "web" and "native"', () => {
    expect(sanitizePlatform('web')).toBe('web')
    expect(sanitizePlatform('native')).toBe('native')
    expect(sanitizePlatform('ios')).toBeNull()
    expect(sanitizePlatform('android')).toBeNull()
    expect(sanitizePlatform('')).toBeNull()
    expect(sanitizePlatform(null)).toBeNull()
    expect(sanitizePlatform(undefined)).toBeNull()
    expect(sanitizePlatform(123)).toBeNull()
  })

  it('sanitizeProjectId rejects everything else', () => {
    expect(sanitizeProjectId('')).toBeNull()
    expect(sanitizeProjectId('a/b')).toBeNull()
    expect(sanitizeProjectId('a b')).toBeNull()
    expect(sanitizeProjectId("a'b")).toBeNull()
    expect(sanitizeProjectId('a' + '\n')).toBeNull()
    expect(sanitizeProjectId('a'.repeat(MAX_PROJECT_ID_LEN + 1))).toBeNull()
    expect(sanitizeProjectId(123)).toBeNull()
    expect(sanitizeProjectId(null)).toBeNull()
    expect(sanitizeProjectId(undefined)).toBeNull()
  })
})
