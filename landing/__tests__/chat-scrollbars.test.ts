import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const html = readFileSync(join(import.meta.dir, '..', 'chat-react.html'), 'utf8')
const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? ''

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
}

describe('chat web-client scrollbars', () => {
  test('uses thin theme-aware standard scrollbars on every scroll region', () => {
    expect(rule('*')).toContain('scrollbar-width: thin')
    expect(rule('*')).toContain(
      'scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track)',
    )
  })

  test('emits visible Chromium and Safari scrollbar rules', () => {
    expect(rule('*::-webkit-scrollbar')).toContain('width: 8px')
    expect(rule('*::-webkit-scrollbar')).toContain('height: 8px')
    expect(rule('*::-webkit-scrollbar-thumb')).toContain(
      'background: var(--scrollbar-thumb)',
    )
    expect(rule('*::-webkit-scrollbar-track')).toContain(
      'background: var(--scrollbar-track)',
    )
    expect(css).not.toMatch(/::-webkit-scrollbar[^{}]*\{[^}]*display\s*:\s*none/)
  })

  test('defines a visible thumb for both dark and light themes', () => {
    expect(rule(':root')).toContain('--scrollbar-thumb: #4b515c')
    expect(rule(':root[data-theme="light"]')).toContain('--scrollbar-thumb: #a8a8ad')
  })
})
