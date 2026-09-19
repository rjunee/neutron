import { expect, test } from 'bun:test'
import { composeReplModelSurface } from '@neutronai/gateway/composition/repl-model.ts'
import type { Provider } from '@neutronai/runtime/provider.ts'
import type { ReplModelScope } from '@neutronai/gateway/http/app-repl-model-surface.ts'

test('composition preserves owner and General scopes and reads provider selection per request', async () => {
  let provider: Provider = 'anthropic'
  const scopes: ReplModelScope[] = []
  const state = { harness: 'claude-code' as const, sessionId: 'live', currentModel: 'small',
    availableModels: [{ id: 'small', label: 'Small' }], status: 'ready' as const }
  const surface = composeReplModelSurface({
    auth: { mode: 'hs256', resolve: async (token) => ({ user_id: token, project_slug: 'instance', mode: 'hs256' }) },
    ownerUserId: 'owner', ownerSlug: 'instance', projectExists: async (id) => id === 'project-a',
    provider: () => provider,
    readClaude: async (scope) => { scopes.push(scope); return state },
    switchClaude: async (scope) => { scopes.push(scope); return state },
  })
  const request = (scope = '~general', token = 'owner', method = 'GET') => surface.handler(new Request(
    `http://localhost/api/app/projects/${scope}/repl-model`, {
      method, headers: { authorization: `Bearer ${token}` },
      ...(method === 'POST' ? { body: JSON.stringify({ model: 'small', sessionId: 'live' }) } : {}),
    }))
  expect((await request())!.status).toBe(200)
  expect((await request('project-a'))!.status).toBe(200)
  expect(scopes.map((scope) => scope.projectId)).toEqual([null, 'project-a'])
  expect((await request('project-b'))!.status).toBe(404)
  expect((await request('project-a', 'stranger'))!.status).toBe(404)
  expect(scopes).toHaveLength(2)
  provider = 'openai-codex'
  const codex = await (await request())!.json()
  expect(codex).toMatchObject({ harness: 'codex', sessionId: '', currentModel: null, status: 'unsupported', availableModels: [] })
  expect((await request('~general', 'owner', 'POST'))!.status).toBe(503)
  provider = 'openai'
  const unrelated = (await request())!
  expect(unrelated.status).toBe(503)
  expect(await unrelated.json()).toMatchObject({ ok: false, code: 'unsupported' })
  expect(scopes).toHaveLength(2)
  provider = 'anthropic'
  expect((await request('project-a', 'owner', 'POST'))!.status).toBe(200)
  expect(scopes).toHaveLength(3)
})
