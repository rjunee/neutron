import { expect, test } from 'bun:test'
import { ProjectChatSettingsClient } from './project-chat-settings.ts'

test('provider writes use the selected project, retain explicit Claude and clear inheritance with null', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const client = new ProjectChatSettingsClient({ base_url: 'https://example.test/', token: 'fixture', fetchImpl: async (url, init) => {
    calls.push({ url, init })
    const provider = JSON.parse(String(init?.body)).model_provider
    return Response.json({ project: { model_provider: provider }, model_provider_resolution: { provider: provider ?? 'openai-codex', source: provider ? 'project' : 'instance' } })
  } })
  expect((await client.set('alpha', 'anthropic')).project.model_provider).toBe('anthropic')
  expect((await client.set('alpha', null)).model_provider_resolution).toEqual({ provider: 'openai-codex', source: 'instance' })
  expect(calls.map(call => call.url)).toEqual(['https://example.test/api/app/projects/alpha/settings', 'https://example.test/api/app/projects/alpha/settings'])
  expect(calls.map(call => JSON.parse(String(call.init?.body)))).toEqual([{ model_provider: 'anthropic' }, { model_provider: null }])
})

test('project credential connection never calls the global route and refreshes configuration status', async () => {
  const calls: string[] = []
  const client = new ProjectChatSettingsClient({ base_url: 'https://example.test', token: 'fixture', fetchImpl: async (url, init) => {
    calls.push(`${init?.method} ${url}`)
    return Response.json({ owner_credential: { configured: true, checked_at: '2026-09-23T00:00:00Z', detail: 'Configured' } })
  } })
  expect((await client.connectCredential('alpha', 'synthetic')).owner_credential?.configured).toBe(true)
  expect(calls).toEqual(['POST https://example.test/api/app/projects/alpha/codex-auth', 'GET https://example.test/api/app/projects/alpha/codex-auth'])
  await expect(client.get('')).rejects.toThrow('require a project')
})

test('missing resolution and HTTP errors cannot appear as a saved provider', async () => {
  let response = Response.json({ project: { model_provider: null } })
  const client = new ProjectChatSettingsClient({ base_url: '', token: 'fixture', fetchImpl: async () => response })
  await expect(client.get('alpha')).rejects.toThrow('did not return project provider settings')
  response = Response.json({ code: 'read_only', message: 'Cannot change project' }, { status: 403 })
  await expect(client.set('alpha', 'openai-codex')).rejects.toThrow('Cannot change project')
})
