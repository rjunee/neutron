import { describe, expect, it } from 'bun:test'

import { InMemoryAppWsSessionRegistry } from '../session-registry.ts'
import type { AppWsOutbound } from '../envelope.ts'

const TOPIC = 'app:sam'

function readyEnv(): AppWsOutbound {
  return { v: 1, type: 'session_ready', user_id: 'sam', project_slug: 'demo', topic_id: TOPIC, ts: 0 }
}

describe('InMemoryAppWsSessionRegistry — multi-device fan-out', () => {
  it('delivers each emit to EVERY device on the same topic (laptop + phone)', () => {
    const registry = new InMemoryAppWsSessionRegistry()
    const laptop: AppWsOutbound[] = []
    const phone: AppWsOutbound[] = []
    registry.register(TOPIC, (e) => laptop.push(e), { platform: 'web' })
    registry.register(TOPIC, (e) => phone.push(e), { platform: 'native' })
    expect(registry.deviceCount(TOPIC)).toBe(2)

    const delivered = registry.send(TOPIC, readyEnv())
    expect(delivered).toBe(true)
    expect(laptop.length).toBe(1)
    expect(phone.length).toBe(1)
  })

  it('identity-aware unregister evicts ONLY the closing device, not the other', () => {
    const registry = new InMemoryAppWsSessionRegistry()
    const laptop: AppWsOutbound[] = []
    const phone: AppWsOutbound[] = []
    const laptopSend = (e: AppWsOutbound): void => { laptop.push(e) }
    const phoneSend = (e: AppWsOutbound): void => { phone.push(e) }
    registry.register(TOPIC, laptopSend)
    registry.register(TOPIC, phoneSend)

    // Laptop closes.
    registry.unregister(TOPIC, laptopSend)
    expect(registry.deviceCount(TOPIC)).toBe(1)
    expect(registry.has(TOPIC)).toBe(true)

    registry.send(TOPIC, readyEnv())
    expect(laptop.length).toBe(0) // gone
    expect(phone.length).toBe(1) // still live
  })

  it('continues the fan-out when one device throws (closed socket) and sweeps it', () => {
    const registry = new InMemoryAppWsSessionRegistry()
    const phone: AppWsOutbound[] = []
    registry.register(TOPIC, () => { throw new Error('socket closed') }, { platform: 'web' })
    registry.register(TOPIC, (e) => phone.push(e), { platform: 'native' })

    const delivered = registry.send(TOPIC, readyEnv())
    expect(delivered).toBe(true) // phone got it
    expect(phone.length).toBe(1)
    // Dead laptop socket swept.
    expect(registry.deviceCount(TOPIC)).toBe(1)
  })

  it('reports the most-recently-registered platform and clears the topic when empty', () => {
    const registry = new InMemoryAppWsSessionRegistry()
    const a = (): void => {}
    const b = (): void => {}
    registry.register(TOPIC, a, { platform: 'native' })
    registry.register(TOPIC, b, { platform: 'web' })
    expect(registry.getPlatform(TOPIC)).toBe('web')
    registry.unregister(TOPIC, a)
    registry.unregister(TOPIC, b)
    expect(registry.has(TOPIC)).toBe(false)
    expect(registry.getPlatform(TOPIC)).toBeNull()
    expect(registry.topics()).toEqual([])
  })
})
