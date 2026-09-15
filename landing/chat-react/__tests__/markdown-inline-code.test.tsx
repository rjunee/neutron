import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const channels = hex.match(/../g)!.map((channel) => Number.parseInt(channel, 16) / 255)
    const [red, green, blue] = channels.map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    )
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
  }
  const fore = luminance(foreground)
  const back = luminance(background)
  return (Math.max(fore, back) + 0.05) / (Math.min(fore, back) + 0.05)
}

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as unknown as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

describe('Markdown inline code', () => {
  it('copies a standalone inline token but not a fenced block', async () => {
    const writes: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void writes.push(text) },
    })
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { Markdown } = await import('../Markdown.tsx')
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(<Markdown text={'Open `docs/brief.md`.\n\n```text\nblock text\n```'} />)
    })
    const codes = container.querySelectorAll('code')
    expect(codes).toHaveLength(2)

    codes[0]!.click()
    await Promise.resolve()
    expect(writes).toEqual(['docs/brief.md'])

    codes[1]!.click()
    await Promise.resolve()
    expect(writes).toEqual(['docs/brief.md'])

    await act(async () => root.unmount())
  })

  it('leaves a linked inline token to document navigation', async () => {
    const writes: string[] = []
    const opens: Array<[string, string]> = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void writes.push(text) },
    })
    const { createRoot } = await import('react-dom/client')
    const { act } = await import('react')
    const { Markdown } = await import('../Markdown.tsx')
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <Markdown
          text={'[`brief.md`](/projects/acme/docs?path=brief.md)'}
          origin="https://neutron.test"
          onDocLink={(project, path) => opens.push([project, path])}
        />,
      )
    })
    container.querySelector('code')!.click()
    await Promise.resolve()

    expect(opens).toEqual([['acme', 'brief.md']])
    expect(writes).toEqual([])

    await act(async () => root.unmount())
  })

  it('declares theme-specific inline colors and pointer-only inline styling', async () => {
    const html = await Bun.file(new URL('../../chat-react.html', import.meta.url)).text()
    expect(html).toMatch(/:root \{[\s\S]*?--code-inline-fg: #9bd7ff;/)
    expect(html).toMatch(/:root\[data-theme="light"\] \{[\s\S]*?--code-inline-fg: #0b57d0;/)
    expect(html).toContain('.car-md :not(pre) > code { color: var(--code-inline-fg); cursor: pointer; }')
    expect(html).toContain('.car-md pre code { background: none; color: inherit; cursor: text;')
    expect(contrast('9bd7ff', '1d2026')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('0b57d0', 'e9e9eb')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('dcefff', '1064cc')).toBeGreaterThanOrEqual(4.5)
  })
})
