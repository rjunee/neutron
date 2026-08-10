/**
 * Component test for the SETTINGS tab's "MCP servers" section — by PRESSING it.
 *
 * The assertions go through the real `SettingsTab` and click real buttons, because a
 * source check confirms a component mentions a handler and cannot tell a
 * rendered-and-wired control from a rendered-and-inert one. This repo has shipped that
 * bug, and it would be at its worst here: an Approve button that renders and does
 * nothing looks exactly like a working gate.
 *
 * WHAT IS WORTH PINNING, in order of how badly it fails if wrong:
 *   1. INSTALLING DOES NOT APPROVE. Adding a server must POST the collection and NOT
 *      the decision route, and the row must stay pending until Approve is pressed.
 *   2. APPROVE HITS THE DECISION ROUTE with an explicit `decision`, so approval can
 *      never be a side effect of anything else.
 *   3. THE PROMPT IS SHOWN VERBATIM. The server's `grant_prompt` reaches the screen
 *      unaltered — the client must not summarise what a program is allowed to do.
 *   4. NO VALUE IS EVER RENDERED. The section shows variable NAMES only.
 *   5. A rejected install shows the server's full complaint list and KEEPS the draft.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://owner.example.com/chat?client=react' })
  const g = globalThis as unknown as Record<string, unknown>
  g['IS_REACT_ACT_ENVIRONMENT'] = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const tick = () => new Promise((r) => setTimeout(r, 0))

const config = {
  wsUrl: 'wss://t/ws/app/chat',
  topicId: 'app:owner',
  userId: 'owner',
  projectId: 'acme',
  projects: [{ id: 'acme', label: 'Acme' }],
  origin: 'https://owner.example.com',
  deviceId: 'dev-test',
  token: 'dev:owner',
}

const MCP = '/api/app/mcp-servers'
const DECISION = `${MCP}/decision`
/** A value the section must never render. */
const SECRET = 'sk-not-a-real-key'

const GRANT = [
  'Install the MCP server "example-server"?',
  '',
  '    /usr/local/bin/example-mcp --stdio',
  '',
  'It receives these environment variables (names shown, values never):',
  '',
  '    EXAMPLE_API_KEY',
].join('\n')

type Handler = (url: string, init?: RequestInit) => Response | null

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function baseHandler(url: string): Response | null {
  if (url.endsWith('/api/app/projects/acme/credentials')) return json({ ok: true, project: [], global: [] })
  if (url.endsWith('/api/app/projects/acme/accounts')) {
    return json({ ok: true, project_id: 'acme', services: [] })
  }
  if (url.endsWith('/api/app/projects/acme/settings')) {
    return json({ ok: true, project: { name: 'Acme', emoji: '🏢', members: [] } })
  }
  return null
}

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'example-server',
    command: '/usr/local/bin/example-mcp',
    args: ['--stdio'],
    env_names: ['EXAMPLE_API_KEY'],
    approval: 'pending',
    grant_prompt: GRANT,
    secrets_present: true,
    active: false,
    ...over,
  }
}

function payload(servers: Array<Record<string, unknown>>): Response {
  return json({ ok: true, servers, reserved_names: ['neutron'], max_servers: 24 })
}

async function mount(handler: Handler) {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { SettingsTab } = await import('../SettingsTab.tsx')
  const React = await import('react')

  const calls: Array<{ method: string; url: string; body: unknown }> = []
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    let body: unknown = null
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    calls.push({ method: init?.method ?? 'GET', url, body })
    const res = handler(url, init) ?? baseHandler(url)
    if (res !== null) return res
    return json({ ok: false, code: 'request_failed' }, 404)
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <React.StrictMode>
        <SettingsTab projectId="acme" config={config} fetchImpl={fetchImpl} />
      </React.StrictMode>,
    )
  })
  await act(async () => {
    await tick()
    await tick()
  })
  return { container, root: root as unknown as { unmount: () => void }, act, calls }
}

const byTestId = (c: HTMLElement, id: string): HTMLElement | null =>
  c.querySelector(`[data-testid="${id}"]`)

/**
 * Type into a controlled input the way React sees it.
 *
 * Assigning `.value` directly is NOT enough: React installs its own value tracker on
 * the element, so a direct write leaves the tracker's last-known value equal to the
 * new one and `onChange` never fires — the DOM shows the text and the component's
 * state stays empty. Going through the PROTOTYPE setter updates the node while
 * leaving the tracker stale, which is what makes the dispatched `input` event
 * register as a real change. (Found by this test failing: the first version asserted
 * on a POST body that happened to be right for the wrong reason.)
 */
function type(el: HTMLElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter === undefined) throw new Error('no value setter on the element prototype')
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('SettingsTab — MCP servers (happy-dom)', () => {
  it('renders the section and says nothing is installed on a fresh box', async () => {
    const { container, root } = await mount((url) => (url.endsWith(MCP) ? payload([]) : null))
    expect(container.textContent).toContain('MCP servers')
    expect(byTestId(container, 'mcp-empty')).not.toBeNull()
    // The consequence is stated up front, not discovered at approval time.
    expect(container.textContent).toContain('program on this machine')
    root.unmount()
  })

  it('ADDING a server POSTs the collection and never the decision route', async () => {
    // The single most important assertion in this file: if adding also approved, the
    // gate would not exist.
    let installed = false
    const { container, root, act, calls } = await mount((url, init) => {
      if (url.endsWith(DECISION)) return payload([row({ approval: 'approved', active: true })])
      if (!url.endsWith(MCP)) return null
      if (init?.method === 'POST') {
        installed = true
        return payload([row()])
      }
      return payload(installed ? [row()] : [])
    })

    await act(async () => {
      type(byTestId(container, 'mcp-form-name')!, 'example-server')
      type(byTestId(container, 'mcp-form-command')!, '/usr/local/bin/example-mcp --stdio')
      type(byTestId(container, 'mcp-form-env')!, `EXAMPLE_API_KEY=${SECRET}`)
      await tick()
    })
    await act(async () => {
      ;(byTestId(container, 'mcp-form-save') as HTMLButtonElement).click()
      await tick()
    })

    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith(MCP))
    expect(post).toBeDefined()
    // The one-line command was split into command + args for the server to validate
    // and for the approval prompt to itemise.
    expect(post!.body).toEqual({
      name: 'example-server',
      command: '/usr/local/bin/example-mcp',
      args: ['--stdio'],
      env: { EXAMPLE_API_KEY: SECRET },
    })
    expect(calls.some((c) => c.url.endsWith(DECISION))).toBe(false)
    // And it is listed as PENDING, not running.
    expect(byTestId(container, 'mcp-example-server-status')!.textContent).toContain('approval')
    expect(byTestId(container, 'mcp-example-server-active')).toBeNull()
    root.unmount()
  })

  it('APPROVE posts the decision route with an explicit verb, and the row goes active', async () => {
    const { container, root, act, calls } = await mount((url, init) => {
      if (url.endsWith(DECISION) && init?.method === 'POST') {
        return payload([row({ approval: 'approved', active: true })])
      }
      if (url.endsWith(MCP)) return payload([row()])
      return null
    })

    expect(byTestId(container, 'mcp-example-server-attention')).not.toBeNull()
    await act(async () => {
      ;(byTestId(container, 'mcp-example-server-approve') as HTMLButtonElement).click()
      await tick()
    })

    const decision = calls.find((c) => c.url.endsWith(DECISION))
    expect(decision).toBeDefined()
    expect(decision!.body).toEqual({ name: 'example-server', decision: 'approve' })
    // The button was WIRED — the row re-rendered from the reply.
    expect(byTestId(container, 'mcp-example-server-active')).not.toBeNull()
    expect(byTestId(container, 'mcp-example-server-approve')).toBeNull()
    root.unmount()
  })

  it('DENY is a separate press with its own verb', async () => {
    const { container, root, act, calls } = await mount((url, init) => {
      if (url.endsWith(DECISION) && init?.method === 'POST') return payload([row({ approval: 'denied' })])
      if (url.endsWith(MCP)) return payload([row()])
      return null
    })
    await act(async () => {
      ;(byTestId(container, 'mcp-example-server-deny') as HTMLButtonElement).click()
      await tick()
    })
    expect(calls.find((c) => c.url.endsWith(DECISION))!.body).toEqual({
      name: 'example-server',
      decision: 'deny',
    })
    root.unmount()
  })

  it("shows the SERVER'S grant prompt verbatim, and no value anywhere", async () => {
    const { container, root } = await mount((url) => (url.endsWith(MCP) ? payload([row()]) : null))
    const grant = byTestId(container, 'mcp-example-server-grant')
    expect(grant).not.toBeNull()
    // Verbatim: the client must not summarise what a program is allowed to do.
    expect(grant!.textContent).toBe(GRANT)
    expect(container.textContent).toContain('EXAMPLE_API_KEY')
    expect(container.textContent).not.toContain(SECRET)
    root.unmount()
  })

  it('an APPROVED row shows no approve control — the gate is spent', async () => {
    const { container, root } = await mount((url) =>
      url.endsWith(MCP) ? payload([row({ approval: 'approved', active: true })]) : null,
    )
    expect(byTestId(container, 'mcp-example-server-approve')).toBeNull()
    expect(byTestId(container, 'mcp-example-server-grant')).toBeNull()
    expect(byTestId(container, 'mcp-example-server-status')!.textContent).toContain('running')
    root.unmount()
  })

  it('a rejected install shows every complaint and KEEPS the draft', async () => {
    const message = "name must be lowercase letters, digits and dashes; command is required"
    const { container, root, act, calls } = await mount((url, init) => {
      if (!url.endsWith(MCP)) return null
      if (init?.method === 'POST') return json({ ok: false, code: 'invalid_mcp_server', message }, 400)
      return payload([])
    })
    await act(async () => {
      type(byTestId(container, 'mcp-form-name')!, 'Bad Name')
      await tick()
    })
    await act(async () => {
      ;(byTestId(container, 'mcp-form-save') as HTMLButtonElement).click()
      await tick()
    })
    expect(byTestId(container, 'mcp-error')!.textContent).toBe(message)
    // Discarding the draft would punish a typo by throwing away the rest of the work.
    expect((byTestId(container, 'mcp-form-name') as HTMLInputElement).value).toBe('Bad Name')
    // Retrying still carries it.
    calls.length = 0
    await act(async () => {
      ;(byTestId(container, 'mcp-form-save') as HTMLButtonElement).click()
      await tick()
    })
    expect((calls.find((c) => c.method === 'POST')!.body as { name: string }).name).toBe('bad name')
    root.unmount()
  })

  it('REMOVE deletes by name and the row disappears', async () => {
    let removed = false
    const { container, root, act, calls } = await mount((url, init) => {
      if (!url.startsWith(`https://owner.example.com${MCP}`)) return null
      if (init?.method === 'DELETE') {
        removed = true
        return payload([])
      }
      return payload(removed ? [] : [row()])
    })
    await act(async () => {
      ;(byTestId(container, 'mcp-example-server-remove') as HTMLButtonElement).click()
      await tick()
    })
    const del = calls.find((c) => c.method === 'DELETE')
    expect(del).toBeDefined()
    expect(del!.url).toContain('name=example-server')
    expect(byTestId(container, 'mcp-example-server')).toBeNull()
    root.unmount()
  })

  it('a failed LOAD says so instead of rendering an empty list', async () => {
    // "Nothing installed" and "we could not ask" are different facts, and only one of
    // them is actionable.
    const { container, root } = await mount((url) =>
      url.endsWith(MCP) ? json({ ok: false, code: 'boom', message: 'server unreachable' }, 500) : null,
    )
    expect(byTestId(container, 'mcp-error')).not.toBeNull()
    expect(byTestId(container, 'mcp-empty')).toBeNull()
    root.unmount()
  })
})
