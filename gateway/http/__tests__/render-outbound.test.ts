/**
 * D3 (2026-07) — relocated from the dissolved `chat-bridge.test.ts` to sit
 * with its module `gateway/http/render-outbound.ts` (the web button-prompt
 * renderer split out of the chat-bridge cluster).
 */

import { describe, expect, test } from 'bun:test'
import { renderButtonPromptForWeb } from '../render-outbound.ts'
import type { ButtonPrompt } from '@neutronai/channels/button-primitive.ts'

describe('renderButtonPromptForWeb', () => {
  test('maps ButtonPrompt → ChatOutbound preserving options', () => {
    const prompt: ButtonPrompt = {
      prompt_id: '00000000-0000-4000-8000-000000000001',
      body: 'Pick one',
      options: [
        { label: 'A', body: 'Continue', value: 'continue' },
        { label: 'B', body: 'Skip', value: 'skip' },
      ],
      allow_freeform: true,
    }
    const out = renderButtonPromptForWeb(prompt)
    if (out.type !== 'agent_message') throw new Error(`expected agent_message; got ${out.type}`)
    expect(out.body).toBe('Pick one')
    expect(out.prompt_id).toBe('00000000-0000-4000-8000-000000000001')
    expect(out.options).toEqual([
      { label: 'A', body: 'Continue', value: 'continue' },
      { label: 'B', body: 'Skip', value: 'skip' },
    ])
    expect(out.allow_freeform).toBe(true)
    // Legacy plain-button prompts MUST omit the kind on the wire so
    // existing web clients keep rendering the keyboard unchanged.
    expect(out.kind).toBeUndefined()
  })

  test('Sprint 28 — propagates kind + per-option image_url for image-gallery (Codex r4 P1)', () => {
    const prompt: ButtonPrompt = {
      prompt_id: '00000000-0000-4000-8000-000000000002',
      body: "Pick your agent's portrait.",
      options: [
        { label: 'A', body: 'Portrait 1', value: 'cand-A', image_url: '/profile-pic/candidate/cand-A.png' },
        { label: 'B', body: 'Skip portrait', value: 'skip-portrait' },
      ],
      allow_freeform: false,
      kind: 'image-gallery',
    }
    const out = renderButtonPromptForWeb(prompt)
    if (out.type !== 'agent_message') throw new Error(`expected agent_message; got ${out.type}`)
    expect(out.kind).toBe('image-gallery')
    const opts = out.options ?? []
    expect(opts[0]?.image_url).toBe('/profile-pic/candidate/cand-A.png')
    expect(opts[1]?.image_url).toBeUndefined()
  })

  // P2 v2 § 6.2 (S4) — a valid single-source upload affordance is
  // propagated so the web client renders the upload bar.
  test('propagates a valid chatgpt upload_affordance', () => {
    const prompt: ButtonPrompt = {
      prompt_id: '00000000-0000-4000-8000-000000000003',
      body: 'Drag your ChatGPT export ZIP.',
      options: [{ label: 'A', body: 'Skip the import', value: 'skip' }],
      allow_freeform: true,
      metadata: { upload_affordance: { source: 'chatgpt' } },
    }
    const out = renderButtonPromptForWeb(prompt)
    if (out.type !== 'agent_message') throw new Error('expected agent_message')
    expect(out.upload_affordance).toEqual({ source: 'chatgpt' })
  })

  // remove-both-import-option (2026-06-06, Codex r1) — a stored prompt
  // EMITTED before this deploy in the removed two-upload 'both' flow
  // persisted `{source:'both'}`. On a post-deploy reconnect the gateway
  // REPLAYS that envelope verbatim. The narrowed render must NOT drop the
  // affordance (hiding the upload bar while the body asks for a ZIP = a
  // deploy-window dead-end) — it NORMALIZES legacy 'both' to 'chatgpt'
  // (the same single-source fallback the rebuild path uses).
  test("normalizes a legacy 'both' upload_affordance to chatgpt (deploy-window replay)", () => {
    const prompt: ButtonPrompt = {
      prompt_id: '00000000-0000-4000-8000-000000000004',
      body: 'Drag your export ZIP.',
      options: [{ label: 'A', body: 'Skip the import', value: 'skip' }],
      allow_freeform: true,
      metadata: { upload_affordance: { source: 'both' } },
    }
    const out = renderButtonPromptForWeb(prompt)
    if (out.type !== 'agent_message') throw new Error('expected agent_message')
    // Affordance preserved (NOT dropped) and normalized to a valid source.
    expect(out.upload_affordance).toEqual({ source: 'chatgpt' })
  })

  // P1a — the optional `topic_id` arg stamps the owning topic so the
  // per-topic client drop-guard routes the prompt to ITS topic. Pin both
  // sides of the boundary: omitted → absent; provided → stamped verbatim.
  test('omits topic_id when the arg is not provided', () => {
    const prompt: ButtonPrompt = {
      prompt_id: '00000000-0000-4000-8000-000000000006',
      body: 'Body',
      options: [],
      allow_freeform: true,
    }
    const out = renderButtonPromptForWeb(prompt)
    if (out.type !== 'agent_message') throw new Error('expected agent_message')
    expect(out.topic_id).toBeUndefined()
  })
  test('stamps topic_id verbatim when provided', () => {
    const prompt: ButtonPrompt = {
      prompt_id: '00000000-0000-4000-8000-000000000007',
      body: 'Body',
      options: [],
      allow_freeform: true,
    }
    const out = renderButtonPromptForWeb(prompt, 'web:u-1')
    if (out.type !== 'agent_message') throw new Error('expected agent_message')
    expect(out.topic_id).toBe('web:u-1')
  })

  // Unrecognised / malformed affordance sources are still dropped.
  test('drops an unrecognised upload_affordance source', () => {
    const prompt: ButtonPrompt = {
      prompt_id: '00000000-0000-4000-8000-000000000005',
      body: 'Body',
      options: [],
      allow_freeform: true,
      metadata: { upload_affordance: { source: 'gemini' } },
    }
    const out = renderButtonPromptForWeb(prompt)
    if (out.type !== 'agent_message') throw new Error('expected agent_message')
    expect(out.upload_affordance).toBeUndefined()
  })
})
