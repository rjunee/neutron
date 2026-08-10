/**
 * THE WEB USAGE CARD — the half of the dashboard the owner actually sees.
 *
 * The server does all the arithmetic; what this file protects is the RENDERING OF
 * ABSENCE, which is where a usage display goes wrong. Three fields are
 * legitimately null and each one has a different honest rendering:
 *
 *   - an unreachable route must NOT draw a bar (a 0% bar is an invented reading)
 *   - a null pace must read as an em dash, never as `0.0×` ("using nothing")
 *   - a null projection must OMIT its row, because null is the common good case
 *     and a permanent "—" trains the eye to hunt for a warning that is not there
 *
 * Every one of those is a case where the wrong choice still renders, still looks
 * plausible, and quietly tells the owner something false about their own quota —
 * so each gets a test that presses the real component rather than the formatter.
 *
 * The formatters are tested directly too: they carry the product decisions, and a
 * phone card is coming that must reuse the same RULES.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://owner.example.com/chat?client=react' })
  const g = globalThis as unknown as Record<string, unknown>
  g['IS_REACT_ACT_ENVIRONMENT'] = true
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }
  if (typeof (globalThis as Record<string, unknown>)['ResizeObserver'] !== 'function') {
    ;(globalThis as Record<string, unknown>)['ResizeObserver'] = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const {
  decodeDashboard,
  accountName,
  formatDuration,
  formatPace,
  formatPercent,
  paceNote,
  DASHBOARD_UNREACHABLE,
} = await import('../usage-dashboard-client.ts')

// ── the formatters — the product decisions, tested directly ──────────────────

describe('formatting refuses to invent a number', () => {
  it('renders a null pace as an em dash, NEVER as a zero', () => {
    // `0.0×` would read as "you are burning nothing", which is the opposite of
    // what a null pace means: the server declined to answer.
    expect(formatPace(null)).toBe('—')
    expect(formatPace(null)).not.toContain('0')
  })

  it('renders a real pace to one decimal', () => {
    expect(formatPace(1.52)).toBe('1.5×')
  })

  it('says nothing at all about a null pace, rather than "unknown"', () => {
    // A note reading "unknown pace" draws the eye to an absence the owner cannot
    // act on. The row simply carries the dash and no sentence.
    expect(paceNote(null)).toBeNull()
  })

  it('reads a pace against 1, which is the only threshold that matters', () => {
    expect(paceNote(1.4)).toContain('faster')
    expect(paceNote(0.6)).toContain('within')
    // Exactly 1 is sustainable, not burning: the window refills as fast as it drains.
    expect(paceNote(1)).toContain('within')
  })

  it('renders an unknown or already-past duration as a dash, not a negative', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(-60_000)).toBe('—')
    expect(formatDuration(0)).toBe('—')
  })

  it('renders durations the way a person reads a clock', () => {
    expect(formatDuration(9_000_000)).toBe('2h 30m')
    expect(formatDuration(7_200_000)).toBe('2h')
    expect(formatDuration(300_000)).toBe('5m')
  })

  it('clamps a percent into what a bar can draw', () => {
    expect(formatPercent(0.364)).toBe('36%')
    expect(formatPercent(1.4)).toBe('100%')
    expect(formatPercent(-0.2)).toBe('0%')
  })

  it('NEVER guesses which account a reading belongs to', () => {
    // The credential is swapped by a process outside this box. Naming an account
    // we cannot identify would be a confident lie about where the quota went.
    expect(accountName(null)).toBe('active credential')
    expect(accountName('acct-2')).toBe('acct-2')
  })
})

describe('decoding keeps "answered with nothing" apart from "could not ask"', () => {
  it('treats a non-object as unreachable', () => {
    expect(decodeDashboard(null)).toEqual(DASHBOARD_UNREACHABLE)
    expect(decodeDashboard('nope')).toEqual(DASHBOARD_UNREACHABLE)
    expect(decodeDashboard({})).toEqual(DASHBOARD_UNREACHABLE)
  })

  it('treats an EMPTY pools array as reachable', () => {
    // Collapsing this into "unreachable" would hide a server that answered
    // correctly, and the two render differently on purpose.
    expect(decodeDashboard({ pools: [] })).toEqual({ reachable: true, pools: [] })
  })

  it('nulls a window whose fraction is not a number, rather than coercing it', () => {
    const out = decodeDashboard({
      pools: [{ pool: 'anthropic', measured_at: 1, session: { fraction: 'lots' }, weekly: null }],
    })
    expect(out).toEqual({
      reachable: true,
      pools: [
        { pool: 'anthropic', measured_at: 1, account_label: null, session: null, weekly: null },
      ],
    })
  })
})

// ── the rendered card ────────────────────────────────────────────────────────

const config = {
  origin: 'https://owner.example.com',
  token: 't',
  project_id: 'acme',
} as unknown as import('../config.ts').BootstrapConfig

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Mounts the REAL SettingsTab; only the dashboard route varies per test. */
async function mount(dashboard: () => Response): Promise<{
  container: HTMLElement
  root: { unmount: () => void }
}> {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { SettingsTab } = await import('../SettingsTab.tsx')
  const React = await import('react')

  const fetchImpl = async (url: string): Promise<Response> => {
    if (url.endsWith('/api/app/usage/dashboard')) return dashboard()
    if (url.endsWith('/api/app/projects/acme/credentials')) {
      return json({ ok: true, project: [], global: [] })
    }
    if (url.endsWith('/api/app/projects/acme/accounts')) {
      return json({ ok: true, project_id: 'acme', services: [] })
    }
    if (url.endsWith('/api/app/projects/acme/settings')) {
      return json({ ok: true, project: { name: 'Acme', emoji: '🏢', members: [] } })
    }
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
  return { container, root: root as unknown as { unmount: () => void } }
}

function pool(session: unknown, weekly: unknown, account_label: string | null = null): Response {
  return json({
    pools: [{ pool: 'anthropic', measured_at: 1_700_000_000_000, account_label, session, weekly }],
  })
}

const SESSION_HOT = {
  fraction: 0.75,
  reset_at: 1_700_009_000_000,
  resets_in_ms: 9_000_000,
  pace: 1.5,
  exhausts_at: Date.now() + 3_000_000,
}

describe('the rendered usage card', () => {
  it('shows the percent, the pace and its reading for a measured window', async () => {
    const { container, root } = await mount(() => pool(SESSION_HOT, null))
    expect(container.querySelector('[data-testid="usage-anthropic-session-pct"]')?.textContent).toBe(
      '75%',
    )
    const paceCell = container.querySelector('[data-testid="usage-anthropic-session-pace"]')
    expect(paceCell?.textContent).toContain('1.5×')
    expect(paceCell?.textContent).toContain('faster')
    expect(
      container.querySelector('[data-testid="usage-anthropic-session-resets"]')?.textContent,
    ).toBe('2h 30m')
    root.unmount()
  })

  it('colours the fill from the SHARED thresholds, not a local guess', async () => {
    // 0.75 is nominal, 0.9 is warning, 0.97 is critical — the same boundaries the
    // 2px divider meter uses, so the card and the hairline cannot disagree.
    const { container, root } = await mount(() =>
      pool({ ...SESSION_HOT, fraction: 0.9, exhausts_at: null }, null),
    )
    expect(
      container
        .querySelector('[data-testid="usage-anthropic-session-fill"]')
        ?.getAttribute('data-band'),
    ).toBe('warning')
    root.unmount()
  })

  it('OMITS the projection row when there is no projection', async () => {
    // The common, good case. A permanently-present "Caps out in —" would read as a
    // failed computation and train the owner to ignore the row that matters.
    const { container, root } = await mount(() =>
      pool({ ...SESSION_HOT, pace: 0.4, exhausts_at: null }, null),
    )
    expect(container.querySelector('[data-testid="usage-anthropic-session-exhausts"]')).toBeNull()
    expect(container.textContent).not.toContain('Caps out in')
    root.unmount()
  })

  it('SHOWS the projection row when the window is on track to run out', async () => {
    const { container, root } = await mount(() => pool(SESSION_HOT, null))
    expect(
      container.querySelector('[data-testid="usage-anthropic-session-exhausts"]'),
    ).not.toBeNull()
    root.unmount()
  })

  it('renders a null pace as a dash with no reading beside it', async () => {
    const { container, root } = await mount(() =>
      pool({ fraction: 0.2, reset_at: null, resets_in_ms: null, pace: null, exhausts_at: null }, null),
    )
    const paceCell = container.querySelector('[data-testid="usage-anthropic-session-pace"]')
    expect(paceCell?.textContent?.trim()).toBe('—')
    root.unmount()
  })

  it('says a window was not reported rather than drawing an empty track', async () => {
    const { container, root } = await mount(() => pool(SESSION_HOT, null))
    expect(
      container.querySelector('[data-testid="usage-anthropic-weekly-none"]')?.textContent,
    ).toBe('not reported')
    // No bar at all for that window — an empty coloured track is the specific claim
    // "0% used", which nothing measured.
    expect(container.querySelector('[data-testid="usage-anthropic-weekly-fill"]')).toBeNull()
    root.unmount()
  })

  it('draws NO bar at all when the route is not mounted', async () => {
    // An older server 404s here. Drawing a 0% bar would invent a measurement, so
    // the card says it cannot reach the history and renders no progressbar.
    const { container, root } = await mount(() => json({ ok: false }, 404))
    expect(container.querySelector('[data-testid="usage-unreachable"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-testid^="usage-anthropic"]').length).toBe(0)
    root.unmount()
  })

  it('names the credential without guessing, and uses a real label when given one', async () => {
    const anon = await mount(() => pool(SESSION_HOT, null, null))
    expect(
      anon.container.querySelector('[data-testid="usage-anthropic-account"]')?.textContent,
    ).toBe('active credential')
    anon.root.unmount()

    const named = await mount(() => pool(SESSION_HOT, null, 'acct-2'))
    expect(
      named.container.querySelector('[data-testid="usage-anthropic-account"]')?.textContent,
    ).toBe('acct-2')
    named.root.unmount()
  })
})

describe('every class the card emits is actually styled', () => {
  it('has a rule in chat-react.html for each cset-usage-* class', async () => {
    // The `var(--hairline)` shape: a class that renders, is correct, and has no
    // paint behind it. Tree-shaped assertions cannot see that, so this reads the
    // stylesheet the page actually serves.
    const css = await Bun.file(new URL('../../chat-react.html', import.meta.url)).text()
    const tsx = await Bun.file(new URL('../SettingsTab.tsx', import.meta.url)).text()
    const emitted = new Set(
      [...tsx.matchAll(/cset-usage-[a-z-]+/g)].map((m) => m[0]),
    )
    // A positive control: if the scrape found nothing, the assertion below would
    // pass vacuously and prove the tool broken rather than the CSS present.
    expect(emitted.size).toBeGreaterThan(4)
    const unstyled = [...emitted].filter((cls) => !css.includes(`.${cls}`))
    expect(unstyled).toEqual([])
  })
})
