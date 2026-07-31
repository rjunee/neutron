/**
 * ACTIVITY INSPECTOR panel + the CLICKABLE DOT — the web acceptance, in a DOM.
 *
 * What the SPEC's acceptance actually asks for, asserted here:
 *   - clicking the per-project activity dot OPENS the panel (and does NOT also
 *     navigate — the dot lives inside the row's own button);
 *   - the dot is clickable when IDLE, so idle is distinguishable from wedged;
 *   - while a turn runs the panel visibly TICKS (a live row appends);
 *   - a WEDGED session shows the stream stopped AND how long ago the last event was.
 *
 * The panel is driven through an injected source, so there is no socket and no fetch
 * here — the transport itself is covered by `activity-inspector-served.test.ts`
 * (real composer, real HTTP) and `activity-client.test.ts` (wire parsing).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

import type { ActivityRow, ActivitySnapshot } from '../activity-client.ts'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://sam.neutron.test/chat?client=react' })
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
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function snapshot(over: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return {
    scope_key: 'p1',
    events: [],
    state: 'working',
    last_event_age_ms: 1_000,
    last_real_activity_age_ms: 1_000,
    now: Date.now(),
    turn_in_flight: true,
    ...over,
  }
}

/** An injectable source that records subscribe/fetch ORDER and lets a test push rows. */
function makeSource(snap: ActivitySnapshot) {
  const order: string[] = []
  let push: ((scope: string, row: ActivityRow) => void) | null = null
  return {
    order,
    emit: (scope: string, row: ActivityRow): void => push?.(scope, row),
    source: {
      snapshot: async (): Promise<ActivitySnapshot> => {
        order.push('fetch')
        return snap
      },
      onActivityEvent: (fn: (scope: string, row: ActivityRow) => void): (() => void) => {
        order.push('subscribe')
        push = fn
        return () => {
          push = null
          order.push('unsubscribe')
        }
      },
    },
  }
}

async function renderPanel(opts: {
  snap: ActivitySnapshot
  projectId?: string | null
  open?: boolean
}) {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const React = await import('react')
  const { ActivityInspectorPanel } = await import('../ActivityInspectorPanel.tsx')
  const harness = makeSource(opts.snap)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const onClose = { calls: 0 }
  await act(async () => {
    root.render(
      React.createElement(ActivityInspectorPanel, {
        source: harness.source,
        projectId: opts.projectId ?? 'p1',
        label: 'Neutron',
        open: opts.open ?? true,
        onClose: () => {
          onClose.calls += 1
        },
      }),
    )
  })
  return {
    container,
    harness,
    onClose,
    act,
    cleanup: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

const row = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  seq: 1,
  at: Date.now(),
  kind: 'tool_start',
  label: 'Bash',
  ...over,
})

describe('ActivityInspectorPanel', () => {
  it('SUBSCRIBES before it FETCHES, so no row is lost in the gap', async () => {
    // If this order ever flips, a row landing between the HTTP response and the
    // subscription vanishes — and on a barely-alive session that may be the only row.
    const { harness, cleanup } = await renderPanel({ snap: snapshot() })
    expect(harness.order[0]).toBe('subscribe')
    expect(harness.order[1]).toBe('fetch')
    await cleanup()
  })

  it('renders nothing while closed, and unsubscribes on close', async () => {
    const closed = await renderPanel({ snap: snapshot(), open: false })
    expect(closed.container.querySelector('[data-testid="activity-panel"]')).toBeNull()
    expect(closed.harness.order).toEqual([])
    await closed.cleanup()
  })

  it('TICKS: a live row for this scope appends to the list', async () => {
    const { container, harness, act, cleanup } = await renderPanel({ snap: snapshot() })
    expect(container.querySelector('[data-testid="activity-row-7"]')).toBeNull()
    await act(async () => {
      harness.emit('p1', row({ seq: 7, label: 'Read', detail: 'src/a.ts' }))
    })
    const el = container.querySelector('[data-testid="activity-row-7"]')
    expect(el).not.toBeNull()
    expect(el!.textContent).toContain('Read')
    expect(el!.textContent).toContain('src/a.ts')
    await cleanup()
  })

  it('IGNORES a sibling scope’s row (the app-ws topic is per-user)', async () => {
    const { container, harness, act, cleanup } = await renderPanel({ snap: snapshot() })
    await act(async () => {
      harness.emit('some-other-project', row({ seq: 9, label: 'Bash' }))
    })
    expect(container.querySelector('[data-testid="activity-row-9"]')).toBeNull()
    await cleanup()
  })

  it('marks a synthetic keepalive row so it never reads as work', async () => {
    const { container, harness, act, cleanup } = await renderPanel({ snap: snapshot() })
    await act(async () => {
      harness.emit('p1', row({ seq: 2, kind: 'keepalive', label: 'alive', synthetic: true }))
    })
    const el = container.querySelector('[data-testid="activity-row-2"]')
    expect(el!.className).toContain('car-actin-row-synthetic')
    await cleanup()
  })

  it('a WEDGED session shows the verdict AND how long ago the last event was', async () => {
    // The acceptance line, literally: "the panel shows the stream stopped and how
    // long ago the last event was".
    const { container, cleanup } = await renderPanel({
      snap: snapshot({
        state: 'wedged',
        // Breathing 4s ago (keepalive), but no real work for ~6 minutes.
        last_event_age_ms: 4_000,
        last_real_activity_age_ms: 366_000,
      }),
    })
    const state = container.querySelector('[data-testid="activity-state"]')!
    expect(state.textContent).toContain('Stalled')
    expect(state.className).toContain('car-actin-state-wedged')
    // Both clocks are visible, and they DISAGREE — which is the whole signal.
    expect(container.querySelector('[data-testid="activity-last-event"]')!.textContent).toContain(
      '4s ago',
    )
    expect(
      container.querySelector('[data-testid="activity-last-activity"]')!.textContent,
    ).toContain('6m 6s ago')
    await cleanup()
  })

  it('an IDLE session reads as idle, not as a hang', async () => {
    const { container, cleanup } = await renderPanel({
      snap: snapshot({ state: 'idle', turn_in_flight: false, last_event_age_ms: 9_000_000 }),
    })
    const state = container.querySelector('[data-testid="activity-state"]')!
    expect(state.textContent).toContain('Idle')
    expect(state.className).toContain('car-actin-state-idle')
    await cleanup()
  })

  it('explains itself when the buffer is empty (live-only, not an error)', async () => {
    const { container, cleanup } = await renderPanel({ snap: snapshot({ events: [] }) })
    expect(container.querySelector('[data-testid="activity-empty"]')!.textContent).toContain(
      'live-only',
    )
    await cleanup()
  })

  it('surfaces a fetch failure instead of pretending the session is idle', async () => {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const React = await import('react')
    const { ActivityInspectorPanel } = await import('../ActivityInspectorPanel.tsx')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        React.createElement(ActivityInspectorPanel, {
          source: {
            snapshot: async () => {
              throw new Error('boom-503')
            },
            onActivityEvent: () => () => {},
          },
          projectId: 'p1',
          label: 'Neutron',
          open: true,
          onClose: () => {},
        }),
      )
    })
    expect(container.querySelector('[data-testid="activity-error"]')!.textContent).toContain(
      'boom-503',
    )
    await act(async () => root.unmount())
    container.remove()
  })

  it('closes on the backdrop click and on Escape', async () => {
    const { container, onClose, act, cleanup } = await renderPanel({ snap: snapshot() })
    await act(async () => {
      ;(container.querySelector('[data-testid="activity-backdrop"]') as HTMLElement).click()
    })
    expect(onClose.calls).toBe(1)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onClose.calls).toBe(2)
    await cleanup()
  })

  it('a click INSIDE the panel does not close it', async () => {
    const { container, onClose, act, cleanup } = await renderPanel({ snap: snapshot() })
    await act(async () => {
      ;(container.querySelector('[data-testid="activity-panel"]') as HTMLElement).click()
    })
    expect(onClose.calls).toBe(0)
    await cleanup()
  })

  // ---- the transcript, not the ticker (Ryan 2026-07-30) --------------------

  it('renders an assistant message as PROSE, showing the words not a size', async () => {
    // The shipped panel rendered `reply — 29 chars`. A length is the one fact about
    // a reply that is never what you wanted to know.
    const words = 'a synthesised assistant sentence'
    const { container, cleanup } = await renderPanel({
      snap: snapshot({
        events: [row({ seq: 1, kind: 'token', label: 'assistant', detail: words })],
      }),
    })
    expect(container.querySelector('[data-testid="activity-row-text-1"]')?.textContent).toBe(words)
    expect(container.textContent).not.toContain('chars')
    // And it is marked as a message, not a tool tick.
    expect(container.querySelector('.car-actin-row-assistant')).not.toBeNull()
    await cleanup()
  })

  it('renders a HUMAN tool label and demotes the server to a qualifier', async () => {
    const { container, cleanup } = await renderPanel({
      snap: snapshot({
        events: [row({ seq: 1, kind: 'tool_start', label: 'a_tool', source: 'a-server' })],
      }),
    })
    expect(container.querySelector('[data-testid="activity-row-label-1"]')?.textContent).toBe(
      'a_tool',
    )
    expect(container.querySelector('[data-testid="activity-row-source-1"]')?.textContent).toBe(
      'a-server',
    )
    // The raw transport form must never reach the DOM as the label.
    expect(container.querySelector('[data-testid="activity-row-label-1"]')?.textContent).not.toContain(
      'mcp__',
    )
    await cleanup()
  })

  it('a row with a longer BODY expands on click and collapses again', async () => {
    const { container, act, cleanup } = await renderPanel({
      snap: snapshot({
        events: [
          row({
            seq: 1,
            kind: 'tool_end',
            label: 'a_tool',
            detail: 'one line summary',
            body: 'line one\nline two\nline three',
          }),
        ],
      }),
    })
    expect(container.querySelector('[data-testid="activity-row-body-1"]')).toBeNull()
    const target = container.querySelector('[data-testid="activity-row-1"]') as HTMLElement
    await act(async () => target.click())
    expect(container.querySelector('[data-testid="activity-row-body-1"]')?.textContent).toContain(
      'line three',
    )
    await act(async () => target.click())
    expect(container.querySelector('[data-testid="activity-row-body-1"]')).toBeNull()
    await cleanup()
  })

  it('offers NO expand affordance when the body would only repeat the detail', async () => {
    const { container, cleanup } = await renderPanel({
      snap: snapshot({
        events: [row({ seq: 1, kind: 'tool_start', label: 'a_tool', detail: 'short' })],
      }),
    })
    expect(container.querySelector('[data-testid="activity-row-more-1"]')).toBeNull()
    expect(container.querySelector('.car-actin-row-expandable')).toBeNull()
    await cleanup()
  })

  it('keeps tool rows AND assistant rows as peers in ONE chronological list', async () => {
    // "Interleaves with the actual messages the model is outputting" — the unit of
    // this view is a turn transcript, so ordering across the two sources is the
    // product, not a detail.
    const { container, cleanup } = await renderPanel({
      snap: snapshot({
        events: [
          row({ seq: 1, kind: 'turn_start', label: 'turn started' }),
          row({ seq: 2, kind: 'tool_start', label: 'a_tool', detail: 'an argument' }),
          row({ seq: 3, kind: 'tool_end', label: 'a_tool', detail: 'a returned value' }),
          row({ seq: 4, kind: 'token', label: 'assistant', detail: 'a sentence' }),
          row({ seq: 5, kind: 'completion', label: 'turn complete' }),
        ],
      }),
    })
    const seqs = [...container.querySelectorAll('[data-testid^="activity-row-"]')]
      .map((e) => e.getAttribute('data-testid'))
      .filter((t) => t !== null && /^activity-row-\d+$/.test(t))
    expect(seqs).toEqual([
      'activity-row-1',
      'activity-row-2',
      'activity-row-3',
      'activity-row-4',
      'activity-row-5',
    ])
    await cleanup()
  })
})

describe('the clickable rail dot — the inspector’s entry point', () => {
  async function renderRail(projects: Array<Record<string, unknown>>) {
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const React = await import('react')
    const { TopicRail } = await import('../ChatApp.tsx')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const opened: Array<string | null> = []
    const selected: Array<string | null> = []
    await act(async () => {
      root.render(
        React.createElement(TopicRail, {
          projects: projects as never,
          activeId: null,
          onSelect: (id: string | null) => selected.push(id),
          onCreate: async () => null,
          creating: false,
          narrow: false,
          now: new Date('2026-07-29T10:00:00'),
          onOpenActivity: (id: string | null) => opened.push(id),
        }),
      )
    })
    return {
      container,
      opened,
      selected,
      act,
      cleanup: async () => {
        await act(async () => root.unmount())
        container.remove()
      },
    }
  }

  it('clicking the dot opens the inspector for THAT project and does NOT navigate', async () => {
    // The dot sits inside the row's own <button>, so without stopPropagation a dot
    // click would ALSO switch the chat — a tap meaning two things.
    const { container, opened, selected, act, cleanup } = await renderRail([
      { id: 'p1', label: 'Neutron', emoji: '🚀', unread: 0, activity: 'working' },
    ])
    const rows = Array.from(container.querySelectorAll('.car-rail-item'))
    await act(async () => {
      ;(rows[1]!.querySelector('.car-rail-dot') as HTMLElement).click()
    })
    expect(opened).toEqual(['p1'])
    expect(selected).toEqual([])
    await cleanup()
  })

  it('the dot is clickable when IDLE — idle must be distinguishable from wedged', async () => {
    // Acceptance: "The dot stays clickable when IDLE". A dot that disappeared at rest
    // could not be clicked to find out whether the silence is idle or a hang.
    const { container, opened, act, cleanup } = await renderRail([
      { id: 'p1', label: 'Neutron', emoji: '🚀', unread: 0, activity: 'idle' },
    ])
    const rows = Array.from(container.querySelectorAll('.car-rail-item'))
    const dot = rows[1]!.querySelector('.car-rail-dot') as HTMLElement
    expect(dot).not.toBeNull()
    expect(dot.className).toContain('car-rail-dot-idle')
    await act(async () => dot.click())
    expect(opened).toEqual(['p1'])
    await cleanup()
  })

  it('General’s dot opens the General scope (null), not a project', async () => {
    const { container, opened, act, cleanup } = await renderRail([
      { id: 'p1', label: 'Neutron', emoji: '🚀', unread: 0, activity: 'idle' },
    ])
    const rows = Array.from(container.querySelectorAll('.car-rail-item'))
    await act(async () => {
      ;(rows[0]!.querySelector('.car-rail-dot') as HTMLElement).click()
    })
    expect(opened).toEqual([null])
    await cleanup()
  })

  it('is keyboard-operable (Enter / Space), not mouse-only', async () => {
    const { container, opened, selected, act, cleanup } = await renderRail([
      { id: 'p1', label: 'Neutron', emoji: '🚀', unread: 0, activity: 'attention' },
    ])
    const dot = container.querySelectorAll('.car-rail-item')[1]!.querySelector(
      '.car-rail-dot',
    ) as HTMLElement
    expect(dot.getAttribute('tabindex')).toBe('0')
    await act(async () => {
      dot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await act(async () => {
      dot.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    })
    expect(opened).toEqual(['p1', 'p1'])
    expect(selected).toEqual([])
    await cleanup()
  })

  it('clicking the ROW (not the dot) still selects the topic', async () => {
    // Regression guard for the inverse mistake: the dot must not swallow the row.
    const { container, opened, selected, act, cleanup } = await renderRail([
      { id: 'p1', label: 'Neutron', emoji: '🚀', unread: 0, activity: 'idle' },
    ])
    const name = container.querySelectorAll('.car-rail-item')[1]!.querySelector(
      '.car-rail-name',
    ) as HTMLElement
    await act(async () => name.click())
    expect(selected).toEqual(['p1'])
    expect(opened).toEqual([])
    await cleanup()
  })
})
