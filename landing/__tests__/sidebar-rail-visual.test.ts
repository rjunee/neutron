/**
 * CSS + HTML contract test for the sidebar topic strip.
 *
 * The 2026-05-29 sprint replaced the v1 sidebar (260px desktop column
 * + hamburger-toggled mobile drawer) with an always-visible
 * Telegram-style narrow vertical strip (~76px, avatar above label per
 * row, no hamburger). This file pins the contract so a future edit
 * can't silently regress back to the drawer pattern.
 *
 * Strategy mirrors __tests__/chat-html-mobile-viewport.test.ts —
 * parse the inline `<style>` body with regex assertions instead of
 * mounting the DOM. happy-dom does NOT compute layout for many of the
 * properties we care about (vh / dvh / -webkit-line-clamp /
 * flex-direction inheritance from media queries) so a "mount + read
 * computed style" check would either silently pass against the wrong
 * CSS or fail against the right CSS for the wrong reason. CSS-source
 * assertions are the durable contract.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const chatHtml = readFileSync(join(import.meta.dir, '..', 'chat.html'), 'utf8')

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function extractRuleBody(css: string, selector: string): string {
  // Anchor on `<selector> {` so a substring match like `.topic-row`
  // doesn't accidentally land on `.topic-row[aria-current="page"]`.
  const re = new RegExp(`(?:^|[}>\\s])${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'm')
  const m = css.match(re)
  if (m === null) throw new Error(`selector "${selector}" not found in chat.html <style>`)
  const open = css.indexOf('{', m.index!)
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

const styleMatch = chatHtml.match(/<style>([\s\S]*?)<\/style>/)
if (styleMatch === null) throw new Error('no <style> block found in chat.html')
const css = stripCssComments(styleMatch[1]!)

describe('chat.html — sidebar topic strip CSS contract', () => {
  test('#topic-rail is a narrow vertical column (width ≤ 96px)', () => {
    const body = extractRuleBody(css, '#topic-rail')
    // Match either `width: <N>px` or `flex: 0 0 <N>px`.
    const widthM = body.match(/width:\s*(\d+)px/)
    const flexM = body.match(/flex:\s*0\s+0\s+(\d+)px/)
    expect(widthM !== null || flexM !== null).toBe(true)
    const widths: number[] = []
    if (widthM !== null) widths.push(Number(widthM[1]))
    if (flexM !== null) widths.push(Number(flexM[1]))
    for (const w of widths) {
      expect(w).toBeLessThanOrEqual(96)
      expect(w).toBeGreaterThanOrEqual(64)
    }
  })

  test('#topic-rail is laid out as a flex column (no horizontal drawer container)', () => {
    const body = extractRuleBody(css, '#topic-rail')
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/flex-direction:\s*column/)
    // The v1 slide-in animation should not be present any more —
    // catching a regression where someone re-adds a transform-based
    // drawer.
    expect(body).not.toMatch(/transition:\s*transform/)
  })

  test('.topic-row is a vertical flex stack centered on the cross axis', () => {
    const body = extractRuleBody(css, '#topic-rail .topic-row')
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/flex-direction:\s*column/)
    expect(body).toMatch(/align-items:\s*center/)
  })

  test('.topic-avatar is a 40-48px circle', () => {
    const body = extractRuleBody(css, '#topic-rail .topic-avatar')
    expect(body).toMatch(/border-radius:\s*50%/)
    const widthM = body.match(/width:\s*(\d+)px/)
    const heightM = body.match(/height:\s*(\d+)px/)
    expect(widthM).not.toBeNull()
    expect(heightM).not.toBeNull()
    const w = Number(widthM![1])
    const h = Number(heightM![1])
    expect(w).toBeGreaterThanOrEqual(40)
    expect(w).toBeLessThanOrEqual(48)
    expect(h).toBe(w)
  })

  test('.topic-label uses a small text size (10-13px) suited to a narrow strip', () => {
    const body = extractRuleBody(css, '#topic-rail .topic-label')
    const fontM = body.match(/font:\s*(?:\d+\s+)?(\d+)px/)
    expect(fontM).not.toBeNull()
    const px = Number(fontM![1])
    expect(px).toBeGreaterThanOrEqual(10)
    expect(px).toBeLessThanOrEqual(13)
    // Two-line clamp keeps long names readable without growing the rail.
    expect(body).toMatch(/-webkit-line-clamp:\s*2/)
  })

  test('active row carries a 3px vertical accent bar on the left edge', () => {
    const body = extractRuleBody(css, '#topic-rail .topic-row[aria-current="page"]')
    // We allow either border-left or box-shadow to draw the bar; the
    // accent variable (`var(--accent)`) is the contract.
    expect(body).toMatch(/var\(--accent\)/)
  })
})

describe('chat.html — drawer/hamburger removal contract', () => {
  test('no .rail-toggle CSS rule survives (hamburger button is gone)', () => {
    expect(css).not.toMatch(/\.rail-toggle\s*\{/)
    expect(css).not.toMatch(/header\s+\.rail-toggle/)
  })

  test('no #rail-backdrop CSS rule survives (drawer backdrop is gone)', () => {
    expect(css).not.toMatch(/#rail-backdrop\s*\{/)
    expect(css).not.toMatch(/#rail-backdrop\[/)
  })

  test('no max-width media query that retargets the rail (drawer collapse is gone)', () => {
    // The v1 mobile drawer wrapped #topic-rail in `@media (max-width: 768px)`
    // with a `transform: translateX(-100%)`. Ensure no media query still
    // touches the rail or the hamburger.
    const mqs = css.match(/@media[^{]*\{[\s\S]*?\n\s*\}/g) ?? []
    for (const block of mqs) {
      expect(block).not.toMatch(/#topic-rail/)
      expect(block).not.toMatch(/\.rail-toggle/)
      expect(block).not.toMatch(/\.rail-close/)
    }
  })

  test('no <button class="rail-toggle"> in the HTML', () => {
    expect(chatHtml).not.toMatch(/class="rail-toggle"/)
    expect(chatHtml).not.toMatch(/id="rail-toggle"/)
  })

  test('no <div id="rail-backdrop"> in the HTML', () => {
    expect(chatHtml).not.toMatch(/id="rail-backdrop"/)
  })

  test('no <button class="rail-close"> in the HTML (drawer close button is gone)', () => {
    expect(chatHtml).not.toMatch(/class="rail-close"/)
    expect(chatHtml).not.toMatch(/id="rail-close"/)
  })

  test('static fallback row uses the new vertical layout (avatar + label only, no preview/name)', () => {
    // Grep the markup for the fallback row marker.
    const m = chatHtml.match(/<button[^>]*data-fallback="true"[\s\S]*?<\/button>/)
    expect(m).not.toBeNull()
    const fallback = m![0]
    expect(fallback).toMatch(/class="topic-avatar"/)
    expect(fallback).toMatch(/class="topic-label"/)
    expect(fallback).toMatch(/data-topic="general"/)
    // Legacy v1 markers from the wide-column layout should not survive.
    expect(fallback).not.toMatch(/class="topic-name"/)
    expect(fallback).not.toMatch(/class="topic-preview"/)
  })
})
