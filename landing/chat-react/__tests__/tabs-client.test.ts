/**
 * Unit tests for the web project tab-resolver client (WAVE 3 PR-4). Pure —
 * the `fetchImpl` is injected, so no DOM and no live server.
 */

import { describe, expect, it } from 'bun:test'

import {
  CHAT_TAB,
  WebTabsClient,
  TabsClientError,
  sanitizeCoreTabUrl,
  type TabDescriptor,
} from '../tabs-client.ts'

function tabsResponse(tabs: TabDescriptor[]): Response {
  return new Response(JSON.stringify({ ok: true, scope: 'project', project_id: 'acme', tabs }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('WebTabsClient.listProjectTabs', () => {
  it('GETs the per-project tabs route with a bearer header and returns the descriptors', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const client = new WebTabsClient({
      base_url: 'https://sam.neutron.test/',
      token: 'dev:sam',
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return tabsResponse([CHAT_TAB])
      },
    })
    const tabs = await client.listProjectTabs('acme')
    expect(calls).toHaveLength(1)
    // Trailing slash on base_url is normalised away.
    expect(calls[0]!.url).toBe('https://sam.neutron.test/api/app/projects/acme/tabs')
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer dev:sam')
    expect(tabs).toEqual([CHAT_TAB])
  })

  it('encodes the project id in the path', async () => {
    let seen = ''
    const client = new WebTabsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async (url) => {
        seen = url
        return tabsResponse([])
      },
    })
    await client.listProjectTabs('a/b proj')
    expect(seen).toBe('https://h/api/app/projects/a%2Fb%20proj/tabs')
  })

  it('throws TabsClientError carrying the engine code on a non-2xx', async () => {
    const client = new WebTabsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: false, code: 'invalid_project_id', message: 'bad' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    })
    await expect(client.listProjectTabs('!!')).rejects.toMatchObject({
      name: 'TabsClientError',
      code: 'invalid_project_id',
      status: 400,
    })
  })

  it('wraps a network failure as a TabsClientError(network)', async () => {
    const client = new WebTabsClient({
      base_url: 'https://h',
      token: 't',
      fetchImpl: async () => {
        throw new Error('offline')
      },
    })
    const err = await client.listProjectTabs('acme').catch((e) => e)
    expect(err).toBeInstanceOf(TabsClientError)
    expect((err as TabsClientError).code).toBe('network')
    expect((err as TabsClientError).status).toBe(0)
  })
})

describe('sanitizeCoreTabUrl', () => {
  it('accepts http(s) URLs', () => {
    expect(sanitizeCoreTabUrl('https://core.example/x')).toBe('https://core.example/x')
    expect(sanitizeCoreTabUrl('  http://core.example/y  ')).toBe('http://core.example/y')
  })
  it('rejects dangerous or malformed schemes and non-strings', () => {
    expect(sanitizeCoreTabUrl('javascript:alert(1)')).toBeNull()
    expect(sanitizeCoreTabUrl('data:text/html,<script>')).toBeNull()
    expect(sanitizeCoreTabUrl('not a url')).toBeNull()
    expect(sanitizeCoreTabUrl('')).toBeNull()
    expect(sanitizeCoreTabUrl(null)).toBeNull()
    expect(sanitizeCoreTabUrl(42)).toBeNull()
  })
})

describe('CHAT_TAB', () => {
  it('is the builtin Chat descriptor used as the pre-fetch / fallback tab', () => {
    expect(CHAT_TAB.key).toBe('chat')
    expect(CHAT_TAB.source).toBe('builtin')
    expect(CHAT_TAB.mount).toEqual({ kind: 'builtin', target: 'chat' })
  })
})
