import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { NativeOwnerControlState, FetchImpl } from '../native-owner-control-client.ts'

let ownsDom = false
beforeAll(() => {
  // The native app harness keeps its DOM registered between co-resident files.
  // Reuse that DOM; component requests already receive an explicit origin.
  ownsDom = !GlobalRegistrator.isRegistered
  if (ownsDom) GlobalRegistrator.register({ url: 'https://test.example/chat' })
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
})
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister() })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const snapshot = (projectId: string | null): NativeOwnerControlState => ({
  projectId, threadId: 'thread-1', bindingRevision: 'binding-1', generation: 2, epoch: 3,
  turnId: 'turn-1', status: 'busy', pending: [{ requestId: 7,
    method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1',
      command: 'bun test', availableDecisions: ['accept', 'decline', 'cancel'] } }],
})
const model = (harness = 'codex') => ({ harness, sessionId: 'session-1', currentModel: 'deep',
  availableModels: [{ id: 'deep', label: 'Deep' }], status: 'busy' })

async function render(projectId: string | null, fetchImpl: FetchImpl) {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ReplModelControl } = await import('../ReplModelControl.tsx')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const update = async (scope: string | null) => {
    await act(async () => { root.render(<ReplModelControl key={scope ?? '~general'} projectId={scope}
      origin="https://test.example" token="owner-token" fetchImpl={fetchImpl} />); await tick(); await tick() })
  }
  await update(projectId)
  return { host, update, close: async () => { await act(async () => { root.unmount() }); host.remove() } }
}
async function click(host: HTMLElement, label: string) {
  const { act } = await import('react')
  const button = [...host.querySelectorAll('button')].find(element => element.textContent === label)
  expect(button).toBeDefined()
  expect(button!.disabled).toBe(false)
  await act(async () => { button!.click(); await tick(); await tick() })
}

describe('native actions through the served web model control', () => {
  for (const scope of [null, 'general', 'project-a']) {
    it(`renders and sends observed identity for ${JSON.stringify(scope)}`, async () => {
      const state = snapshot(scope)
      const calls: { url: string; init?: RequestInit }[] = []
      const view = await render(scope, async (url, init) => {
        calls.push({ url, ...(init ? { init } : {}) })
        return json(url.endsWith('/repl-model') ? model() : state)
      })
      try {
        expect(view.host.querySelector('[aria-label="Codex controls"]')).not.toBeNull()
        await click(view.host, 'Allow once')
        await click(view.host, 'Decline')
        await click(view.host, 'Cancel')
        await click(view.host, 'Interrupt Codex')
        const posts = calls.filter(call => call.init?.method === 'POST')
        expect(posts).toHaveLength(4)
        for (const post of posts) {
          expect(post.url).toBe(`https://test.example/api/app/projects/${scope ?? '~general'}/repl-control`)
          expect((post.init?.headers as Record<string, string>).authorization).toBe('Bearer owner-token')
        }
        const { pending: _pending, status: _status, ...identity } = state
        expect(posts.map(post => JSON.parse(String(post.init?.body)))).toEqual([
          ...['accept', 'decline', 'cancel'].map(decision => ({ ...identity, action: 'reply', requestId: 7, result: { decision } })),
          { ...identity, action: 'interrupt' },
        ])
      } finally { await view.close() }
    })
  }

  for (const wrong of ['foreign', 'general', '~general']) {
    it(`refuses ${wrong} identity returned for null General`, async () => {
      let writes = 0
      const view = await render(null, async (url, init) => {
        if (init?.method === 'POST') writes++
        return json(url.endsWith('/repl-model') ? model() : snapshot(wrong))
      })
      try {
        expect(view.host.textContent).toContain('invalid Codex control state')
        expect(view.host.querySelector('[aria-label="Interrupt Codex turn"]')).toBeNull()
        expect(view.host.textContent).not.toContain('Allow once')
        expect(writes).toBe(0)
      } finally { await view.close() }
    })
  }

  it('refuses a pending question from another native turn', async () => {
    const state = snapshot('project-a')
    state.pending[0]!.params.turnId = 'foreign-turn'
    const view = await render('project-a', async url => json(url.endsWith('/repl-model') ? model() : state))
    try {
      expect(view.host.textContent).toContain('invalid Codex control state')
      expect(view.host.textContent).not.toContain('Allow once')
    } finally { await view.close() }
  })

  it('refuses General state returned for a literal general project', async () => {
    const view = await render('general', async url => json(url.endsWith('/repl-model') ? model() : snapshot(null)))
    try {
      expect(view.host.textContent).toContain('invalid Codex control state')
      expect(view.host.querySelector('[aria-label="Interrupt Codex turn"]')).toBeNull()
    } finally { await view.close() }
  })

  for (const changed of [{ threadId: 'replacement' }, { generation: 99 }, { bindingRevision: 'replacement' }]) {
    it(`refuses replacement acknowledgement ${JSON.stringify(changed)} without replaying the write`, async () => {
      let writes = 0
      const view = await render(null, async (url, init) => {
        if (url.endsWith('/repl-model')) return json(model())
        if (init?.method === 'POST') { writes++; return json({ ...snapshot(null), pending: [], ...changed }) }
        return json(snapshot(null))
      })
      try {
        await click(view.host, 'Allow once')
        expect(view.host.textContent).toContain('conversation changed')
        expect(writes).toBe(1)
      } finally { await view.close() }
    })
  }

  it('renders supported input and sends the answer envelope', async () => {
    const state = snapshot(null)
    state.pending = [{ requestId: 'question-1', method: 'item/tool/requestUserInput', params: {
      threadId: state.threadId, turnId: state.turnId, questions: [{ id: 'choice', question: 'Which path?',
        options: [{ label: 'Small' }, { label: 'Large' }] }],
    } }]
    let body: unknown
    const view = await render(null, async (url, init) => {
      if (init?.body) body = JSON.parse(String(init.body))
      return json(url.endsWith('/repl-model') ? model() : state)
    })
    try {
      expect((view.host.querySelector('input') as HTMLInputElement).value).toBe('')
      await click(view.host, 'Small')
      await click(view.host, 'Send answer')
      expect(body).toMatchObject({ projectId: null, threadId: 'thread-1', turnId: 'turn-1',
        action: 'reply', requestId: 'question-1', result: { answers: { choice: { answers: ['Small'] } } } })
    } finally { await view.close() }
  })

  it('does not mount Codex controls for a Claude owner', async () => {
    const calls: string[] = []
    const view = await render(null, async url => { calls.push(url); return json(model('claude-code')) })
    try {
      expect(calls).toEqual(['https://test.example/api/app/projects/~general/repl-model'])
      expect(view.host.querySelector('[aria-label="Codex controls"]')).toBeNull()
    } finally { await view.close() }
  })

  it('shows unsupported questions in the terminal and respects offered approval decisions', async () => {
    const state = snapshot(null)
    state.pending[0]!.params.availableDecisions = ['decline']
    state.pending.push({ requestId: 'unknown', method: 'unsupported/request',
      params: { threadId: state.threadId, turnId: state.turnId } })
    const view = await render(null, async url => json(url.endsWith('/repl-model') ? model() : state))
    try {
      expect(view.host.textContent).toContain('Decline')
      expect(view.host.textContent).not.toContain('Allow once')
      expect(view.host.textContent).toContain('needs an answer in the Codex terminal')
    } finally { await view.close() }
  })

  it('discards a late General read after switching to a literal general project', async () => {
    let finish: (response: Response) => void = () => {}
    const view = await render(null, async url => {
      if (url.endsWith('/repl-model')) return json(model())
      if (url.includes('/~general/')) return new Promise(resolve => { finish = resolve })
      return json({ ...snapshot('general'), pending: [] })
    })
    try {
      await view.update('general')
      const { act } = await import('react')
      await act(async () => { finish(json(snapshot(null))); await tick() })
      expect(view.host.querySelector('[aria-label="Interrupt Codex turn"]')).not.toBeNull()
      expect(view.host.textContent).not.toContain('Allow once')
    } finally { await view.close() }
  })
})
