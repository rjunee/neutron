/**
 * THE WEB HALF of the per-step build settings — driven the way the owner drives it.
 *
 * WHY THE RENDER IS THE POINT NOW. This file used to assert the SettingsTab section
 * from its SOURCE, on the grounds that mounting the tab meant standing up five other
 * clients. That was a real cost and it bought a weak test: a source check cannot tell
 * a rendered-and-wired dropdown from a rendered-and-inert one, and "the table exists"
 * is not the claim worth making. The tab already has a fetch seam
 * (`settings-tab-voice-transcription.test.tsx` uses it), so the controls are pressed
 * here for real and the assertions are on the TEXT THE OWNER READS.
 *
 * THE FOUR THINGS A READER SHOULD CHECK, in order of how badly each fails silently:
 *   1. changing a row's model and saving PUTs that choice (a pane whose save nothing
 *      reads is this repo's most repeated defect);
 *   2. a tier this install cannot run is VISIBLE and disabled WITH THE REASON, never
 *      dropped from the list;
 *   3. a stored value that no longer resolves is shown struck through, naming what is
 *      running instead;
 *   4. a step whose effort is the CLI's own says so instead of offering a control that
 *      changes nothing.
 *
 * THE CROSS-CLIENT PARITY TEST LIVES IN `gateway/__tests__`, not here: `landing` does
 * not depend on `@neutronai/app` and must not start — that independence is the whole
 * reason the two client helpers are duplicated.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
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
  WebPhaseModelsClient,
  applyRowEdit,
  effectiveRow,
  effortSettable,
  rejectedModel,
  tierChoices,
} = await import('../phase-models-client.ts')

/** The build row — the one with TWO executors, Claude by default and codex. */
const BUILD = {
  key: 'build',
  label: 'Build',
  description: 'Writes the code and the tests.',
  group: 'claude',
  groups: ['claude', 'codex'],
  effort_supported: true,
  default: { model: 'opus', effort: 'high' },
}

/** A Claude-ONLY row, so "wrong executor" and "no credential" can be told apart. */
const RUBRIC = {
  key: 'review_rubric',
  label: 'Rubric review',
  description: 'Reviews the diff against the fixed criteria.',
  group: 'claude',
  groups: ['claude'],
  effort_supported: true,
  default: { model: 'opus', effort: 'high' },
}

/** The codex row: a different executor, and no effort control of its own. */
const CODEX = {
  key: 'review_codex',
  label: 'Cross-model review (Codex)',
  description: 'A second opinion from a GPT model, run through the Codex CLI.',
  group: 'codex',
  groups: ['none', 'claude', 'codex', 'kimi'],
  effort_supported: false,
  default: { model: 'sol', effort: 'high' },
}

/** Two Claude tiers and three Codex tiers, one of which this install cannot run. */
const TIERS = [
  {
    tier: 'opus',
    provider: 'anthropic',
    model_id: 'claude-opus-5',
    group: 'claude',
    effort_supported: true,
    available: true,
    unavailable_reason: null,
  },
  {
    tier: 'fast',
    provider: 'anthropic',
    model_id: 'claude-haiku-4-5',
    group: 'claude',
    effort_supported: true,
    available: true,
    unavailable_reason: null,
  },
  {
    tier: 'sol',
    provider: 'openai',
    model_id: 'gpt-5.6-sol',
    group: 'codex',
    effort_supported: false,
    available: true,
    unavailable_reason: null,
  },
  {
    tier: 'terra',
    provider: 'openai',
    model_id: 'gpt-5.6-terra',
    group: 'codex',
    effort_supported: false,
    available: true,
    unavailable_reason: null,
  },
  {
    // UNAVAILABLE on purpose: this install has no codex credential (or no CLI), which
    // is a different answer from "this step cannot reach codex" and must read as one.
    tier: 'luna',
    provider: 'openai',
    model_id: 'gpt-5.6-luna',
    group: 'codex',
    effort_supported: false,
    available: false,
    unavailable_reason: 'needs a Codex connection',
  },
  {
    // THE THIRD EXECUTOR, untouched by this lane and kept in the fixture so the
    // greying rule is still exercised against a group no row here can reach.
    tier: 'k3',
    provider: 'moonshot',
    model_id: 'kimi-k3',
    group: 'kimi',
    effort_supported: false,
    available: false,
    unavailable_reason: 'needs a Kimi key',
  },
]

function payload(
  overrides: Record<string, unknown> = {},
  rejected: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    phases: [BUILD, CODEX, RUBRIC],
    model_tiers: TIERS,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaults: {
      build: { model: 'opus', effort: 'high' },
      review_codex: { model: 'sol', effort: 'high' },
      review_rubric: { model: 'opus', effort: 'high' },
    },
    overrides,
    rejected,
  }
}

interface Sent {
  method: string
  body: unknown
}
let sent: Sent[] = []
beforeEach(() => {
  sent = []
})

function client(opts: { fail?: { status: number; body: unknown }; get?: unknown } = {}) {
  return new WebPhaseModelsClient({
    base_url: 'https://owner.example.com',
    token: 't',
    fetchImpl: async (_input: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? 'GET'
      let body: unknown = null
      if (typeof init?.body === 'string') body = JSON.parse(init.body)
      sent.push({ method, body })
      const json = (v: unknown, status = 200): Response =>
        new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
      if (method === 'PUT') {
        if (opts.fail !== undefined) return json(opts.fail.body, opts.fail.status)
        const over = (body as { overrides?: Record<string, unknown> })?.overrides ?? {}
        return json(payload(over))
      }
      return json(opts.get ?? payload())
    },
  })
}

describe('the web client talks to the same endpoint', () => {
  it('GETs the payload', async () => {
    const p = await client().load()
    expect(p.phases[0]!.key).toBe('build')
    expect(p.efforts).toContain('xhigh')
    expect(sent[0]!.method).toBe('GET')
  })

  it('PUTs the complete override set under `overrides`', async () => {
    await client().save({ build: { effort: 'xhigh' } })
    const put = sent.find((s) => s.method === 'PUT')
    // The key matters: the server rejects a body without it rather than reading the
    // absence as "clear everything".
    expect(put!.body).toEqual({ overrides: { build: { effort: 'xhigh' } } })
  })

  it("throws with the SERVER'S message on a rejected save, naming every fault", async () => {
    const c = client({
      fail: {
        status: 400,
        body: {
          code: 'invalid_phase_models',
          message: "phase 'build': 'effort' must be one of: low, medium, high, xhigh, max; unknown phase 'nope'",
        },
      },
    })
    let message = ''
    try {
      await c.save({ build: { effort: 'ultra' } })
    } catch (err) {
      message = err instanceof Error ? err.message : ''
    }
    // Shown verbatim by the caller: the owner is the only one who can fix a bad
    // value, and a generic "save failed" hides which row was wrong.
    expect(message).toContain('xhigh')
    expect(message).toContain("unknown phase 'nope'")
  })

  it('reports a network failure as a NAMED error, not a raw TypeError', async () => {
    const c = new WebPhaseModelsClient({
      base_url: 'https://owner.example.com',
      token: 't',
      fetchImpl: async () => {
        throw new Error('connection refused')
      },
    })
    let code = ''
    try {
      await c.load()
    } catch (err) {
      code = (err as { code?: string }).code ?? ''
    }
    expect(code).toBe('network')
  })
})

describe('the display + edit rules', () => {
  it('shows the default when there is no override, and says it is not one', () => {
    const row = effectiveRow(BUILD, {})
    expect(row).toEqual({ model: 'opus', effort: 'high', overridden: false })
  })

  it('shows an override and marks it', () => {
    const row = effectiveRow(BUILD, { build: { effort: 'xhigh' } })
    // The un-overridden half still falls back to the default.
    expect(row).toEqual({ model: 'opus', effort: 'xhigh', overridden: true })
  })

  it('CHOOSING THE DEFAULT CLEARS the override rather than pinning it', () => {
    // Storing `opus` for a phase already defaulting to `opus` would freeze it
    // against a future change to that default — the owner would have pinned
    // something they only meant to leave alone.
    const after = applyRowEdit({ build: { model: 'sonnet' } }, BUILD, { model: 'opus' }, TIERS)
    expect(after).toEqual({})
  })

  it('keeps the other half of a partly-overridden phase', () => {
    const after = applyRowEdit({ build: { model: 'sonnet', effort: 'max' } }, BUILD, {
      model: 'opus',
    }, TIERS)
    expect(after).toEqual({ build: { effort: 'max' } })
  })

  it('leaves other phases untouched', () => {
    const after = applyRowEdit({ synthesis: { model: 'opus' } }, BUILD, { effort: 'low' }, TIERS)
    expect(after).toEqual({ synthesis: { model: 'opus' }, build: { effort: 'low' } })
  })

  it('offers every tier, disabling the ones this row cannot use — with the reason', () => {
    const choices = tierChoices(CODEX, TIERS)
    expect(choices).toHaveLength(TIERS.length)
    expect(choices.find((c) => c.tier === 'terra')!.selectable).toBe(true)
    expect(choices.find((c) => c.tier === 'opus')!.selectable).toBe(true)
    expect(rejectedModel(BUILD, { build: { model: 'gone-tier' } })).toBe('gone-tier')
  })

  it('the BUILD row can be moved to a codex tier — the executor it is now wired to', () => {
    const choices = tierChoices(BUILD, TIERS)
    expect(choices.find((c) => c.tier === 'sol')!.selectable).toBe(true)
    expect(choices.find((c) => c.tier === 'terra')!.selectable).toBe(true)
    // The Claude default is still there.
    expect(choices.find((c) => c.tier === 'opus')!.selectable).toBe(true)
    // A codex tier this install cannot RUN is unpickable for a different reason, and
    // says so — "go connect codex" is actionable, "wrong executor" would not be.
    expect(choices.find((c) => c.tier === 'luna')!.selectable).toBe(false)
    expect(choices.find((c) => c.tier === 'luna')!.reason).toBe('needs a Codex connection')
    // ONLY WHAT IS WIRED. The Kimi tier on the very same row is still greyed, and for
    // the wiring reason rather than a missing key — this lane moved the build to one
    // executor, and an un-greyed option that dispatches nowhere is the worse defect.
    expect(choices.find((c) => c.tier === 'k3')!.selectable).toBe(false)
    expect(choices.find((c) => c.tier === 'k3')!.reason).toContain(
      'Kimi is not wired for this step yet',
    )
  })

  it('moving the BUILD row to codex DROPS the effort — the pair fails the save', () => {
    // The blocker this pins: the effort cell stayed live on a codex build, so the
    // stale value was merged into the PUT and the server refused the WHOLE payload —
    // every other row's pending edit with it. The cell is answered by the chosen tier
    // now, and the edit clears what that tier cannot use.
    expect(effortSettable(BUILD, 'opus', TIERS)).toBe(true)
    expect(effortSettable(BUILD, 'sol', TIERS)).toBe(false)
    expect(applyRowEdit({ build: { effort: 'max' } }, BUILD, { model: 'sol' }, TIERS)).toEqual({
      build: { model: 'sol' },
    })
    // …and moving back restores it, so this is a live rule and not a one-way door.
    expect(applyRowEdit({ build: { model: 'sol' } }, BUILD, { model: 'fast', effort: 'max' }, TIERS)).toEqual(
      { build: { model: 'fast', effort: 'max' } },
    )
  })
})

// ── The real thing: the tab, mounted, with its controls pressed ───────────────

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

const tick = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0))
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Mount the whole Settings tab with every OTHER surface answered emptily. */
async function mountTab(
  get: Record<string, unknown>,
  put?: { status: number; body: unknown },
): Promise<{
  container: HTMLElement
  act: typeof import('react').act
  puts: Array<Record<string, unknown>>
  unmount: () => Promise<void>
}> {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const React = await import('react')
  const { SettingsTab } = await import('../SettingsTab.tsx')

  const puts: Array<Record<string, unknown>> = []
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    if (url.includes('/api/app/trident/phase-models')) {
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { overrides: Record<string, unknown> }
        puts.push(body.overrides)
        if (put !== undefined) return json(put.body, put.status)
        return json({ ...get, overrides: body.overrides })
      }
      return json(get)
    }
    if (url.endsWith('/api/app/projects/acme/credentials')) return json({ ok: true, project: [], global: [] })
    if (url.endsWith('/api/app/projects/acme/accounts')) {
      return json({ ok: true, project_id: 'acme', services: [] })
    }
    if (url.endsWith('/api/app/projects/acme/settings')) {
      return json({ ok: true, project: { name: 'Acme', emoji: '🏢', members: [] } })
    }
    return json({ ok: false, code: 'not_stubbed' }, 404)
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
  // Unmount inside `act` as well: the tab fires several other settings reads on
  // mount, and tearing down mid-flight is what produces the "update was not wrapped
  // in act" noise that hides a real warning.
  return {
    container,
    act,
    puts,
    unmount: async (): Promise<void> => {
      await act(async () => {
        root.unmount()
        await tick()
      })
      container.remove()
    },
  }
}

const testId = (c: HTMLElement, id: string): HTMLElement | null =>
  c.querySelector(`[data-testid="${id}"]`)

describe('the TABLE, pressed for real', () => {
  it('shows one row per step, each still explaining what it does', async () => {
    const { container, unmount } = await mountTab(payload())
    try {
      expect(testId(container, 'phase-build')).not.toBeNull()
      expect(testId(container, 'phase-review_codex')).not.toBeNull()
      // The one-line explanation is the only thing telling the owner what the step
      // is. A table that dropped it would be a grid of nouns.
      expect(testId(container, 'phase-review_codex')!.textContent).toContain(
        'A second opinion from a GPT model',
      )
    } finally {
      await unmount()
    }
  })

  it('names the model each tier resolves to, right there in the control', async () => {
    const { container, unmount } = await mountTab(payload())
    try {
      const select = testId(container, 'phase-build-model') as HTMLSelectElement
      const selected = select.options[select.selectedIndex]!
      // The owner picks a TIER; what they need to know is which model that is today.
      expect(selected.textContent).toContain('opus')
      expect(selected.textContent).toContain('claude-opus-5')
      expect(selected.textContent).toContain('(default)')
    } finally {
      await unmount()
    }
  })

  it('CHANGING A ROW AND SAVING sends that choice to the server', async () => {
    const { container, act, puts, unmount } = await mountTab(payload())
    try {
      const select = testId(container, 'phase-review_codex-model') as HTMLSelectElement
      await act(async () => {
        select.value = 'terra'
        select.dispatchEvent(new Event('change', { bubbles: true }))
        await tick()
      })
      // The row admits it is no longer on the default.
      expect(testId(container, 'phase-review_codex-changed')).not.toBeNull()
      await act(async () => {
        ;(testId(container, 'phase-models-save') as HTMLButtonElement).click()
        await tick()
      })
      // THE ASSERTION THAT MATTERS: the choice left the browser.
      expect(puts).toEqual([{ review_codex: { model: 'terra' } }])
      expect(testId(container, 'phase-models-saved')!.textContent).toContain('Saved')
    } finally {
      await unmount()
    }
  })

  it('shows a tier it cannot run DISABLED, with the reason, never hidden', async () => {
    const { container, unmount } = await mountTab(payload())
    try {
      const option = testId(container, 'phase-review_codex-model-luna') as HTMLOptionElement
      // Present…
      expect(option).not.toBeNull()
      // …unpickable…
      expect(option.disabled).toBe(true)
      // …and it SAYS WHY. A greyed row with no explanation is a dead end; this one
      // tells the owner what to go and fix.
      expect(option.textContent).toContain('needs a Codex connection')
      // The OTHER kind of greying, on a step that cannot reach the executor at all.
      const rubric = testId(container, 'phase-review_rubric-model-sol') as HTMLOptionElement
      expect(rubric.disabled).toBe(true)
      expect(rubric.textContent).toContain('Codex is not wired for this step yet')
    } finally {
      await unmount()
    }
  })

  it('says a CLI step has no effort control instead of offering an inert one', async () => {
    const { container, unmount } = await mountTab(payload())
    try {
      expect(testId(container, 'phase-review_codex-effort')).toBeNull()
      expect(testId(container, 'phase-review_codex-effort-na')!.textContent).toContain(
        'set by the CLI',
      )
      // The Claude row still has its real control.
      expect(testId(container, 'phase-build-effort')).not.toBeNull()
    } finally {
      await unmount()
    }
  })

  it('shows a REFUSED stored value struck through, and what is running instead', async () => {
    const { container, unmount } = await mountTab(payload({}, { build: { model: 'fable-2' } }))
    try {
      const stale = testId(container, 'phase-build-stale')!
      expect(stale.textContent).toContain('fable-2')
      expect(stale.textContent).toContain('no longer available')
      // Named, so "what am I actually running" needs no second screen.
      expect(stale.textContent).toContain('opus')
      expect(stale.querySelector('s')?.textContent).toBe('fable-2')
    } finally {
      await unmount()
    }
  })

  it('KEEPS the edit when the server rejects the save, and shows the message', async () => {
    const { container, act, unmount } = await mountTab(payload(), {
      status: 400,
      body: { code: 'invalid_phase_models', message: "phase 'build': 'effort' is not settable" },
    })
    try {
      const select = testId(container, 'phase-build-effort') as HTMLSelectElement
      await act(async () => {
        select.value = 'max'
        select.dispatchEvent(new Event('change', { bubbles: true }))
        await tick()
      })
      await act(async () => {
        ;(testId(container, 'phase-models-save') as HTMLButtonElement).click()
        await tick()
      })
      // Discarding the edit would punish the owner for one bad value; the banner
      // carries the server's own words so they can fix the right row.
      expect(testId(container, 'phase-models-error')!.textContent).toContain('not settable')
      expect((testId(container, 'phase-build-effort') as HTMLSelectElement).value).toBe('max')
    } finally {
      await unmount()
    }
  })

  it('labels the section as install-wide, because the storage has no project', async () => {
    const { container, unmount } = await mountTab(payload())
    try {
      const section = container.querySelector('section[aria-label="Code generation"]')!
      // The pane sits in project settings while the setting applies everywhere. An
      // honest label is the fix that does not pretend to a per-project dimension the
      // storage does not have.
      expect(section.textContent).toContain('every project on this')
    } finally {
      await unmount()
    }
  })
})
