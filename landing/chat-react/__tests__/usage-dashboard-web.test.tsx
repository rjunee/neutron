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
 *   - an ABSENT reset instant must read "unknown", never "available now". That one
 *     is not cosmetic: it is the difference between waiting and raising concurrency
 *     into a wall, so it gets its own mutation-shaped test.
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
  formatProjection,
  formatPace,
  formatPercent,
  paceNote,
  projectPool,
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

  it('OMITS a projection that is absent or already past, rather than dashing it', () => {
    const now = Date.now()
    expect(formatProjection(null, now)).toBeNull()
    expect(formatProjection(now - 60_000, now)).toBeNull()
  })

  it('renders a live projection the way a person reads a clock', () => {
    const now = Date.now()
    expect(formatProjection(now + 9_000_000, now)).toBe('2h 30m')
    expect(formatProjection(now + 300_000, now)).toBe('5m')
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
      pools: [
        {
          pool: 'anthropic',
          measured_at: 1,
          accounts: [{ measured_at: 1, session: { fraction: 'lots' }, weekly: null }],
        },
      ],
    })
    expect(out.reachable).toBe(true)
    if (!out.reachable) return
    expect(out.pools[0]?.accounts[0]?.session).toBeNull()
  })

  it('ignores a capacity standing on the wire — the card computes its own', () => {
    // The server has no standing to offer: "can this account take work" is a
    // function of the render clock, and a verdict decoded here would be painted
    // unchanged for as long as the payload was held. A cheerful "available" is
    // dropped, and the honest answer is computed from the reading itself — 99%
    // spent with no reset instant is UNKNOWN, never "push more work at it".
    const out = decodeDashboard({
      pools: [
        {
          pool: 'kimi',
          accounts: [
            {
              measured_at: 1,
              capacity: { state: 'available' },
              session: { fraction: 0.99, reset_at: null },
            },
          ],
        },
      ],
    })
    expect(out.reachable).toBe(true)
    if (!out.reachable) return
    expect('capacity' in out.pools[0]!.accounts[0]!).toBe(false)
    expect(projectPool(out.pools[0]!, 1).accounts[0]!.capacity).toEqual({ state: 'unknown' })
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


// ── the payload builders ─────────────────────────────────────────────────────
// Time-relative, because a countdown rendered against a hardcoded epoch is a test
// that passes today and lies later.

const NOW = Date.now()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

type Json = Record<string, unknown>

function window_(over: Json = {}): Json {
  return {
    fraction: 0.75,
    window_ms: 5 * HOUR,
    reset_at: NOW + 2.5 * HOUR,
    pace: 1.5,
    exhausts_at: NOW + 50 * MINUTE,
    ...over,
  }
}

/**
 * One account as the SERVER sends it: instants and figures, and no verdicts.
 *
 * There is no `age_ms`, no `stale`, no `floor` and no `capacity` to override,
 * because none of them ride the wire — the card derives all four from
 * `measured_at`, `stale_after_ms` and its own clock. A test that wanted a stale
 * card therefore backdates `measured_at`, which is the same lever a dead poller
 * pulls.
 */
function account(over: Json = {}): Json {
  return {
    account_label: null,
    measured_at: NOW,
    session: window_(),
    weekly: window_({ window_ms: 7 * DAY, fraction: 0.5, pace: 1, exhausts_at: null }),
    ...over,
  }
}

function poolOf(over: Json = {}): Json {
  const accounts = (over['accounts'] as Json[] | undefined) ?? [account()]
  return {
    pool: 'anthropic',
    connection: 'connected',
    measured_at: (accounts[0]?.['measured_at'] as number | undefined) ?? NOW,
    // Anthropic's deadline: a 60s cadence with one missed probe of grace.
    stale_after_ms: 2 * MINUTE,
    ...over,
    accounts,
  }
}

/** One pool, one account, with the session window overridden. */
function pool(session: unknown, weekly: unknown, account_label: string | null = null): Response {
  return json({ pools: [poolOf({ accounts: [account({ session, weekly, account_label })] })] })
}

const SESSION_HOT = window_()

describe('the rendered usage card', () => {
  it('shows the percent, the pace and its reading for a measured window', async () => {
    const { container, root } = await mount(() => pool(SESSION_HOT, null))
    expect(
      container.querySelector('[data-testid="usage-anthropic-acct-0-session-pct"]')?.textContent,
    ).toBe('75%')
    const paceCell = container.querySelector('[data-testid="usage-anthropic-acct-0-session-pace"]')
    expect(paceCell?.textContent).toContain('1.5×')
    expect(paceCell?.textContent).toContain('faster')
    root.unmount()
  })

  it('labels the window from the LENGTH the provider reported', async () => {
    // Not a hardcoded "5-hour window": Codex has already changed regime once, and a
    // fixed label would name the wrong window with complete confidence.
    const { container, root } = await mount(() =>
      pool(window_({ window_ms: 10_080 * MINUTE }), null),
    )
    expect(
      container.querySelector('[data-testid="usage-anthropic-acct-0-session"]')?.textContent,
    ).toContain('7d window')
    root.unmount()
  })

  it('colours the fill from the SHARED thresholds, not a local guess', async () => {
    // 0.75 is nominal, 0.9 is warning, 0.97 is critical — the same boundaries the
    // 2px divider meter uses, so the card and the hairline cannot disagree.
    const { container, root } = await mount(() =>
      pool(window_({ fraction: 0.9, exhausts_at: null }), null),
    )
    expect(
      container
        .querySelector('[data-testid="usage-anthropic-acct-0-session-fill"]')
        ?.getAttribute('data-band'),
    ).toBe('warning')
    root.unmount()
  })

  it('OMITS the projection row when there is no projection', async () => {
    // The common, good case. A permanently-present "Caps out in —" would read as a
    // failed computation and train the owner to ignore the row that matters.
    const { container, root } = await mount(() =>
      pool(window_({ pace: 0.4, exhausts_at: null }), null),
    )
    expect(
      container.querySelector('[data-testid="usage-anthropic-acct-0-session-exhausts"]'),
    ).toBeNull()
    expect(container.textContent).not.toContain('Caps out in')
    root.unmount()
  })

  it('SHOWS the projection row when the window is on track to run out', async () => {
    // Pace and the countdown BOTH ship: this row answers "when do I hit the cap",
    // the row above it answers "when does capacity come back".
    const { container, root } = await mount(() => pool(SESSION_HOT, null))
    expect(
      container.querySelector('[data-testid="usage-anthropic-acct-0-session-exhausts"]'),
    ).not.toBeNull()
    root.unmount()
  })

  it('renders a null pace as a dash with no reading beside it', async () => {
    const { container, root } = await mount(() =>
      pool(window_({ pace: null, exhausts_at: null }), null),
    )
    const paceCell = container.querySelector('[data-testid="usage-anthropic-acct-0-session-pace"]')
    expect(paceCell?.textContent?.trim()).toBe('—')
    root.unmount()
  })

  it('says a window was not reported rather than drawing an empty track', async () => {
    const { container, root } = await mount(() => pool(SESSION_HOT, null))
    expect(
      container.querySelector('[data-testid="usage-anthropic-acct-0-weekly-none"]')?.textContent,
    ).toBe('not reported')
    // No bar at all for that window — an empty coloured track is the specific claim
    // "0% used", which nothing measured.
    expect(
      container.querySelector('[data-testid="usage-anthropic-acct-0-weekly-fill"]'),
    ).toBeNull()
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
      anon.container.querySelector('[data-testid="usage-anthropic-acct-0-name"]')?.textContent,
    ).toBe('active credential')
    anon.root.unmount()

    const named = await mount(() => pool(SESSION_HOT, null, 'acct-2'))
    expect(
      named.container.querySelector('[data-testid="usage-anthropic-acct-0-name"]')?.textContent,
    ).toBe('acct-2')
    named.root.unmount()
  })
})

describe('when capacity comes back — the line the owner reads first', () => {
  it('says how many accounts are free right now', async () => {
    const { container, root } = await mount(() => json({ pools: [poolOf()] }))
    expect(
      container.querySelector('[data-testid="usage-anthropic-capacity"]')?.textContent,
    ).toBe('1 available now')
    root.unmount()
  })

  it('counts down to the BINDING window, and names what still constrains it', async () => {
    // The defect in a bare countdown: the 5-hour window resets in 17 minutes, but
    // the 7-day window is 97% spent, so almost nothing comes back at that reset. A
    // line that said "next capacity in 17m" would be an instruction to push
    // concurrency into a wall.
    const cooling = account({
      account_label: 'owner-a',
      session: window_({ fraction: 0.98, reset_at: NOW + 17 * MINUTE }),
      weekly: window_({ window_ms: 7 * DAY, fraction: 0.97, reset_at: NOW + 3 * DAY }),
    })
    const { container, root } = await mount(() =>
      json({ pools: [poolOf({ accounts: [cooling] })] }),
    )
    const line = container.querySelector('[data-testid="usage-anthropic-capacity"]')?.textContent
    expect(line).toContain('Next capacity in')
    expect(line).toContain('7d window')
    expect(line).toContain('5h window 98% used')
    // And NOT the soonest reset, which is the mutant.
    expect(line).not.toContain('17m')
    root.unmount()
  })

  it('renders an ABSENT reset instant as "unknown" — never "now", never blank', async () => {
    // THE MUTATION TEST. Turning a missing instant into availability is the failure
    // that sends the owner to raise concurrency into a wall.
    const unknown = account({
      account_label: 'owner-a',
      session: window_({ fraction: 0.99, reset_at: null, pace: null, exhausts_at: null }),
      weekly: null,
    })
    const { container, root } = await mount(() =>
      json({ pools: [poolOf({ accounts: [unknown] })] }),
    )
    expect(
      container.querySelector('[data-testid="usage-anthropic-acct-0-session-resets"]')?.textContent,
    ).toBe('unknown')
    expect(
      container.querySelector('[data-testid="usage-anthropic-acct-0-capacity"]')?.textContent,
    ).toBe('capacity unknown')
    expect(
      container.querySelector('[data-testid="usage-anthropic-capacity"]')?.textContent,
    ).toContain('unknown')
    expect(container.textContent).not.toContain('available now')
    root.unmount()
  })

  it('an already-passed reset reads "available now" — the one case where now is true', async () => {
    const { container, root } = await mount(() =>
      pool(window_({ reset_at: NOW - MINUTE, exhausts_at: null, pace: null }), null),
    )
    expect(
      container.querySelector('[data-testid="usage-anthropic-acct-0-session-resets"]')?.textContent,
    ).toBe('available now')
    root.unmount()
  })
})

describe('staleness is shown, never hidden', () => {
  it('floors a stale reading with a ≥ and shows its age', async () => {
    // Nothing in this payload says "stale" — the reading is simply three hours old,
    // and the card works that out against its own clock. That is the whole fix: a
    // server that said "fresh" three hours ago cannot keep being believed.
    const stale = account({
      account_label: 'owner-a',
      // Deliberately OFF the minute boundary: ages round UP (the pessimistic
      // direction, like every other duration here), so a fixture sitting exactly on
      // a minute would render one way or the other depending on how many
      // milliseconds the render took.
      measured_at: NOW - (3 * HOUR + 30_000),
      session: window_({
        fraction: 0.43,
        reset_at: NOW + 2 * HOUR,
        pace: null,
        exhausts_at: null,
      }),
      weekly: null,
    })
    const { container, root } = await mount(() => json({ pools: [poolOf({ accounts: [stale] })] }))
    // The last known value, marked as a lower bound — never blanked, never
    // extrapolated, and never a zero.
    expect(
      container.querySelector('[data-testid="usage-anthropic-acct-0-session-pct"]')?.textContent,
    ).toBe('≥ 43%')
    expect(
      container.querySelector('[data-testid="usage-anthropic-acct-0-age"]')?.textContent,
    ).toBe('3h 01m ago')
    root.unmount()
  })

  it('a pool with no samples says WHY, and draws nothing', async () => {
    // Codex until its harvest lands: "not connected" rather than a row of zeros,
    // which would read as a connected account that has used nothing.
    const { container, root } = await mount(() =>
      json({
        pools: [
          {
            pool: 'codex',
            connection: 'not_connected',
            measured_at: null,
            stale_after_ms: 30 * MINUTE,
            accounts: [],
          },
        ],
      }),
    )
    expect(container.querySelector('[data-testid="usage-codex-empty"]')?.textContent).toBe(
      'Not connected.',
    )
    expect(container.querySelector('[data-testid="usage-codex-acct-0-session-fill"]')).toBeNull()
    // And no capacity line: there is no standing to report, so the card does not
    // print one beside the sentence that explains the absence.
    expect(container.querySelector('[data-testid="usage-codex-capacity"]')).toBeNull()
    expect(container.querySelector('[data-testid="usage-codex-age"]')?.textContent).toBe(
      'never measured',
    )
    root.unmount()
  })

  it('renders EVERY pool, each in its own card', async () => {
    const { container, root } = await mount(() =>
      json({
        pools: [
          poolOf(),
          poolOf({ pool: 'kimi', accounts: [account({ account_label: null })] }),
        ],
      }),
    )
    expect(container.querySelector('[data-testid="usage-anthropic-title"]')?.textContent).toBe(
      'Anthropic',
    )
    // The Kimi endpoint is account-wide, and the title says so rather than
    // implying a per-key reading the provider does not offer.
    expect(container.querySelector('[data-testid="usage-kimi-title"]')?.textContent).toBe(
      'Kimi (account-wide)',
    )
    root.unmount()
  })
})

describe('every class the card emits is actually styled', () => {
  it('has a rule in chat-react.html for each cset-usage-* class', async () => {
    // The `var(--hairline)` shape: a class that renders, is correct, and has no
    // paint behind it. Tree-shaped assertions cannot see that, so this reads the
    // stylesheet the page actually serves.
    const css = await Bun.file(new URL('../../chat-react.html', import.meta.url)).text()
    const tsx = await Bun.file(new URL('../SettingsTab.tsx', import.meta.url)).text()
    const emitted = new Set([...tsx.matchAll(/cset-usage-[a-z-]+/g)].map((m) => m[0]))
    // A positive control: if the scrape found nothing, the assertion below would
    // pass vacuously and prove the tool broken rather than the CSS present.
    expect(emitted.size).toBeGreaterThan(4)
    const unstyled = [...emitted].filter((cls) => !css.includes(`.${cls}`))
    expect(unstyled).toEqual([])
  })
})
