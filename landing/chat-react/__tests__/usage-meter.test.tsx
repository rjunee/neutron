/**
 * The web usage meter, rendered.
 *
 * The assertions that matter are about what the bar CLAIMS. An unavailable
 * reading must produce no fill element at all — not a zero-width one, which
 * would render identically to "0% used" and would announce itself to a screen
 * reader as a progressbar at 0. And the colour class must change as ONE unit at
 * each threshold, because a partly-recoloured bar is a different (and wrong)
 * picture: the whole line reports one number.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://box.example.com/chat' })
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function render(usage: import('../usage-client.ts').UsagePayload): Promise<HTMLElement> {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { UsageMeter } = await import('../UsageMeter.tsx')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<UsageMeter usage={usage} />)
  })
  return host
}

function lines(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll('.car-usage-line')) as HTMLElement[]
}

function available(session: number, weekly: number): import('../usage-client.ts').UsagePayload {
  return { available: true, session, weekly, measured_at: 1 }
}

describe('UsageMeter', () => {
  it('is two lines — session over weekly — in that order', async () => {
    const host = await render(available(0.1, 0.9))
    const rows = lines(host)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.getAttribute('aria-label')).toBe('Session usage (5 hours)')
    expect(rows[1]?.getAttribute('aria-label')).toBe('Weekly usage (7 days)')
  })

  it('draws NO fill when there is nothing measured — a bare divider, not a 0% bar', async () => {
    const host = await render({ available: false, reason: 'no_credential' })
    expect(lines(host)).toHaveLength(2)
    expect(host.querySelectorAll('.car-usage-fill')).toHaveLength(0)
    // Nothing to announce: no progressbar role at all.
    expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(0)
  })

  it('recolours the WHOLE fill at each threshold', async () => {
    const cases: ReadonlyArray<[number, string]> = [
      [0.0, 'car-usage-nominal'],
      [0.5, 'car-usage-nominal'],
      [0.8499, 'car-usage-nominal'],
      [0.85, 'car-usage-warning'],
      [0.94, 'car-usage-warning'],
      [0.95, 'car-usage-critical'],
      [1, 'car-usage-critical'],
    ]
    for (const [fraction, expected] of cases) {
      const host = await render(available(fraction, 0))
      const fill = host.querySelector('.car-usage-fill') as HTMLElement
      expect(`${fraction} → ${fill.className}`).toBe(`${fraction} → car-usage-fill ${expected}`)
    }
  })

  it('sizes the fill from the left as a percentage of the line', async () => {
    const host = await render(available(0.42, 0.07))
    const fills = Array.from(host.querySelectorAll('.car-usage-fill')) as HTMLElement[]
    expect(fills[0]?.style.width).toContain('42.00%')
    expect(fills[1]?.style.width).toContain('7.00%')
  })

  it('renders a fill element even at zero, so "barely used" is not "unknown"', async () => {
    // The visible floor is `.car-usage-fill { min-width: 2px }` in the sheet; what
    // matters here is that an AVAILABLE reading always produces the element,
    // which the unavailable case above proves it never does.
    const host = await render(available(0, 0))
    expect(host.querySelectorAll('.car-usage-fill')).toHaveLength(2)
  })

  it('clamps a blown-through window instead of overflowing the track', async () => {
    const host = await render(available(1.4, 0.5))
    const fill = host.querySelector('.car-usage-fill') as HTMLElement
    expect(fill.style.width).toBe('100.00%')
    expect(fill.className).toContain('car-usage-critical')
  })
})
