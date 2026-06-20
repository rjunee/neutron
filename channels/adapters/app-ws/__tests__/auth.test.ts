import { describe, expect, it } from 'bun:test'
import { SignJWT } from 'jose'

import { createAppWsAuthResolver } from '../auth.ts'

describe('createAppWsAuthResolver — dev-bypass', () => {
  const resolver = createAppWsAuthResolver({
    project_slug: 'demo',
    bypass: true,
  })

  it('mode is dev-bypass', () => {
    expect(resolver.mode).toBe('dev-bypass')
  })

  it('accepts a bare user id', async () => {
    const res = await resolver.resolve('sam')
    expect('code' in res).toBe(false)
    if ('code' in res) throw new Error('unreachable')
    expect(res.user_id).toBe('sam')
    expect(res.project_slug).toBe('demo')
  })

  it('accepts a dev:<user_id> token', async () => {
    const res = await resolver.resolve('dev:alice')
    if ('code' in res) throw new Error(`unexpected: ${res.code}`)
    expect(res.user_id).toBe('alice')
  })

  it('rejects empty token', async () => {
    const res = await resolver.resolve('')
    expect('code' in res ? res.code : null).toBe('missing_token')
  })

  it('rejects tokens with disallowed chars', async () => {
    const res = await resolver.resolve('foo bar')
    expect('code' in res ? res.code : null).toBe('malformed_token')
  })
})

describe('createAppWsAuthResolver — HS256', () => {
  const secret = 'dev-secret-please-change'
  const secretBytes = new TextEncoder().encode(secret)
  const resolver = createAppWsAuthResolver({
    project_slug: 'demo',
    bypass: false,
    hs256_secret: secret,
  })

  async function mint(payload: Record<string, unknown>, exp?: number): Promise<string> {
    let jwt = new SignJWT(payload).setProtectedHeader({ alg: 'HS256' })
    if (exp !== undefined) jwt = jwt.setExpirationTime(exp)
    return jwt.sign(secretBytes)
  }

  it('mode is hs256', () => {
    expect(resolver.mode).toBe('hs256')
  })

  it('accepts a valid HS256 JWT', async () => {
    const tok = await mint({ sub: 'bob', project_slug: 'demo' }, Math.floor(Date.now() / 1000) + 60)
    const res = await resolver.resolve(tok)
    if ('code' in res) throw new Error(`unexpected: ${res.code}`)
    expect(res.user_id).toBe('bob')
    expect(res.project_slug).toBe('demo')
  })

  it('rejects tampered signature', async () => {
    const tok = await mint({ sub: 'bob' }, Math.floor(Date.now() / 1000) + 60)
    const tampered = tok.slice(0, -4) + 'AAAA'
    const res = await resolver.resolve(tampered)
    expect('code' in res ? res.code : null).toBe('invalid_signature')
  })

  it('rejects mismatched project_slug', async () => {
    const tok = await mint(
      { sub: 'bob', project_slug: 'other-project' },
      Math.floor(Date.now() / 1000) + 60,
    )
    const res = await resolver.resolve(tok)
    expect('code' in res ? res.code : null).toBe('project_mismatch')
  })

  it('rejects expired token', async () => {
    const tok = await mint({ sub: 'bob' }, Math.floor(Date.now() / 1000) - 60)
    const res = await resolver.resolve(tok)
    expect('code' in res ? res.code : null).toBe('expired_token')
  })

  it('rejects missing sub', async () => {
    const tok = await mint({}, Math.floor(Date.now() / 1000) + 60)
    const res = await resolver.resolve(tok)
    expect('code' in res ? res.code : null).toBe('malformed_token')
  })
})

describe('createAppWsAuthResolver — unconfigured', () => {
  it('rejects any token with code=unconfigured', async () => {
    const resolver = createAppWsAuthResolver({
      project_slug: 'demo',
      bypass: false,
    })
    expect(resolver.mode).toBe('unconfigured')
    const res = await resolver.resolve('anything')
    expect('code' in res ? res.code : null).toBe('unconfigured')
  })
})
