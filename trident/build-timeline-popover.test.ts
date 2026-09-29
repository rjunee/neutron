import { expect, test } from 'bun:test'
import { createContext, runInContext } from 'node:vm'
import { PHASE_POPOVER_SCRIPT } from './build-timeline-popover.ts'

function fixture(completedAt: number | null = new Date(2026, 8, 27, 0, 1).getTime()) {
  const handlers = new Map<string, Array<(event: any) => void>>()
  const timers = new Map<number, () => void>()
  let timerId = 0
  const dispatch = (type: string, target: Node, fields = {}) => {
    const event = { target, preventDefault() {}, stopPropagation() {}, ...fields }
    for (const handler of handlers.get(type) ?? []) handler(event)
  }
  class Node {
    dataset: Record<string, string> = {}
    attributes: Record<string, string> = {}
    children: Node[] = []
    parent: Node | null = null
    hidden = true
    className = ''
    textContent = ''
    scrollTop = 0
    style: Record<string, string> = {}
    listeners = new Map<string, () => void>()
    append(...nodes: Node[]) { for (const node of nodes) { node.parent = this; this.children.push(node) } }
    replaceChildren() { this.children = [] }
    setAttribute(key: string, value: string) { this.attributes[key] = value }
    addEventListener(type: string, handler: () => void) { this.listeners.set(type, handler) }
    contains(node: Node | null): boolean { return node === this || this.children.some(child => child.contains(node)) }
    closest(selector: string): Node | null {
      return selector === '[data-phase-info]' && this.dataset.phaseInfo ? this : this.parent?.closest(selector) ?? null
    }
    querySelector(selector: string): Node | null {
      for (const child of this.children) {
        if ('.' + child.className === selector) return child
        const nested = child.querySelector(selector)
        if (nested) return nested
      }
      return null
    }
    getBoundingClientRect() { return { left: 80, top: 411, bottom: 431, width: 120, height: 430 } }
    focus() {
      if (document.activeElement === this) return
      const previous = document.activeElement
      document.activeElement = this
      dispatch('focusout', previous, { relatedTarget: this })
      dispatch('focusin', this)
    }
  }
  const outside = new Node(), popover = new Node()
  const makeTrigger = () => {
    const trigger = new Node()
    trigger.dataset = { phaseKey: 'example:phase', phaseInfo: JSON.stringify({
      title: 'Build', duration: '5m', actions: [{ label: 'Build', duration: '5m', tokens: '100 tokens', model: 'Example model',
        startedAt: new Date(2026, 8, 26, 23, 59).getTime(), completedAt }],
    }) }
    return trigger
  }
  let trigger = makeTrigger()
  const document = { activeElement: outside, getElementById: () => popover,
    createElement: () => new Node(), querySelectorAll: () => [trigger],
    addEventListener: (type: string, handler: (event: any) => void) => {
      handlers.set(type, [...handlers.get(type) ?? [], handler])
    },
  }
  const context = createContext({ document, window: { innerWidth: 390, innerHeight: 844, addEventListener() {} },
    setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId },
    clearTimeout: (id: number) => timers.delete(id),
  })
  runInContext(PHASE_POPOVER_SCRIPT, context)
  return { trigger, outside, popover, document, dispatch,
    flushTimers() { for (const [id, fn] of [...timers]) { timers.delete(id); fn() } },
    click(target: Node) { target.listeners.get('click')?.(); dispatch('click', target) },
    state: () => runInContext('capturePhasePopover()', context),
    refresh() {
      runInContext('var saved = capturePhasePopover(); hidePhasePopover()', context)
      trigger = makeTrigger(); document.activeElement = outside
      runInContext('restorePhasePopover(saved)', context)
      return trigger
    },
  }
}

test('popover shows local 12-hour start and completion clocks across midnight, or unknown completion', () => {
  const complete = fixture(); complete.trigger.focus()
  const completeTimes = complete.popover.querySelector('.popover-action')!.children
    .filter(node => node.className === 'popover-time').map(node => node.textContent)
  expect(completeTimes[0]).toMatch(/^Started 11:59 PM · /)
  expect(completeTimes[0]).toContain('Sep 26, 2026')
  expect(completeTimes[1]).toMatch(/^Completed 12:01 AM · /)
  expect(completeTimes[1]).toContain('Sep 27, 2026')

  const unknown = fixture(null); unknown.trigger.focus()
  const unknownTimes = unknown.popover.querySelector('.popover-action')!.children
    .filter(node => node.className === 'popover-time').map(node => node.textContent)
  expect(unknownTimes[1]).toBe('Completion not recorded')
  expect(unknownTimes.join(' ')).not.toContain('In progress')
})

test('touch focus leaves the release target uncovered until the native click pins details', () => {
  const f = fixture()
  f.dispatch('pointerover', f.trigger, { pointerType: 'touch' })
  f.dispatch('pointerdown', f.trigger, { pointerType: 'touch' })
  f.dispatch('pointerup', f.trigger, { pointerType: 'touch' })
  // Chrome may queue compatibility mouse events after the pointerup task.
  f.flushTimers()
  f.dispatch('mousedown', f.trigger)
  f.trigger.focus()
  // Chrome retargets mouseup/click when this focus opens a sheet over the button.
  expect(f.popover.hidden).toBe(true)
  f.click(f.trigger)
  expect(f.popover.hidden).toBe(false)
  expect(f.popover.querySelector('.popover-heading')!.textContent).toBe('Build')
  expect(f.popover.querySelector('.popover-model')!.textContent).toBe('Example model')
  expect(f.state().pinned).toBe(true)
  f.dispatch('pointerout', f.trigger, { relatedTarget: f.outside })
  f.outside.focus(); f.flushTimers()
  expect(f.popover.hidden).toBe(false)
})

test('focus and mouse hover remain immediate even at phone width', () => {
  const focus = fixture(); focus.trigger.focus()
  expect(focus.popover.hidden).toBe(false)
  expect(focus.state().pinned).toBe(false)
  const hover = fixture(); hover.dispatch('pointerover', hover.trigger, { pointerType: 'mouse' })
  expect(hover.popover.hidden).toBe(false)
})

test('single-phase hover presents activity once with elapsed, tokens, model and both clocks', () => {
  const f = fixture()
  f.dispatch('pointerover', f.trigger, { pointerType: 'mouse' })
  const texts = (node: typeof f.popover): string[] => [node.textContent, ...node.children.flatMap(texts)]
  expect(texts(f.popover).filter(text => text === 'Build')).toHaveLength(1)
  expect(f.popover.querySelector('.popover-window')).toBeNull()
  expect(f.popover.querySelector('.popover-duration')!.textContent).toBe('5m')
  expect(f.popover.querySelector('.popover-tokens')!.textContent).toBe('100 tokens')
  expect(f.popover.querySelector('.popover-model')!.textContent).toBe('Example model')
  expect(texts(f.popover).some(text => text.startsWith('Started 11:59 PM'))).toBe(true)
  expect(texts(f.popover).some(text => text.startsWith('Completed 12:01 AM'))).toBe(true)
  expect(f.popover.querySelector('.popover-footer')!.textContent).toBe('Open full PR details')

  // The explorer needs its range context even when only one action was recorded.
  const info = JSON.parse(f.trigger.dataset.phaseInfo!)
  info.title = 'All recorded phases'; info.windowLabel = '5m total wall-clock span'
  f.trigger.dataset.phaseInfo = JSON.stringify(info)
  f.click(f.trigger)
  expect(f.popover.querySelector('.popover-window')!.textContent).toBe('5m total wall-clock span')
  expect(texts(f.popover)).toContain('Build')
})

test('cancelled, completed without click, and superseded touch gestures never suppress later focus', () => {
  for (const end of ['cancel', 'no-click', 'keyboard', 'mouse', 'outside-focus']) {
    const f = fixture()
    f.dispatch('pointerdown', f.trigger, { pointerType: 'touch' })
    if (end === 'cancel') f.dispatch('pointercancel', f.trigger)
    if (end === 'no-click') { f.dispatch('pointerup', f.trigger); f.dispatch('mousedown', f.trigger); f.flushTimers() }
    if (end === 'keyboard') f.dispatch('keydown', f.outside, { key: 'Tab' })
    if (end === 'mouse') f.dispatch('pointerdown', f.trigger, { pointerType: 'mouse' })
    if (end === 'outside-focus') f.dispatch('focusin', f.outside)
    f.dispatch('mousedown', f.trigger)
    f.trigger.focus()
    expect(f.popover.hidden).toBe(false)
  }
})

test('a touch without compatibility mouse events never suppresses later programmatic focus', () => {
  const f = fixture()
  f.dispatch('pointerdown', f.trigger, { pointerType: 'touch' })
  f.dispatch('pointerup', f.trigger, { pointerType: 'touch' })
  f.flushTimers(); f.trigger.focus()
  expect(f.popover.hidden).toBe(false)
})

test('touch suppression is consumed by focus and does not suppress later programmatic focus', () => {
  const f = fixture()
  f.dispatch('pointerdown', f.trigger, { pointerType: 'touch' }); f.dispatch('mousedown', f.trigger); f.trigger.focus()
  expect(f.popover.hidden).toBe(true)
  f.outside.focus(); f.trigger.focus()
  expect(f.popover.hidden).toBe(false)
})

test('pinned touch details preserve trigger focus through refresh and dismiss normally', () => {
  for (const dismissal of ['Escape', 'close', 'outside']) {
    const f = fixture()
    f.dispatch('pointerdown', f.trigger, { pointerType: 'touch' }); f.dispatch('mousedown', f.trigger); f.trigger.focus(); f.click(f.trigger)
    const replacement = f.refresh()
    expect(f.document.activeElement).toBe(replacement)
    expect(f.state().pinned).toBe(true)
    expect(f.popover.hidden).toBe(false)
    if (dismissal === 'Escape') f.dispatch('keydown', replacement, { key: 'Escape' })
    if (dismissal === 'close') f.click(f.popover.querySelector('.popover-close')!)
    if (dismissal === 'outside') f.click(f.outside)
    f.flushTimers()
    expect(f.popover.hidden).toBe(true)
    expect(replacement.attributes['aria-expanded']).toBe('false')
  }
})
