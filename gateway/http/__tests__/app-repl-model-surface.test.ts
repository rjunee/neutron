import { describe, expect, test } from 'bun:test'
import { createAppReplModelSurface, type ReplModelScope } from '../app-repl-model-surface.ts'
import { ReplModelError, type ReplModelState } from '@neutronai/runtime/repl-model.ts'
import { buildComposeSurfaces } from '../route-slots.ts'
import { composeHttpHandler } from '../compose.ts'

async function modelOf(response: Response): Promise<string | null> {
  return (await response.json() as ReplModelState).currentModel
}

function fixture() {
  let state: ReplModelState = {
    harness: 'claude-code', sessionId: 'session-a', currentModel: 'small',
    availableModels: [{ id: 'small', label: 'Small' }, { id: 'large', label: 'Large' }], status: 'ready',
  }
  const calls: ReplModelScope[] = []
  let acknowledge = async () => {}
  const surface = createAppReplModelSurface({
    auth: { mode: 'hs256', resolve: async (token) => token === 'owner'
      ? { user_id: 'owner', project_slug: 'instance', mode: 'hs256' }
      : token === 'stranger' ? { user_id: 'stranger', project_slug: 'instance', mode: 'hs256' }
      : { code: 'invalid_signature', message: 'Invalid bearer' } },
    canAccess: async (scope) => scope.userId === 'owner' && scope.ownerSlug === 'instance' &&
      (scope.projectId === null || scope.projectId === 'project-a' || scope.projectId === 'general'),
    read: async (scope) => { calls.push(scope); return state },
    switch: async (scope, request) => {
      calls.push(scope)
      if (request.sessionId !== state.sessionId) throw new ReplModelError('session-changed', 'Session changed')
      if (state.status === 'busy') throw new ReplModelError('busy', 'Busy')
      if (!state.availableModels.some(({ id }) => id === request.model)) throw new ReplModelError('invalid-model', 'Model not offered')
      await acknowledge()
      state = { ...state, currentModel: request.model }
      return state
    },
  })
  const http = composeHttpHandler({ ...buildComposeSurfaces({ app_repl_model_surface: surface }),
    defaultHandler: () => new Response('Not found', { status: 404 }) })
  async function request(method = 'GET', body?: unknown, scope = 'project-a', token: string | null = 'owner') {
    return http.fetch(new Request(`http://localhost/api/app/projects/${scope}/repl-model`, {
      method, headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), {} as never)
  }
  return { request, calls, setState: (next: Partial<ReplModelState>) => { state = { ...state, ...next } },
    setAck: (fn: () => Promise<void>) => { acknowledge = fn } }
}

describe('live model HTTP surface', () => {
  test('requires bearer and owner/project access before session reads, with valid controls', async () => {
    const f = fixture()
    for (const token of [null, 'invalid']) expect((await f.request('GET', undefined, 'project-a', token)).status).toBe(401)
    expect((await f.request('GET', undefined, 'project-a', 'stranger')).status).toBe(404)
    expect((await f.request('GET', undefined, 'project-b')).status).toBe(404)
    expect(f.calls).toHaveLength(0)
    expect((await f.request()).status).toBe(200)
    expect(f.calls).toEqual([{ userId: 'owner', ownerSlug: 'instance', projectId: 'project-a' }])
  })
  test('General cannot alias a real project called general', async () => {
    const f = fixture()
    expect((await f.request('GET', undefined, '~general')).status).toBe(200)
    expect((await f.request('GET', undefined, 'general')).status).toBe(200)
    expect(f.calls.map(({ projectId }) => projectId)).toEqual([null, 'general'])
  })
  test('refuses stale session, unoffered and malformed models, and busy runtime', async () => {
    const f = fixture()
    expect((await f.request('POST', { model: 'large', sessionId: 'other' })).status).toBe(409)
    expect((await f.request('POST', { model: 'invented', sessionId: 'session-a' })).status).toBe(400)
    for (const body of [null, [], {}, { model: '', sessionId: 'session-a' }]) expect((await f.request('POST', body)).status).toBe(400)
    f.setState({ status: 'busy' })
    expect((await f.request('POST', { model: 'large', sessionId: 'session-a' })).status).toBe(409)
    f.setState({ status: 'ready' })
    expect((await f.request('POST', { model: 'large', sessionId: 'session-a' })).status).toBe(200)
  })
  test('two clients observe native-acknowledged changes in both directions', async () => {
    const f = fixture()
    const web = f.request
    const mobile = f.request
    expect(await modelOf(await mobile())).toBe('small')
    let release!: () => void
    f.setAck(() => new Promise<void>((resolve) => { release = resolve }))
    let completed = false
    const switching = web('POST', { model: 'large', sessionId: 'session-a' }).then((r) => { completed = true; return r })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(completed).toBe(false)
    expect(await modelOf(await mobile())).toBe('small')
    release()
    expect(await modelOf(await switching)).toBe('large')
    expect(await modelOf(await mobile())).toBe('large')
    f.setAck(async () => {})
    expect(await modelOf(await mobile('POST', { model: 'small', sessionId: 'session-a' }))).toBe('small')
    const response = await web()
    expect(await modelOf(response)).toBe('small')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
  test('failed native acknowledgement is explicit JSON and never reports the requested model', async () => {
    const f = fixture()
    f.setAck(async () => { throw new ReplModelError('unknown', 'Native acknowledgement was not observed') })
    const response = await f.request('POST', { model: 'large', sessionId: 'session-a' })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'unknown', detail: 'Native acknowledgement was not observed' })
    expect(await modelOf(await f.request())).toBe('small')
  })
})
