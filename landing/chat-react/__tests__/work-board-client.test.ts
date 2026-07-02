/**
 * Unit test for the web WORK BOARD API client (Work Board Phase 1b). Pure over
 * an injected `fetchImpl` — no DOM, no network. Asserts each method targets the
 * right path/method/body, carries the bearer, parses the response, and surfaces
 * a coded error; plus `parseWorkBoardItems` defensive parsing.
 */

import { describe, expect, it } from 'bun:test'

import {
  WebWorkBoardClient,
  WorkBoardClientError,
  parseWorkBoardItems,
  type WorkBoardItem,
} from '../work-board-client.ts'

const BASE = 'https://sam.neutron.test'
const TOKEN = 'dev:sam'

function row(over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: 'w1',
    project_slug: 'sam',
    title: 'Item',
    status: 'upcoming',
    sort_order: 1,
    design_doc_ref: null,
    inline_active: false,
    linked_run_id: null,
    created_at: '2026-06-20T00:00:00Z',
    updated_at: '2026-06-20T00:00:00Z',
    completed_at: null,
    ...over,
  }
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Capture the single fetch call + serve a canned response. */
function capture(res: Response): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
  calls: Array<{ url: string; method: string; body: unknown; auth: string | null }>
} {
  const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = []
  return {
    calls,
    fetchImpl: async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined,
        auth: headers['authorization'] ?? null,
      })
      return res
    },
  }
}

function makeClient(res: Response) {
  const cap = capture(res)
  const client = new WebWorkBoardClient({ base_url: BASE, token: TOKEN, fetchImpl: cap.fetchImpl })
  return { client, calls: cap.calls }
}

describe('WebWorkBoardClient', () => {
  it('list GETs /work-board with the bearer and returns items', async () => {
    const { client, calls } = makeClient(jsonRes({ ok: true, items: [row()], project_id: 'acme' }))
    const items = await client.list('acme')
    expect(items).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE}/api/app/projects/acme/work-board`)
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`)
  })

  it('create POSTs the title and returns the item', async () => {
    const { client, calls } = makeClient(jsonRes({ ok: true, item: row({ title: 'New' }) }, 201))
    const item = await client.create('acme', { title: 'New', status: 'in_progress' })
    expect(item.title).toBe('New')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe(`${BASE}/api/app/projects/acme/work-board`)
    expect(calls[0]!.body).toEqual({ title: 'New', status: 'in_progress' })
  })

  it('update PATCHes /work-board/<id>', async () => {
    const { client, calls } = makeClient(jsonRes({ ok: true, item: row({ title: 'Edited' }) }))
    await client.update('acme', 'w1', { title: 'Edited' })
    expect(calls[0]!.method).toBe('PATCH')
    expect(calls[0]!.url).toBe(`${BASE}/api/app/projects/acme/work-board/w1`)
    expect(calls[0]!.body).toEqual({ title: 'Edited' })
  })

  it('complete POSTs /work-board/<id>/complete', async () => {
    const { client, calls } = makeClient(jsonRes({ ok: true, item: row({ status: 'done' }) }))
    await client.complete('acme', 'w1')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe(`${BASE}/api/app/projects/acme/work-board/w1/complete`)
  })

  it('reorder POSTs /work-board/<id>/reorder with target + returns the board', async () => {
    const { client, calls } = makeClient(jsonRes({ ok: true, items: [row()], project_id: 'acme' }))
    const items = await client.reorder('acme', 'w1', { before: 'w2' })
    expect(items).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE}/api/app/projects/acme/work-board/w1/reorder`)
    expect(calls[0]!.body).toEqual({ before: 'w2' })
  })

  it('delete DELETEs /work-board/<id>', async () => {
    const { client, calls } = makeClient(jsonRes({ ok: true, deleted: 'w1' }))
    await client.delete('acme', 'w1')
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.url).toBe(`${BASE}/api/app/projects/acme/work-board/w1`)
  })

  it('throws a coded WorkBoardClientError on a non-2xx', async () => {
    const { client } = makeClient(jsonRes({ ok: false, code: 'invalid_title', message: 'bad' }, 400))
    await expect(client.create('acme', { title: '' })).rejects.toBeInstanceOf(WorkBoardClientError)
  })

  it('encodes the project + item ids in the path', async () => {
    const { client, calls } = makeClient(jsonRes({ ok: true, item: row() }))
    await client.update('a/b', 'i d', { title: 'x' })
    expect(calls[0]!.url).toBe(`${BASE}/api/app/projects/a%2Fb/work-board/i%20d`)
  })
})

describe('parseWorkBoardItems', () => {
  it('keeps valid rows and drops malformed ones', () => {
    const out = parseWorkBoardItems([
      row({ id: 'a' }),
      { id: '', title: 'no id' },
      { id: 'b', title: 'x', status: 'bogus' },
      'nope',
      null,
    ])
    expect(out.map((i) => i.id)).toEqual(['a'])
  })

  it('returns [] for a non-array', () => {
    expect(parseWorkBoardItems('nope')).toEqual([])
    expect(parseWorkBoardItems(undefined)).toEqual([])
  })

  it('coerces missing optional fields to safe defaults', () => {
    const out = parseWorkBoardItems([{ id: 'a', title: 'T', status: 'in_progress' }])
    expect(out[0]).toEqual({
      id: 'a',
      title: 'T',
      status: 'in_progress',
      sort_order: 0,
      design_doc_ref: null,
      inline_active: false,
      linked_run_id: null,
      created_at: '',
      updated_at: '',
      completed_at: null,
    })
  })

  it('parses a valid run_progress and drops a malformed one (item 1)', () => {
    const out = parseWorkBoardItems([
      {
        id: 'a',
        title: 'Bound',
        status: 'in_progress',
        linked_run_id: 'run-1',
        run_progress: {
          run_id: 'run-1',
          phase_label: 'building',
          round: 2,
          started_at: '2026-07-02T00:00:00Z',
          last_advanced_at: '2026-07-02T00:01:00Z',
          elapsed_ms: 60000,
          stalled: false,
          stalled_ms: null,
          pr: null,
          verdict: null,
          failure_reason: null,
        },
      },
      // A bogus phase_label → run_progress dropped, but the item survives.
      {
        id: 'b',
        title: 'Bad progress',
        status: 'in_progress',
        run_progress: { run_id: 'x', phase_label: 'nonsense' },
      },
    ])
    expect(out[0]!.run_progress?.phase_label).toBe('building')
    expect(out[0]!.run_progress?.round).toBe(2)
    expect(out[1]!.run_progress).toBeUndefined()
  })
})
