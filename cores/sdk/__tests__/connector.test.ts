import { describe, expect, test } from 'bun:test'

import type {
  Connector,
  ConnectorRow,
  ConnectorTestResult,
  WatermarkState,
} from '../connector.ts'

interface FakeConfig {
  shop: string
}

interface FakeRow extends ConnectorRow {
  order_id: string
  total_price: number
}

class FakeConnector implements Connector<FakeConfig, WatermarkState, FakeRow> {
  readonly id = 'fake'
  readonly capabilities = ['connect:fake', 'network:external'] as const
  private state: WatermarkState = { last_seen_ts: 0 }

  constructor(private rows: FakeRow[]) {}

  async testConnection(cfg: FakeConfig): Promise<ConnectorTestResult> {
    return cfg.shop === 'good' ? { ok: true } : { ok: false, detail: 'bad shop' }
  }

  async *fetchSince(_: FakeConfig, since: number): AsyncIterable<FakeRow> {
    for (const r of this.rows) {
      if (r.ts > since) yield r
    }
  }

  async fetchSnapshot(cfg: FakeConfig): Promise<FakeRow[]> {
    const out: FakeRow[] = []
    for await (const r of this.fetchSince(cfg, 0)) out.push(r)
    return out
  }

  getState(): Promise<WatermarkState> {
    return Promise.resolve(this.state)
  }
  async setState(s: WatermarkState): Promise<void> {
    this.state = s
  }
}

describe('connector — interface conformance via FakeConnector', () => {
  const rows: FakeRow[] = [
    { project_slug: 'topline', ts: 100, order_id: 'a', total_price: 10 },
    { project_slug: 'topline', ts: 200, order_id: 'b', total_price: 20 },
    { project_slug: 'topline', ts: 300, order_id: 'c', total_price: 30 },
  ]

  test('testConnection returns ok for good config', async () => {
    const c = new FakeConnector(rows)
    expect(await c.testConnection({ shop: 'good' })).toEqual({ ok: true })
  })

  test('testConnection returns ok=false with detail for bad config', async () => {
    const c = new FakeConnector(rows)
    const r = await c.testConnection({ shop: 'bad' })
    expect(r.ok).toBe(false)
    expect(r.detail).toBe('bad shop')
  })

  test('fetchSince streams rows newer than watermark', async () => {
    const c = new FakeConnector(rows)
    const collected: FakeRow[] = []
    for await (const r of c.fetchSince({ shop: 'good' }, 150)) collected.push(r)
    expect(collected.map((r) => r.order_id)).toEqual(['b', 'c'])
  })

  test('fetchSnapshot returns all rows', async () => {
    const c = new FakeConnector(rows)
    const all = await c.fetchSnapshot({ shop: 'good' })
    expect(all.map((r) => r.order_id)).toEqual(['a', 'b', 'c'])
  })

  test('getState/setState round-trips watermark', async () => {
    const c = new FakeConnector(rows)
    await c.setState({ last_seen_ts: 555 })
    expect(await c.getState()).toEqual({ last_seen_ts: 555 })
  })

  test('id is a stable readonly string', () => {
    const c = new FakeConnector(rows)
    expect(c.id).toBe('fake')
  })

  test('capabilities is a readonly array of capability strings', () => {
    const c = new FakeConnector(rows)
    expect(c.capabilities).toContain('connect:fake')
    expect(c.capabilities).toContain('network:external')
  })
})
