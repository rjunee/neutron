/**
 * Multi-sub Max OAuth client — STUB tests.
 *
 * Per docs/plans/P2-onboarding.md § 2.4 (Locked 2026-04-29 fallback) +
 * § 6 S4 (lines 2086-2102). Every method MUST throw
 * `MultiSubNotImplementedError` with the documented reason. Tests assert
 * the error shape so a future "real implementation that forgot one
 * method" lands as a single-line PR diff (delete a test) rather than a
 * silent runtime fallthrough.
 */

import { describe, expect, test } from 'bun:test'
import {
  MultiSubNotImplementedError,
  MultiSubOAuthClient,
} from '../max-oauth-multi-sub.ts'

describe('MultiSubOAuthClient — NOT_IMPLEMENTED stub', () => {
  test('addSub throws MultiSubNotImplementedError with documented reason', async () => {
    const client = new MultiSubOAuthClient()
    let caught: unknown = null
    try {
      await client.addSub({ instance_slug: 't1', sub_label: 's1', return_url: 'https://x' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(MultiSubNotImplementedError)
    const e = caught as MultiSubNotImplementedError
    expect(e.method).toBe('addSub')
    expect(e.reason).toContain('Sprint-1 research spike')
    expect(e.reason).toContain('§ 2.4')
  })

  test('removeSub throws MultiSubNotImplementedError', async () => {
    const client = new MultiSubOAuthClient()
    await expect(
      client.removeSub({ instance_slug: 't1', sub_label: 's1' }),
    ).rejects.toBeInstanceOf(MultiSubNotImplementedError)
  })

  test('rotateOnExhaustion throws MultiSubNotImplementedError', async () => {
    const client = new MultiSubOAuthClient()
    await expect(
      client.rotateOnExhaustion({ instance_slug: 't1', current_sub_label: 's1' }),
    ).rejects.toBeInstanceOf(MultiSubNotImplementedError)
  })

  test('listAttachedSubs throws MultiSubNotImplementedError', async () => {
    const client = new MultiSubOAuthClient()
    await expect(client.listAttachedSubs({ instance_slug: 't1' })).rejects.toBeInstanceOf(
      MultiSubNotImplementedError,
    )
  })

  test('getActiveSub throws MultiSubNotImplementedError', async () => {
    const client = new MultiSubOAuthClient()
    await expect(client.getActiveSub({ instance_slug: 't1' })).rejects.toBeInstanceOf(
      MultiSubNotImplementedError,
    )
  })

  test('static reason() returns the locked rationale string', () => {
    const r = MultiSubOAuthClient.reason()
    expect(r).toContain('Sprint-1 research spike')
    expect(r).toContain('NOT_IMPLEMENTED')
    expect(r).toContain('M2 path uses single-sub Max OAuth')
  })

  test('error names + messages mention the method', async () => {
    const client = new MultiSubOAuthClient()
    try {
      await client.addSub({ instance_slug: 't', sub_label: 'a', return_url: 'https://x' })
    } catch (err) {
      const e = err as Error
      expect(e.name).toBe('MultiSubNotImplementedError')
      expect(e.message).toContain('addSub')
      expect(e.message).toContain('not yet implemented')
    }
  })
})
