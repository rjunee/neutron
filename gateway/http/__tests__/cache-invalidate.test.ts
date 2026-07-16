/**
 * P1.5 § 1.5.5 — POST /internal/cache-invalidate handler tests.
 */

import { describe, expect, test } from 'bun:test'
import { composeHttpHandler } from '../compose.ts'

const defaultHandler = (): Response => new Response('default')

describe('POST /internal/cache-invalidate', () => {
  test('flushes shim cache when token matches and handle is supplied', async () => {
    const invalidated: string[] = []
    const composed = composeHttpHandler({
      internalCacheInvalidateHandler: {
        invalidateOwnerHandle: (h) => invalidated.push(h),
        expectedToken: 'shared-secret',
      },
      defaultHandler,
    })
    const req = new Request('http://x/internal/cache-invalidate', {
      method: 'POST',
      headers: {
        'X-Internal-Token': 'shared-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ owner_handle: 't-aaaaaaaa' }),
    })
    const res = await composed.fetch(req, {} as never)
    expect(res.status).toBe(200)
    expect(invalidated).toEqual(['t-aaaaaaaa'])
  })

  test('rejects 403 on missing or wrong token', async () => {
    const composed = composeHttpHandler({
      internalCacheInvalidateHandler: {
        invalidateOwnerHandle: () => undefined,
        expectedToken: 'shared-secret',
      },
      defaultHandler,
    })
    for (const tok of ['', 'wrong', 'shared-secre']) {
      const req = new Request('http://x/internal/cache-invalidate', {
        method: 'POST',
        headers: {
          'X-Internal-Token': tok,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ owner_handle: 't-aaaaaaaa' }),
      })
      const res = await composed.fetch(req, {} as never)
      expect(res.status).toBe(403)
    }
  })

  test('rejects 400 on missing owner_handle', async () => {
    const composed = composeHttpHandler({
      internalCacheInvalidateHandler: {
        invalidateOwnerHandle: () => undefined,
        expectedToken: 'shared-secret',
      },
      defaultHandler,
    })
    const req = new Request('http://x/internal/cache-invalidate', {
      method: 'POST',
      headers: {
        'X-Internal-Token': 'shared-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    const res = await composed.fetch(req, {} as never)
    expect(res.status).toBe(400)
  })

  test('falls through to defaultHandler when no internal handler is configured', async () => {
    const composed = composeHttpHandler({
      defaultHandler: () => new Response('falling-through', { status: 200 }),
    })
    const req = new Request('http://x/internal/cache-invalidate', {
      method: 'POST',
      body: JSON.stringify({ owner_handle: 't-x' }),
    })
    const res = await composed.fetch(req, {} as never)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('falling-through')
  })
})
