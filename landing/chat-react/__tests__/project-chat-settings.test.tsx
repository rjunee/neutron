import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://example.test' })
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})
afterAll(async () => { await GlobalRegistrator.unregister() })

test.each([false, true])('web project credential status stays isolated while the next read is pending or fails (failure %s)', async failure => {
  const { createRoot } = await import('react-dom/client')
  const { act, createElement } = await import('react')
  const { SettingsTab } = await import('../SettingsTab.tsx')
  let finishBeta!: (response: Response) => void
  const betaStatus = new Promise<Response>(resolve => { finishBeta = resolve })
  const fetchImpl = async (url: string): Promise<Response> => {
    const path = new URL(url).pathname
    const project = path.split('/')[4]!
    if (path.endsWith('/settings')) return Response.json({ project: { name: project, emoji: '', members: [], model_provider: null },
      model_provider_resolution: { provider: 'anthropic', source: 'instance' } })
    if (path.endsWith('/credentials')) return Response.json({ project: [], global: [] })
    if (path.endsWith('/accounts')) return Response.json({ services: [] })
    if (path.endsWith('/codex-auth')) return project === 'beta' ? betaStatus : Response.json({ status: 'connected', scope: 'project',
      available_accounts: [{ source_row_id: 'alpha-row', account_identity: 'alpha-identity', account: 'fixture', label: 'Alpha selectable account' }],
      override_present: true, detail: 'Alpha credential observation',
      owner_credential: { configured: true, checked_at: '2026-09-23T00:00:00Z', detail: 'Alpha owner configuration' } })
    return Response.json({ code: 'unavailable' }, { status: 404 })
  }
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  const config = { wsUrl: 'wss://example.test/ws', topicId: 'topic', userId: 'owner', projectId: 'alpha',
    projects: [], origin: 'https://example.test', deviceId: 'fixture', token: 'fixture' }
  const render = async (projectId: string) => { await act(async () => {
    root.render(createElement(SettingsTab, { projectId, config, fetchImpl }))
    await new Promise(resolve => setTimeout(resolve, 0))
  }) }
  const panel = () => host.querySelector('[aria-label="Codex review override"]')!
  try {
    await render('alpha')
    expect(panel().textContent).toContain('Alpha credential observation')
    expect(panel().textContent).toContain('Remove override')
    expect(host.textContent).toContain('Alpha owner configuration')
    expect(host.textContent).toContain('Alpha selectable account')
    await render('beta')
    expect(panel().querySelector('[data-status]')?.getAttribute('data-status')).toBe('unknown')
    expect(panel().textContent).toContain('Checking project connection')
    expect(host.textContent).not.toContain('Alpha credential observation')
    expect(host.textContent).not.toContain('Alpha owner configuration')
    expect(host.textContent).not.toContain('Alpha selectable account')
    expect(panel().textContent).not.toContain('Remove override')
    await act(async () => {
      finishBeta(failure ? Response.json({ message: 'Beta status could not be checked' }, { status: 503 })
        : Response.json({ status: 'not_connected', scope: 'none', override_present: false }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(panel().querySelector('[data-status]')?.getAttribute('data-status')).toBe(failure ? 'unknown' : 'not_connected')
    expect(panel().textContent).toContain(failure ? 'Connection status unavailable' : 'Not connected')
    if (failure) expect(panel().textContent).not.toContain('Not connected')
    expect(panel().textContent).not.toContain('Remove override')
    await render('alpha')
    expect(panel().textContent).toContain('Alpha credential observation')
    expect(panel().textContent).toContain('Remove override')
  } finally { await act(async () => root.unmount()); host.remove() }
})

test('web existing account requires selection and explicit project connect; refusals and removal retain canonical accounts', async () => {
  const { createRoot } = await import('react-dom/client')
  const { act, createElement } = await import('react')
  const { SettingsTab } = await import('../SettingsTab.tsx')
  const writes: { path: string; method: string; body: unknown }[] = []
  const account = { source_row_id: 'fixture-row', account_identity: 'fixture-identity', account: 'seat-1', label: 'Configured fixture' }
  let connected = false
  let refused = true
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname
    const method = init?.method ?? 'GET'
    if (method !== 'GET') {
      writes.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (init?.body && JSON.parse(String(init.body)).auth) return Response.json({ code: 'existing_account_requires_grant', message: 'Select the existing configured account' }, { status: 400 })
      if (refused) return Response.json({ code: 'project_account_unavailable', message: 'Select the configured account again' }, { status: 409 })
      connected = method === 'POST'
    }
    if (path.endsWith('/settings')) return Response.json({ project: { name: 'alpha', members: [], model_provider: null }, model_provider_resolution: { provider: 'anthropic', source: 'instance' } })
    if (path.endsWith('/credentials')) return Response.json({ project: [], global: [] })
    if (path.endsWith('/accounts')) return Response.json({ services: [] })
    if (path.endsWith('/codex-auth')) return Response.json({ status: 'connected', scope: connected ? 'project' : 'global', override_present: connected, available_accounts: [account], owner_credential: { configured: connected, checked_at: '2026-10-04T00:00:00Z', detail: connected ? 'Project grant connected' : 'Project grant required' } })
    return Response.json({}, { status: 404 })
  }
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  const config = { wsUrl: 'wss://example.test/ws', topicId: 'topic', userId: 'owner', projectId: 'alpha', projects: [], origin: 'https://example.test', deviceId: 'fixture', token: 'fixture' }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  const choose = async () => { await act(async () => {
    const select = host.querySelector('#cset-codex-account') as HTMLSelectElement
    select.value = account.source_row_id; select.dispatchEvent(new Event('change', { bubbles: true })); await settle()
  }) }
  const connectButton = () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Connect selected account to project')!
  try {
    await act(async () => { root.render(createElement(SettingsTab, { projectId: 'alpha', config, fetchImpl })); await settle() })
    expect(writes).toEqual([])
    expect(connectButton().disabled).toBe(true)
    await act(async () => {
      const input = host.querySelector('#cset-codex-auth') as HTMLTextAreaElement
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'synthetic-auth')
      input.dispatchEvent(new Event('input', { bubbles: true })); await settle()
    })
    await act(async () => { Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Save project override')!.click(); await settle() })
    expect(host.textContent).toContain('existing_account_requires_grant')
    expect(host.textContent).toContain('Select the existing configured account')
    expect(host.textContent).toContain('Configured fixture')
    await choose()
    expect(writes).toHaveLength(1)
    await act(async () => { connectButton().click(); await settle() })
    expect(host.textContent).toContain('Select the configured account again')
    expect(host.textContent).not.toContain('Project grant connected')
    refused = false
    await choose()
    await act(async () => { connectButton().click(); await settle() })
    expect(writes.at(-1)).toEqual({ path: '/api/app/projects/alpha/codex-auth', method: 'POST', body: { source_row_id: account.source_row_id, account_identity: account.account_identity } })
    expect(host.textContent).toContain('Project grant connected')
    await act(async () => { Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Remove override')!.click(); await settle() })
    expect(writes.at(-1)).toEqual({ path: '/api/app/projects/alpha/codex-auth', method: 'DELETE', body: null })
    expect(host.textContent).toContain('Configured fixture')
    expect(host.textContent).toContain('Project grant required')
  } finally { await act(async () => root.unmount()); host.remove() }
})

test('web project settings save providers without credentials, retain failures, and isolate project switches', async () => {
  const { createRoot } = await import('react-dom/client')
  const { act, createElement } = await import('react')
  const { SettingsTab } = await import('../SettingsTab.tsx')
  const providers: Record<string, string | null> = { alpha: null, beta: 'anthropic' }
  const writes: { path: string; body: unknown }[] = []
  let reject = false
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname
    const project = path.split('/')[4]!
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body))
      writes.push({ path, body })
      if (reject) return Response.json({ code: 'refused', message: 'Save refused' }, { status: 409 })
      providers[project] = body.model_provider
    }
    if (path.endsWith('/settings')) return Response.json({ project: { name: project, emoji: '', members: [], model_provider: providers[project] },
      model_provider_resolution: { provider: providers[project] ?? 'anthropic', source: providers[project] ? 'project' : 'instance' } })
    if (path.endsWith('/credentials')) return Response.json({ project: [], global: [] })
    if (path.endsWith('/accounts')) return Response.json({ services: [] })
    if (path.endsWith('/codex-auth')) return Response.json({ status: 'connected', scope: 'global',
      owner_credential: { configured: false, checked_at: '2026-09-23T00:00:00Z', detail: 'Connect a Codex subscription to this project to use Codex chat' } })
    return Response.json({ code: 'unavailable' }, { status: 404 })
  }
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  const config = { wsUrl: 'wss://example.test/ws', topicId: 'topic', userId: 'owner', projectId: 'alpha',
    projects: [], origin: 'https://example.test', deviceId: 'fixture', token: 'fixture' }
  const render = async (projectId: string) => { await act(async () => {
    root.render(createElement(SettingsTab, { projectId, config, fetchImpl }))
    await new Promise(resolve => setTimeout(resolve, 0))
  }) }
  const select = async (value: string) => { await act(async () => {
    const input = host.querySelector('#project-chat-provider') as HTMLSelectElement
    input.value = value; input.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  }) }
  try {
    await render('alpha')
    expect(host.textContent).toContain('Connect a Codex subscription to this project')
    await select('openai-codex')
    expect(providers).toEqual({ alpha: 'openai-codex', beta: 'anthropic' })
    expect(host.textContent).toContain('Effective: Codex · project setting')
    reject = true
    await select('anthropic')
    expect(host.textContent).toContain('Save refused')
    expect((host.querySelector('#project-chat-provider') as HTMLSelectElement).value).toBe('openai-codex')
    reject = false
    await select('inherit')
    expect(providers.alpha).toBeNull()
    expect(host.textContent).toContain('Effective: Claude Code · instance setting')
    await render('beta')
    await select('openai-codex')
    expect(providers).toEqual({ alpha: null, beta: 'openai-codex' })
    expect(writes.at(-1)).toEqual({ path: '/api/app/projects/beta/settings', body: { model_provider: 'openai-codex' } })
    await render('alpha')
    expect((host.querySelector('#project-chat-provider') as HTMLSelectElement).value).toBe('inherit')
  } finally { await act(async () => root.unmount()); host.remove() }
})
