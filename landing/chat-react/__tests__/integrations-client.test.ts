/**
 * Unit tests for the web INTEGRATIONS API client (admin / OAuth + API keys).
 * Pure — the `fetchImpl` is injected, so no DOM and no live server.
 *
 * Covers: getStatus (GET shape + bearer header + parsed oauth/api_keys),
 * setApiKey (POST body + label encoding), deleteApiKey (DELETE), and the typed
 * IntegrationsClientError for 400 unknown_label / empty_value + network errors.
 */

import { describe, expect, it } from 'bun:test'

import {
  IntegrationsClient,
  IntegrationsClientError,
} from '../integrations-client.ts'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const STATUS_BODY = {
  ok: true,
  oauth: [
    {
      kind: 'oauth',
      label: 'google:gmail',
      connected: true,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      email: 'sam@example.com',
      connected_at: 1700000000,
      last_refresh_at: null,
      last_refresh_outcome: 'ok',
      expires_at: null,
      scope: 'gmail.readonly',
      core_slugs: ['gmail-core'],
    },
  ],
  api_keys: [
    {
      kind: 'api_key',
      label: 'openai',
      name: 'OpenAI API Key',
      core_slugs: ['llm-core'],
      required: true,
      install_prompt: 'Paste your OpenAI key.',
      connected: false,
    },
  ],
}

describe('IntegrationsClient.getStatus', () => {
  it('GETs /api/cores/integrations with a bearer header and returns oauth + api_keys', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const client = new IntegrationsClient({
      base_url: 'https://h/',
      token: 'dev:sam',
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return json(STATUS_BODY)
      },
    })
    const res = await client.getStatus()
    expect(calls[0]!.url).toBe('https://h/api/cores/integrations')
    expect(calls[0]!.init?.method ?? 'GET').toBe('GET')
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe('Bearer dev:sam')
    expect(res.oauth).toHaveLength(1)
    expect(res.oauth[0]!.email).toBe('sam@example.com')
    expect(res.oauth[0]!.connected).toBe(true)
    expect(res.api_keys[0]!.label).toBe('openai')
    expect(res.api_keys[0]!.required).toBe(true)
    expect(res.api_keys[0]!.connected).toBe(false)
  })
})

describe('IntegrationsClient.setApiKey', () => {
  it('POSTs the value to /api/cores/api-keys/<label> and returns connected:true', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const client = new IntegrationsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return json({ ok: true, label: 'openai', connected: true })
      },
    })
    const res = await client.setApiKey('openai', 'sk-secret')
    expect(calls[0]!.url).toBe('https://h/api/cores/api-keys/openai')
    expect(calls[0]!.init?.method).toBe('POST')
    expect((calls[0]!.init?.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    )
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ value: 'sk-secret' })
    expect(res.connected).toBe(true)
    expect(res.label).toBe('openai')
  })

  it('encodes a label with special characters in the path', async () => {
    let seen = ''
    const client = new IntegrationsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async (url) => {
        seen = url
        return json({ ok: true, label: 'a/b', connected: true })
      },
    })
    await client.setApiKey('a/b', 'x')
    expect(seen).toBe('https://h/api/cores/api-keys/a%2Fb')
  })

  it('throws a typed IntegrationsClientError on a 400 empty_value', async () => {
    const client = new IntegrationsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async () => json({ ok: false, code: 'empty_value', message: 'value required' }, 400),
    })
    try {
      await client.setApiKey('openai', '')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationsClientError)
      expect((err as IntegrationsClientError).code).toBe('empty_value')
      expect((err as IntegrationsClientError).status).toBe(400)
    }
  })

  it('throws unknown_label (400) as a typed error', async () => {
    const client = new IntegrationsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async () => json({ ok: false, code: 'unknown_label', message: 'no such slot' }, 400),
    })
    await expect(client.setApiKey('nope', 'x')).rejects.toMatchObject({
      code: 'unknown_label',
      status: 400,
    })
  })
})

describe('IntegrationsClient.deleteApiKey', () => {
  it('DELETEs /api/cores/api-keys/<label> and returns deleted:true', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const client = new IntegrationsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return json({ ok: true, label: 'openai', deleted: true })
      },
    })
    const res = await client.deleteApiKey('openai')
    expect(calls[0]!.url).toBe('https://h/api/cores/api-keys/openai')
    expect(calls[0]!.init?.method).toBe('DELETE')
    expect(res.deleted).toBe(true)
  })
})

describe('IntegrationsClientError', () => {
  it('wraps a network failure with code "network" and status 0', async () => {
    const client = new IntegrationsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async () => {
        throw new Error('offline')
      },
    })
    try {
      await client.getStatus()
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationsClientError)
      expect((err as IntegrationsClientError).code).toBe('network')
      expect((err as IntegrationsClientError).status).toBe(0)
    }
  })
})
