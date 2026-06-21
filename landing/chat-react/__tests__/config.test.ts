import { describe, expect, it } from 'bun:test'

import {
  ChatBootstrapError,
  appWsTopicId,
  buildWsUrl,
  decodeJwtSub,
  resolveBootstrapConfig,
  type WindowLike,
} from '../config.ts'

/** Build a JWT-shaped token (header.payload.sig) with the given claims. */
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`
}

function win(over: Partial<WindowLike> = {}): WindowLike {
  return {
    location: { protocol: 'https:', host: 'sam.neutron.test', search: '' },
    ...over,
  }
}

describe('decodeJwtSub', () => {
  it('extracts the sub claim from a base64url JWT', () => {
    expect(decodeJwtSub(jwt({ sub: 'user-42' }))).toBe('user-42')
  })
  it('returns null for malformed / empty / sub-less tokens', () => {
    expect(decodeJwtSub('')).toBeNull()
    expect(decodeJwtSub('not-a-jwt')).toBeNull()
    expect(decodeJwtSub(jwt({ aud: 'x' }))).toBeNull()
    expect(decodeJwtSub(undefined)).toBeNull()
  })
})

describe('buildWsUrl + appWsTopicId', () => {
  it('uses wss for https and carries token + platform', () => {
    const u = buildWsUrl('https:', 'h.test', 'dev:sam', null)
    expect(u.startsWith('wss://h.test/ws/app/chat?')).toBe(true)
    expect(u).toContain('platform=web')
    expect(u).toContain('token=dev%3Asam')
    expect(u).not.toContain('project_id')
  })
  it('uses ws for http and appends project_id when present', () => {
    const u = buildWsUrl('http:', 'h.test', 't', 'proj-1')
    expect(u.startsWith('ws://')).toBe(true)
    expect(u).toContain('project_id=proj-1')
  })
  it('forms app:<user_id> topics', () => {
    expect(appWsTopicId('sam')).toBe('app:sam')
  })
})

describe('resolveBootstrapConfig', () => {
  it('derives user id + topic + ws url from a stashed start token', () => {
    const cfg = resolveBootstrapConfig(win({ __neutron_start_token: jwt({ sub: 'sam' }) }))
    expect(cfg.userId).toBe('sam')
    expect(cfg.topicId).toBe('app:sam')
    expect(cfg.wsUrl).toContain('wss://sam.neutron.test/ws/app/chat')
    // Default app-ws token is the dev-bypass form.
    expect(cfg.wsUrl).toContain('token=dev%3Asam')
    expect(cfg.origin).toBe('https://sam.neutron.test')
  })

  it('reads the start token from the URL when not stashed', () => {
    const cfg = resolveBootstrapConfig(
      win({ location: { protocol: 'https:', host: 'h.test', search: `?start=${jwt({ sub: 'q' })}` } }),
    )
    expect(cfg.userId).toBe('q')
  })

  it('prefers an explicit app-ws token + url override (production mint path)', () => {
    const cfg = resolveBootstrapConfig(
      win({
        __neutron_user_id: 'sam',
        __neutron_app_ws_token: 'real.jwt.token',
        __neutron_app_ws_url: 'wss://edge.test/ws/app/chat?token=real.jwt.token',
      }),
    )
    expect(cfg.wsUrl).toBe('wss://edge.test/ws/app/chat?token=real.jwt.token')
  })

  it('carries projects + the active project id', () => {
    const cfg = resolveBootstrapConfig(
      win({
        __neutron_user_id: 'sam',
        __neutron_projects: [{ id: 'p1', label: 'Work' }],
        __neutron_active_project_id: 'p1',
      }),
    )
    expect(cfg.projects).toEqual([{ id: 'p1', label: 'Work' }])
    expect(cfg.projectId).toBe('p1')
    expect(cfg.wsUrl).toContain('project_id=p1')
  })

  it('throws ChatBootstrapError when no identity can be derived', () => {
    expect(() => resolveBootstrapConfig(win())).toThrow(ChatBootstrapError)
  })
})
