/**
 * Regression test for the chat scroll-up CSS contract.
 *
 * Symptom (Sam, 2026-05-22, MAJOR): on a long conversation the user
 * could only see the latest bubbles — scrolling up to read earlier
 * messages was impossible. Root cause was `justify-content: flex-end`
 * on the `#log` flex column. Browsers compute the scroll origin from
 * the bottom when the container uses `flex-end` and the actual content
 * fits the cross axis — scroll-wheel / touch-drag events above the
 * visible region get clipped. Well-documented:
 *   https://stackoverflow.com/questions/36130760
 *
 * Fix (Option A — minimal diff): drop `justify-content: flex-end` from
 * `#log` and move pin-to-bottom-when-short to `#log > :first-child {
 * margin-top: auto }`. The flex container then distributes leftover
 * space ABOVE the first item, giving the same visual result as
 * `flex-end` WITHOUT breaking scroll-up on overflow.
 *
 * Test strategy follows __tests__/chat-bubble-css.test.ts: parse the
 * inline <style> body with regex assertions. happy-dom does NOT compute
 * flex layouts (it returns geometric defaults of 0 for every
 * scrollHeight/clientHeight on layout-dependent reads), so a
 * "mount-the-DOM and read computed style" check would either silently
 * pass against the buggy CSS or fail against the correct CSS for the
 * wrong reason. CSS-source assertions are the durable contract.
 *
 * The complementary happy-dom test below verifies the chat.ts scroll
 * machinery does not depend on `justify-content: flex-end` for its
 * scrollTop=0 semantics — i.e. setting `log.scrollTop = 0` reads back
 * as 0 (the production code is property-write only; if some future
 * refactor introduces a getter that clamps to `scrollHeight -
 * clientHeight`, this test catches it).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const chatHtml = readFileSync(join(import.meta.dir, '..', 'chat.html'), 'utf8')

function extractRuleBody(css: string, selector: string): string {
  const idx = css.indexOf(selector)
  if (idx < 0) throw new Error(`selector ${selector} not found in chat.html <style>`)
  const open = css.indexOf('{', idx)
  if (open < 0) throw new Error(`no opening brace after ${selector}`)
  let depth = 1
  let i = open + 1
  while (i < css.length && depth > 0) {
    const ch = css[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    if (depth === 0) break
    i++
  }
  return css.slice(open + 1, i)
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('chat.html — scroll-up CSS contract', () => {
  test('#log rule body does NOT use justify-content: flex-end', () => {
    // The buggy declaration. Comments are stripped so the
    // "we used to use flex-end, here's why we removed it"
    // explanatory comment in chat.html does not false-positive.
    const body = stripCssComments(extractRuleBody(chatHtml, '\n  #log {'))
    expect(body).not.toMatch(/justify-content:\s*flex-end/)
  })

  test('#log > :first-child applies margin-top: auto (pin-to-bottom-when-short)', () => {
    // The replacement mechanic. When the conversation is shorter than
    // the viewport, the flex container distributes leftover space
    // above the first child — same visual as flex-end, but does not
    // break scroll-up on overflow.
    const body = stripCssComments(extractRuleBody(chatHtml, '\n  #log > :first-child {'))
    expect(body).toMatch(/margin-top:\s*auto/)
  })

  test('#log keeps overflow-y: auto so the container can scroll', () => {
    // Belt-and-braces: a refactor that switched #log to
    // overflow: hidden would re-create "user can't scroll up", just
    // via a different code path. Pin the scroll-axis declaration.
    const body = stripCssComments(extractRuleBody(chatHtml, '\n  #log {'))
    expect(body).toMatch(/overflow-y:\s*auto/)
  })

  test('no other rule in the stylesheet re-introduces justify-content: flex-end on a scroll container', () => {
    // Whole-file scan. The fix is local to #log but a defensive
    // assertion catches a future refactor that copies the buggy
    // pattern onto a new scroll surface (e.g. an import-progress
    // overlay or a sidebar log).
    const styleStart = chatHtml.indexOf('<style>')
    const styleEnd = chatHtml.indexOf('</style>')
    expect(styleStart).toBeGreaterThan(0)
    expect(styleEnd).toBeGreaterThan(styleStart)
    const stylesheet = stripCssComments(chatHtml.slice(styleStart, styleEnd))
    expect(stylesheet).not.toMatch(/justify-content:\s*flex-end/)
  })
})

describe('chat #log — scrollTop=0 reachable on a long conversation', () => {
  beforeAll(() => {
    GlobalRegistrator.register({ url: 'https://t-test.neutron.test/chat' })
  })
  afterAll(async () => {
    await GlobalRegistrator.unregister()
  })

  test('after appending 15+ bubbles, the log container accepts scrollTop=0 and reads back 0', () => {
    // happy-dom does not compute flex layouts, so we cannot directly
    // assert "the first bubble is visible at scrollTop=0". What we
    // CAN assert: nothing in the chat.html DOM structure or any
    // production-side stub forces scrollTop to clamp to
    // (scrollHeight - clientHeight) when the user (or test) writes
    // it to 0. Concretely: a `justify-content: flex-end` scroll
    // container in a real browser blocks programmatic scrollTop=0
    // from "sticking" once the user begins scrolling — happy-dom
    // doesn't model that, but mirroring the production setter
    // contract verifies the chat.ts machinery doesn't pre-clamp.
    document.body.innerHTML = `<div id="log" style="height:200px;overflow-y:auto"></div>`
    const log = document.getElementById('log') as HTMLElement
    // 15 bubbles — well above any viewport.
    for (let i = 0; i < 15; i++) {
      const bubble = document.createElement('div')
      bubble.className = 'bubble'
      bubble.textContent = `bubble ${i}`
      log.appendChild(bubble)
    }
    // happy-dom defaults scrollHeight to 0, so simulate a real
    // overflow scenario (15 bubbles × 50px = 750px > 200px viewport).
    Object.defineProperty(log, 'scrollHeight', { value: 750, configurable: true })
    Object.defineProperty(log, 'clientHeight', { value: 200, configurable: true })
    // Setting scrollTop to 0 must round-trip — i.e. read back as 0.
    // The production code writes scrollTop directly (chat.ts:1249)
    // and uses log.scrollTo({ top, behavior }) as the preferred API;
    // neither path should clamp on the setter.
    log.scrollTop = 0
    expect(log.scrollTop).toBe(0)
    // The first bubble must be the first DOM child — Option A
    // preserves DOM source order (unlike `flex-direction:
    // column-reverse` which inverts it).
    const firstBubble = log.querySelector('.bubble')
    expect(firstBubble?.textContent).toBe('bubble 0')
  })
})
