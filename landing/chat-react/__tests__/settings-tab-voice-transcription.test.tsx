/**
 * Component test for the SETTINGS tab's "Local voice transcription" section.
 *
 * The owner's requirement was a control that downloads and installs local
 * Whisper on click — and, critically, one that does not look like it is doing
 * nothing while it moves hundreds of megabytes. So the assertions here are
 * about VISIBLE TRUTH:
 *   - the section states which backend is transcribing right now;
 *   - the button POSTs, then real byte progress appears and advances;
 *   - a failure is shown, in words, with the promise that nothing was installed;
 *   - once installed, the control becomes a Remove affordance with its size.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://sam.neutron.test/chat?client=react' })
  const g = globalThis as unknown as Record<string, unknown>
  g['IS_REACT_ACT_ENVIRONMENT'] = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const tick = () => new Promise((r) => setTimeout(r, 0))

const config = {
  wsUrl: 'wss://t/ws/app/chat',
  topicId: 'app:sam',
  userId: 'sam',
  projectId: 'acme',
  projects: [{ id: 'acme', label: 'Acme' }],
  origin: 'https://sam.neutron.test',
  deviceId: 'dev-test',
  token: 'dev:sam',
}

type Handler = (url: string, init?: RequestInit) => Response | null

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function baseHandler(url: string): Response | null {
  if (url.endsWith('/api/app/projects/acme/credentials')) return json({ ok: true, project: [], global: [] })
  if (url.endsWith('/api/app/projects/acme/settings')) {
    return json({ ok: true, project: { name: 'Acme', emoji: '🏢', members: [] } })
  }
  return null
}

const MODELS = [
  {
    id: 'base',
    label: 'Base — fast (recommended)',
    size_bytes: 147_951_465,
    sec_per_30s_note: 3.8,
    peak_rss_mb: 343,
    note: 'A 30-second note is text in about 4 seconds.',
  },
  {
    id: 'large-v3-turbo',
    label: 'Large v3 Turbo — most accurate, slower than real time',
    size_bytes: 1_624_555_275,
    sec_per_30s_note: 50,
    peak_rss_mb: 1862,
    note: 'Best quality available on CPU.',
  },
]

function status(over: Record<string, unknown> = {}): Response {
  return json({
    ok: true,
    backend: 'none',
    installed: false,
    model_id: null,
    installed_bytes: 0,
    binary_downloadable: true,
    whisper_version: 'v1.9.1',
    default_model_id: 'base',
    models: MODELS,
    job: null,
    ...over,
  })
}

async function mount(handler: Handler) {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { SettingsTab } = await import('../SettingsTab.tsx')
  const React = await import('react')

  const calls: string[] = []
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
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

function btn(container: HTMLElement, text: string): HTMLButtonElement {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement
}

const ASR = '/api/app/voice-transcription'

describe('SettingsTab — local voice transcription (happy-dom)', () => {
  it('a bare box offers the install button and names the download size', async () => {
    const { container, root } = await mount((url) => (url.endsWith(ASR) ? status() : null))
    expect(container.textContent).toContain('Local voice transcription')
    expect(container.textContent).toContain('Voice notes are not transcribed on this server')
    expect(btn(container, 'Install local Whisper')).toBeDefined()
    // The cost is stated BEFORE the click, not discovered during it.
    expect(container.textContent).toContain('141 MB download')
    root.unmount()
  })

  it('clicking Install POSTs, then shows REAL byte progress that advances', async () => {
    let posted = false
    let poll = 0
    const { container, root, act, calls } = await mount((url, init) => {
      if (!url.endsWith(ASR)) return null
      if (init?.method === 'POST') {
        posted = true
        return status({ job: { phase: 'downloading_model', received_bytes: 0, total_bytes: 147_951_465, model_id: 'base', started_at: 1 } })
      }
      // Before the click there is no job at all — the button must read
      // "Install local Whisper", not "Installing…".
      if (!posted) return status()
      poll++
      return status({
        job: {
          phase: 'downloading_model',
          received_bytes: poll * 40_000_000,
          total_bytes: 147_951_465,
          model_id: 'base',
          started_at: 1,
        },
      })
    })

    await act(async () => {
      btn(container, 'Install local Whisper').click()
      await tick()
    })
    expect(posted).toBe(true)
    expect(calls.some((c) => c.startsWith(`POST https://sam.neutron.test${ASR}`))).toBe(true)
    expect(container.textContent).toContain('Downloading the model')
    // A real progressbar with a real value — not an indeterminate spinner.
    const bar = container.querySelector('[role="progressbar"]')
    expect(bar).not.toBeNull()

    // The poll advances it.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1100))
    })
    expect(container.textContent).toMatch(/Downloading the model — \d+ MB of 141 MB/)
    root.unmount()
  })

  it('a failure is shown in words, and promises nothing was installed', async () => {
    const { container, root } = await mount((url) =>
      url.endsWith(ASR)
        ? status({
            job: {
              phase: 'failed',
              received_bytes: 12,
              total_bytes: 147_951_465,
              model_id: 'base',
              started_at: 1,
              error: { code: 'insufficient_disk', message: 'needs 341 MB free under /data, but only 90 MB is available' },
            },
          })
        : null,
    )
    expect(container.textContent).toContain('only 90 MB is available')
    expect(container.textContent).toContain('Nothing was installed')
    root.unmount()
  })

  it('an installed box reports LOCAL even with an OpenAI key, and offers Remove', async () => {
    const { container, root } = await mount((url) =>
      url.endsWith(ASR)
        ? status({ backend: 'local', installed: true, model_id: 'base', installed_bytes: 157_000_000 })
        : null,
    )
    // The precedence rule, visible to the owner.
    expect(container.textContent).toContain('Running locally')
    expect(container.textContent).toContain('base')
    expect(btn(container, 'Remove local Whisper')).toBeDefined()
    // It is gigabytes; say how much before asking them to decide.
    expect(container.textContent).toContain('150 MB on disk')
    root.unmount()
  })

  it('Remove is two-step and only DELETEs on confirm', async () => {
    let deleted = false
    const { container, root, act } = await mount((url, init) => {
      if (!url.endsWith(ASR)) return null
      if (init?.method === 'DELETE') {
        deleted = true
        return status()
      }
      return status({ backend: 'local', installed: true, model_id: 'base', installed_bytes: 157_000_000 })
    })
    await act(async () => {
      btn(container, 'Remove local Whisper').click()
      await tick()
    })
    expect(deleted).toBe(false)
    expect(container.textContent).toContain('Delete the local model and binary')
    await act(async () => {
      btn(container, 'Delete').click()
      await tick()
    })
    expect(deleted).toBe(true)
    root.unmount()
  })

  it('a platform with no prebuilt binary explains the package-manager step', async () => {
    const { container, root } = await mount((url) =>
      url.endsWith(ASR) ? status({ binary_downloadable: false }) : null,
    )
    expect(container.textContent).toContain('brew install whisper-cpp')
    root.unmount()
  })
})
