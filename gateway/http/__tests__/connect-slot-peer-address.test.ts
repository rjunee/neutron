/**
 * The Connect rung passes the REAL TCP peer address to the connect handler
 * (ISSUES #421).
 *
 * The public-edge per-IP rate limiter keys on `clientIpFromRequest(req,
 * socketIp)`, which ignores `X-Forwarded-For` from a non-local peer. That
 * hardening is only worth anything if the composed ladder actually SUPPLIES the
 * socket address — drop the argument at this one dispatch site and the limiter
 * silently falls back to the forgeable header, with every unit test on the
 * limiter still green. So this pins the wiring, not the policy.
 */

import { describe, expect, test } from 'bun:test'

import { ROUTE_SLOTS, type RouteDispatchContext } from '../route-slots.ts'

const connectSlot = ROUTE_SLOTS.find((s) => s.rung === 'connect')

describe('connect rung — socket peer threading', () => {
  test('the slot exists and is bound to the connect_api composition field', () => {
    expect(connectSlot).toBeDefined()
    expect(connectSlot!.composition).toBe('connect_api')
  })

  test('dispatch hands the handler the address Bun.Server.requestIP reports', async () => {
    const seen: Array<string | null | undefined> = []
    const handler = async (_req: Request, socketIp?: string | null): Promise<Response | null> => {
      seen.push(socketIp)
      return new Response('ok')
    }
    const req = new Request('http://node.example.com/connect/v1/health')
    const ctx = {
      req,
      // Only `requestIP` is exercised by this rung.
      server: { requestIP: () => ({ address: '203.0.113.9', port: 51_000, family: 'IPv4' }) },
      url: new URL(req.url),
      pathname: '/connect/v1/health',
      method: 'GET',
    } as unknown as RouteDispatchContext

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (connectSlot!.dispatch as any)(handler, ctx)
    expect((res as Response).status).toBe(200)
    expect(seen).toEqual(['203.0.113.9'])
  })

  test('a runtime that cannot report a peer degrades to null, never throws', async () => {
    const seen: Array<string | null | undefined> = []
    const handler = async (_req: Request, socketIp?: string | null): Promise<Response | null> => {
      seen.push(socketIp)
      return null
    }
    const req = new Request('http://node.example.com/connect/v1/health')
    const ctx = {
      req,
      server: {
        requestIP: () => {
          throw new Error('not supported on this transport')
        },
      },
      url: new URL(req.url),
      pathname: '/connect/v1/health',
      method: 'GET',
    } as unknown as RouteDispatchContext

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (connectSlot!.dispatch as any)(handler, ctx)
    expect(res).toBeNull()
    expect(seen).toEqual([null])
  })
})
