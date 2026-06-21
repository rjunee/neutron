import { describe, expect, it } from 'bun:test'

import { resolveWebChatClient } from '../web-chat-flag.ts'

describe('resolveWebChatClient', () => {
  it('defaults to vanilla when nothing is set', () => {
    expect(resolveWebChatClient({})).toBe('vanilla')
    expect(resolveWebChatClient({ envDefault: undefined, queryClient: null })).toBe('vanilla')
  })

  it('honours the env default', () => {
    expect(resolveWebChatClient({ envDefault: 'react' })).toBe('react')
    expect(resolveWebChatClient({ envDefault: 'vanilla' })).toBe('vanilla')
  })

  it('ignores an unrecognized env value (falls back to vanilla)', () => {
    expect(resolveWebChatClient({ envDefault: 'angular' })).toBe('vanilla')
    expect(resolveWebChatClient({ envDefault: '' })).toBe('vanilla')
  })

  it('lets the query override the env default both ways', () => {
    expect(resolveWebChatClient({ envDefault: 'vanilla', queryClient: 'react' })).toBe('react')
    expect(resolveWebChatClient({ envDefault: 'react', queryClient: 'vanilla' })).toBe('vanilla')
  })

  it('ignores an unrecognized query value and uses the env default', () => {
    expect(resolveWebChatClient({ envDefault: 'react', queryClient: 'bogus' })).toBe('react')
    expect(resolveWebChatClient({ envDefault: 'vanilla', queryClient: '' })).toBe('vanilla')
  })
})
