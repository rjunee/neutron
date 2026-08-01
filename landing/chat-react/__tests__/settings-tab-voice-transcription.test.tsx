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
    backend_reason: 'unconfigured',
    choice: null,
    local_available: false,
    openai_key: { present: false, source: null, saved_at: null },
    installed: false,
    model_id: null,
    installed_bytes: 0,
    binary_downloadable: true,
    binary_present: false,
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

describe('SettingsTab — voice transcription (happy-dom)', () => {
  it('a bare box offers the install button and names the download size', async () => {
    const { container, root } = await mount((url) => (url.endsWith(ASR) ? status() : null))
    expect(container.textContent).toContain('Voice transcription')
    expect(container.textContent).toContain('Nothing is transcribing — set up one of the options')
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

  it('a box CHOSEN as local reports it, and offers Remove', async () => {
    const { container, root } = await mount((url) =>
      url.endsWith(ASR)
        ? status({
            backend: 'local',
            choice: 'local',
            local_available: true,
            installed: true,
            model_id: 'base',
            installed_bytes: 157_000_000,
          })
        : null,
    )
    // The owner's setting, visible to the owner.
    expect(container.textContent).toContain('Transcribing on this server')
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
      return status({
        backend: 'local',
        choice: 'local',
        local_available: true,
        installed: true,
        model_id: 'base',
        installed_bytes: 157_000_000,
      })
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

  it('with BOTH set up and nothing chosen, it asks rather than picking one', async () => {
    // The old rule silently answered this with "local". Deleting it means the
    // owner is asked — and until they answer, the card says so plainly.
    const { container, root } = await mount((url) =>
      url.endsWith(ASR)
        ? status({
            backend: 'none',
            backend_reason: 'unchosen',
            local_available: true,
            installed: true,
            model_id: 'base',
            openai_key: { present: true, source: 'stored', saved_at: '2026-08-01T00:00:00.000Z' },
          })
        : null,
    )
    expect(container.textContent).toContain('both options are set up, so pick the one you want')
    root.unmount()
  })

  it('picking a backend PUTs the choice', async () => {
    let put = ''
    const both = {
      local_available: true,
      installed: true,
      model_id: 'base',
      openai_key: { present: true, source: 'stored', saved_at: '2026-08-01T00:00:00.000Z' },
    }
    const { container, root, act } = await mount((url, init) => {
      if (url.endsWith(`${ASR}/backend`)) {
        put = String(init?.body ?? '')
        return status({ ...both, backend: 'openai', choice: 'openai' })
      }
      if (url.endsWith(ASR)) {
        return status({ ...both, backend: 'none', backend_reason: 'unchosen' })
      }
      return null
    })
    const radios = [...container.querySelectorAll('input[name="cset-asr-backend"]')]
    expect(radios.length).toBe(2)
    await act(async () => {
      ;(radios[1] as HTMLInputElement).click()
      await tick()
    })
    expect(put).toContain('openai')
    root.unmount()
  })

  it('a chosen backend that cannot run says so — and says nothing was substituted', async () => {
    const { container, root } = await mount((url) =>
      url.endsWith(ASR)
        ? status({ backend: 'none', backend_reason: 'openai_key_missing', choice: 'openai' })
        : null,
    )
    expect(container.textContent).toContain('no API key is saved')
    expect(container.textContent).toContain('nothing has been substituted for it')
    root.unmount()
  })

  it('the key field PUTs the key, clears itself, and never renders one back', async () => {
    const SECRET = 'sk-thisisnotarealkey000000'
    let sent = ''
    const { container, root, act } = await mount((url, init) => {
      if (url.endsWith(`${ASR}/openai-key`)) {
        sent = String(init?.body ?? '')
        return status({
          openai_key: { present: true, source: 'stored', saved_at: '2026-08-02T00:00:00.000Z' },
        })
      }
      if (url.endsWith(ASR)) return status()
      return null
    })
    const input = container.querySelector('#cset-asr-openai-key') as HTMLInputElement
    // Masked at rest: a key on a shared screen is not a thing to display.
    expect(input.type).toBe('password')
    // React tracks the input's value internally, so a plain `.value =` looks
    // like "unchanged" to it — go through the prototype setter, as
    // `integrations-tab.test.tsx` does.
    const setVal = (Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set as (v: string) => void) ?? (() => {})
    await act(async () => {
      setVal.call(input, SECRET)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await tick()
    })
    await act(async () => {
      btn(container, 'Save key').click()
      await tick()
    })
    expect(sent).toContain(SECRET)
    // Gone from the field, and nowhere in the rendered card.
    expect((container.querySelector('#cset-asr-openai-key') as HTMLInputElement).value).toBe('')
    expect(container.textContent).not.toContain(SECRET)
    expect(container.textContent).not.toContain(SECRET.slice(-6))
    root.unmount()
  })

  it('an environment key explains where it lives and offers no Remove button', async () => {
    const { container, root } = await mount((url) =>
      url.endsWith(ASR)
        ? status({ openai_key: { present: true, source: 'environment', saved_at: null } })
        : null,
    )
    expect(container.textContent).toContain('OPENAI_API_KEY from the server environment')
    // Only the server operator can unset it, so there is no button pretending otherwise.
    expect(btn(container, 'Remove key')).toBeUndefined()
    root.unmount()
  })

  it('a platform with no prebuilt binary explains the package-manager step', async () => {
    const { container, root } = await mount((url) =>
      url.endsWith(ASR) ? status({ binary_downloadable: false }) : null,
    )
    expect(container.textContent).toContain('brew install whisper-cpp')
    root.unmount()
  })

  it('...but NOT once that binary is already there — the step is done', async () => {
    // `binary_present` (added for the mobile card, which has to disable its
    // control when neither flag holds) also fixes a small web lie: a macOS box
    // that already has Homebrew's whisper-cli was still being told to go and
    // install it.
    const { container, root } = await mount((url) =>
      url.endsWith(ASR) ? status({ binary_downloadable: false, binary_present: true }) : null,
    )
    expect(container.textContent).not.toContain('brew install whisper-cpp')
    root.unmount()
  })
})
