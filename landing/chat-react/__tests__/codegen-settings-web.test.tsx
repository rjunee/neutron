/**
 * THE WEB HALF of the per-phase build settings — and the guard that keeps it and the
 * phone telling the owner the same thing.
 *
 * WHY THIS FILE EXISTS AT ALL. #163 shipped the mobile screen and named the web half
 * as deferred. Deferred work that is only named in a PR body is work that quietly
 * doesn't happen, so this closes it — and the most valuable test here is not about
 * rendering, it is the CROSS-CLIENT one at the bottom.
 *
 * THE TWO PURE HELPERS ARE PRODUCT DECISIONS, NOT TRANSPORT. `effectiveRow` and
 * `applyRowEdit` are duplicated across `app/lib/phase-models-client.ts` and
 * `landing/chat-react/phase-models-client.ts`, because each bundle is deliberately
 * free of the other's workspace. Duplicated decisions drift, and a drift would mean
 * the same owner gets two different answers about their own settings depending on
 * which device they opened.
 *
 * THE CROSS-CLIENT PARITY TEST THEREFORE LIVES IN `gateway/__tests__`, not here.
 * `landing` does not depend on `@neutronai/app` and must not start — that
 * independence is the whole reason the helpers are duplicated. `gateway` is the one
 * package declaring both, which is the same home the existing `doc-links` mirror
 * parity test uses for the same reason.
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

const { WebPhaseModelsClient, applyRowEdit, effectiveRow } = await import(
  '../phase-models-client.ts'
)

const BUILD = {
  key: 'build',
  label: 'Build',
  description: 'Writes the code and the tests.',
  default: { model: 'opus', effort: 'high' },
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phases: [BUILD],
    model_tiers: ['fable', 'opus', 'sonnet', 'fast'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaults: { build: { model: 'opus', effort: 'high' } },
    overrides,
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
    const after = applyRowEdit({ build: { model: 'sonnet' } }, BUILD, { model: 'opus' })
    expect(after).toEqual({})
  })

  it('keeps the other half of a partly-overridden phase', () => {
    const after = applyRowEdit({ build: { model: 'sonnet', effort: 'max' } }, BUILD, {
      model: 'opus',
    })
    expect(after).toEqual({ build: { effort: 'max' } })
  })

  it('leaves other phases untouched', () => {
    const after = applyRowEdit({ synthesis: { model: 'opus' } }, BUILD, { effort: 'low' })
    expect(after).toEqual({ synthesis: { model: 'opus' }, build: { effort: 'low' } })
  })
})

describe('the SettingsTab section behaves like the phone on a rejected save', () => {
  /**
   * A SOURCE assertion, and it is the weaker of the two kinds — said plainly because
   * a mutation pass caught this gap rather than a reading of the code did. The mobile
   * screen has the real behavioural test (press the chip, fail the save, check the
   * edits survive); rendering `SettingsTab` here would mean standing up five other
   * clients it constructs on mount, for one branch.
   *
   * So this pins the two properties the mutant broke, scoped to the save handler:
   * the catch must NOT reset the overrides, and it must use the error's own message.
   * If this file ever grows a full shell render, delete this in favour of a press.
   */
  it('the save catch keeps the edits and surfaces the server message', async () => {
    const src = await Bun.file(new URL('../SettingsTab.tsx', import.meta.url)).text()
    const code = src
      .split('\n')
      .filter((line) => {
        const t = line.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    // Scoped to the handler, not the file: an unscoped match would pass on any of
    // the five other `.catch` blocks in this component.
    const start = code.indexOf('const savePhaseModels =')
    expect(start).toBeGreaterThan(-1)
    const handler = code.slice(start, code.indexOf('\n  }, [phaseModelsClient', start))
    expect(handler.includes('setPhaseOverrides({})')).toBe(false)
    expect(handler.includes('err instanceof Error ? err.message')).toBe(true)
  })

  it('the section is actually rendered, with a save control', async () => {
    // The other half: a handler nothing can reach is the built-but-never-wired shape.
    const src = await Bun.file(new URL('../SettingsTab.tsx', import.meta.url)).text()
    expect(src.includes('aria-label="Code generation"')).toBe(true)
    expect(src.includes('data-testid="phase-models-save"')).toBe(true)
    expect(src.includes('onClick={savePhaseModels}')).toBe(true)
  })
})
