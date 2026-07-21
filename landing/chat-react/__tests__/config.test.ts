import { describe, expect, it } from 'bun:test'

import {
  ChatBootstrapError,
  appWsTopicId,
  buildWsUrl,
  decodeJwtSub,
  detectClientTimezone,
  initialProjectIdFromLocation,
  resolveBootstrapConfig,
  wsUrlForScope,
  type BootstrapConfig,
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
    location: { protocol: 'https:', host: 'sam.neutron.test', search: '', pathname: '/chat' },
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

describe('initialProjectIdFromLocation (#375)', () => {
  const projects = [
    { id: 'p1', label: 'Work' },
    { id: 'p2', label: 'Home' },
  ]
  it('returns null (General) for a bare load with no deep-link', () => {
    expect(initialProjectIdFromLocation('', projects)).toBeNull()
    expect(initialProjectIdFromLocation('?foo=bar', projects)).toBeNull()
  })
  it('reads a known ?project=<id>', () => {
    expect(initialProjectIdFromLocation('?project=p1', projects)).toBe('p1')
  })
  it('reads a known ?topic=<id> alias, and prefers ?project= when both present', () => {
    expect(initialProjectIdFromLocation('?topic=p2', projects)).toBe('p2')
    expect(initialProjectIdFromLocation('?project=p1&topic=p2', projects)).toBe('p1')
  })
  it('falls back to General for an unknown or malformed id', () => {
    expect(initialProjectIdFromLocation('?project=ghost', projects)).toBeNull()
    expect(initialProjectIdFromLocation('?project=', projects)).toBeNull()
    expect(initialProjectIdFromLocation('?project=bad%2Fslash', projects)).toBeNull()
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
  // ISSUES #40 — the owner's IANA zone rides the same connect query string.
  it('appends tz when a timezone is supplied', () => {
    const u = buildWsUrl('https:', 'h.test', 't', null, 'dev-1', 'America/New_York')
    expect(u).toContain('tz=America%2FNew_York')
  })
  it('omits tz when null / undefined / empty', () => {
    expect(buildWsUrl('https:', 'h.test', 't', null, 'dev-1', null)).not.toContain('tz=')
    expect(buildWsUrl('https:', 'h.test', 't', null, 'dev-1')).not.toContain('tz=')
    expect(buildWsUrl('https:', 'h.test', 't', null, 'dev-1', '')).not.toContain('tz=')
  })
})

describe('detectClientTimezone', () => {
  it('returns the runtime IANA zone (a non-empty string in the bun test env)', () => {
    const tz = detectClientTimezone()
    // The test runtime always resolves a zone; assert it is a plausible IANA id.
    expect(typeof tz).toBe('string')
    expect((tz as string).length).toBeGreaterThan(0)
    // A real IANA identifier constructs cleanly with Intl.
    expect(() => new Intl.DateTimeFormat(undefined, { timeZone: tz as string })).not.toThrow()
  })
  it('returns the resolved zone when the injected resolver yields one', () => {
    expect(detectClientTimezone(() => 'America/New_York')).toBe('America/New_York')
  })
  // BLOCKER 2 mutation-kill — removing the try/catch or the empty/missing guard
  // reddens these (each would otherwise return '' / throw instead of null).
  it('returns null when Intl THROWS', () => {
    expect(
      detectClientTimezone(() => {
        throw new RangeError('no Intl timezone support')
      }),
    ).toBeNull()
  })
  it('returns null when the resolver yields empty / missing', () => {
    expect(detectClientTimezone(() => '')).toBeNull()
    expect(detectClientTimezone(() => undefined)).toBeNull()
  })
  it('a null detection makes the ws url OMIT tz (no empty tz= param)', () => {
    const noTz = detectClientTimezone(() => {
      throw new Error('boom')
    })
    const u = buildWsUrl('https:', 'h.test', 't', null, 'dev-1', noTz)
    expect(u).not.toContain('tz=')
  })
})

describe('resolveBootstrapConfig threads the detected timezone', () => {
  it('sets config.timeZone and includes tz on the initial ws url', () => {
    const cfg = resolveBootstrapConfig(win({ __neutron_user_id: 'sam' }))
    // The detected zone (always present in the test env) is captured on the
    // config AND rides the initial bootstrap ws url.
    expect(typeof cfg.timeZone).toBe('string')
    expect((cfg.timeZone as string).length).toBeGreaterThan(0)
    expect(cfg.wsUrl).toContain('tz=')
  })
})

// ISSUES #40 — the URL FACTORY the controller calls for EVERY connect (initial,
// project switch, reconnect). This is the mutation-kill for BLOCKER 1: dropping
// `config.timeZone` from the per-scope build (as the old main.tsx `wsUrlFor` did)
// reddens these.
describe('wsUrlForScope — per-connect url factory carries tz', () => {
  function cfg(over: Partial<BootstrapConfig> = {}): BootstrapConfig {
    return {
      wsUrl: 'wss://h.test/ws/app/chat?platform=web&token=t',
      topicId: 'app:sam',
      userId: 'sam',
      projectId: null,
      projects: [],
      origin: 'https://h.test',
      deviceId: 'dev-1',
      timeZone: 'America/New_York',
      token: 'dev:sam',
      ...over,
    }
  }

  it('carries tz on the General (null project) socket url', () => {
    expect(wsUrlForScope(cfg(), null)).toContain('tz=America%2FNew_York')
  })

  it('carries tz on a PROJECT-SWITCH socket url (not just the initial connect)', () => {
    const u = wsUrlForScope(cfg(), 'proj-9')
    expect(u).toContain('project_id=proj-9')
    expect(u).toContain('tz=America%2FNew_York')
  })

  it('omits tz when the runtime resolved no zone (timeZone null or absent)', () => {
    expect(wsUrlForScope(cfg({ timeZone: null }), 'proj-9')).not.toContain('tz=')
    // Field entirely absent (older config literal) → also omits tz.
    const { timeZone: _omit, ...noTz } = cfg()
    expect(wsUrlForScope(noTz as BootstrapConfig, 'proj-9')).not.toContain('tz=')
  })

  it('honors an explicit wsUrlOverride verbatim (dev/test single fixed socket)', () => {
    const u = wsUrlForScope(cfg({ wsUrlOverride: 'wss://fixed.test/ws' }), 'proj-9')
    expect(u).toBe('wss://fixed.test/ws')
  })
})

describe('resolveBootstrapConfig', () => {
  it('derives user id + topic + ws url from a stashed start token', () => {
    const cfg = resolveBootstrapConfig(win({ __neutron_start_token: jwt({ sub: 'sam' }) }))
    expect(cfg.userId).toBe('sam')
    expect(cfg.topicId).toBe('app:sam')
    expect(cfg.wsUrl).toContain('wss://sam.neutron.test/ws/app/chat')
    // Default app-ws token is the dev-bypass form — surfaced bare for the
    // attachment upload/render auth as well as carried on the WS URL.
    expect(cfg.wsUrl).toContain('token=dev%3Asam')
    expect(cfg.token).toBe('dev:sam')
    expect(cfg.origin).toBe('https://sam.neutron.test')
  })

  it('reads the start token from the URL when not stashed', () => {
    const cfg = resolveBootstrapConfig(
      win({ location: { protocol: 'https:', host: 'h.test', search: `?start=${jwt({ sub: 'q' })}`, pathname: '/chat' } }),
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

  it('carries the injected project list', () => {
    const cfg = resolveBootstrapConfig(
      win({ __neutron_user_id: 'sam', __neutron_projects: [{ id: 'p1', label: 'Work' }] }),
    )
    expect(cfg.projects).toEqual([{ id: 'p1', label: 'Work' }])
  })

  // #375 — a bare `/chat` load (no topic/project deep-link) must open on GENERAL,
  // NOT the arbitrary first project the server injects. This FAILS on the old code
  // (which read `__neutron_active_project_id` and returned 'p1').
  it('#375 — defaults a bare /chat load to General even when a project is injected', () => {
    const cfg = resolveBootstrapConfig(
      win({
        __neutron_user_id: 'sam',
        __neutron_projects: [{ id: 'p1', label: 'Work' }],
        __neutron_active_project_id: 'p1',
        location: { protocol: 'https:', host: 'sam.neutron.test', search: '', pathname: '/chat' },
      }),
    )
    expect(cfg.projectId).toBeNull()
    expect(cfg.wsUrl).not.toContain('project_id=')
  })

  // #375 — a `?project=<id>` deep-link still opens that project (regression guard
  // for the deep-link path the fix must preserve).
  it('#375 — a ?project=<id> deep-link opens that project when it is known', () => {
    const cfg = resolveBootstrapConfig(
      win({
        __neutron_user_id: 'sam',
        __neutron_projects: [{ id: 'p1', label: 'Work' }],
        location: {
          protocol: 'https:',
          host: 'sam.neutron.test',
          search: '?project=p1',
          pathname: '/chat',
        },
      }),
    )
    expect(cfg.projectId).toBe('p1')
    expect(cfg.wsUrl).toContain('project_id=p1')
  })

  // #375 — the `?topic=<id>` alias works the same way.
  it('#375 — a ?topic=<id> deep-link alias also opens that project', () => {
    const cfg = resolveBootstrapConfig(
      win({
        __neutron_user_id: 'sam',
        __neutron_projects: [{ id: 'p2', label: 'Home' }],
        location: {
          protocol: 'https:',
          host: 'sam.neutron.test',
          search: '?topic=p2',
          pathname: '/chat',
        },
      }),
    )
    expect(cfg.projectId).toBe('p2')
  })

  // #375 — an unknown / stale / garbage deep-link falls back to General, never a
  // dead scope the rail can't represent.
  it('#375 — an unknown deep-link project falls back to General', () => {
    const cfg = resolveBootstrapConfig(
      win({
        __neutron_user_id: 'sam',
        __neutron_projects: [{ id: 'p1', label: 'Work' }],
        location: {
          protocol: 'https:',
          host: 'sam.neutron.test',
          search: '?project=ghost',
          pathname: '/chat',
        },
      }),
    )
    expect(cfg.projectId).toBeNull()
  })

  it('throws ChatBootstrapError when no identity can be derived', () => {
    expect(() => resolveBootstrapConfig(win())).toThrow(ChatBootstrapError)
  })

  it('BUG 1 — defaults onboardingActive to false and reads the server flag when set', () => {
    expect(resolveBootstrapConfig(win({ __neutron_user_id: 'sam' })).onboardingActive).toBe(false)
    expect(
      resolveBootstrapConfig(win({ __neutron_user_id: 'sam', __neutron_onboarding_active: true })).onboardingActive,
    ).toBe(true)
  })

  it('claim redirect — postOnboardingClaimUrl is undefined by default (Open self-host)', () => {
    expect(
      resolveBootstrapConfig(win({ __neutron_user_id: 'sam' })).postOnboardingClaimUrl,
    ).toBeUndefined()
  })

  it('claim redirect — reads the injected claim URL when present (Managed)', () => {
    expect(
      resolveBootstrapConfig(
        win({
          __neutron_user_id: 'sam',
          __neutron_post_onboarding_claim_url: 'https://claim.example.test',
        }),
      ).postOnboardingClaimUrl,
    ).toBe('https://claim.example.test')
  })

  it('claim redirect — ignores an empty injected URL (treated as absent)', () => {
    expect(
      resolveBootstrapConfig(
        win({ __neutron_user_id: 'sam', __neutron_post_onboarding_claim_url: '' }),
      ).postOnboardingClaimUrl,
    ).toBeUndefined()
  })

  it('doc-link deep link — parses initialDocLink from a hard-loaded /projects/<id>/docs URL', () => {
    const cfg = resolveBootstrapConfig(
      win({
        __neutron_user_id: 'sam',
        location: {
          protocol: 'https:',
          host: 'sam.neutron.test',
          pathname: '/projects/acme/docs',
          search: '?path=pitch-deck.md',
        },
      }),
    )
    expect(cfg.initialDocLink).toEqual({ projectId: 'acme', path: 'pitch-deck.md' })
  })

  it('doc-link deep link — initialDocLink is undefined on a normal /chat boot', () => {
    expect(
      resolveBootstrapConfig(win({ __neutron_user_id: 'sam' })).initialDocLink,
    ).toBeUndefined()
  })
})
