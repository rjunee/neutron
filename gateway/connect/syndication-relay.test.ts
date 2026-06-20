/**
 * M2.6 Ph0 — relay/issuer de-hardcode (brief § 3b / § 4 Phase 0.3, test § 6.8).
 *
 * `NEUTRON_SYNDICATION_RELAY_URL` is the ONE coherent client-side relay/issuer
 * pointer. When set, the issuer JWKS URL and the open-workspace base-URL target
 * the configured relay host (e.g. `connect.myorg.example`), NOT the implicit
 * subdomain authority default. When UNSET, every existing default is unchanged.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  resolveSyndicationRelayUrl,
  syndicationRelayJwksUrl,
  syndicationRelayInstanceTemplate,
  SYNDICATION_RELAY_URL_ENV,
} from './syndication-relay.ts'
import {
  readOpenInstanceBaseUrlTemplate,
  resolveOpenInstanceBaseUrl,
} from './open-instance-source-resolver.ts'

const RELAY = 'https://connect.myorg.example'

/**
 * ISSUES #219 — `resolveAuthJwksUrl` is a thin wrapper that lives in a
 * Managed-carved onboarding-orchestrator module the Open split strips, but its
 * entire fallback chain is built from the Open relay primitives imported
 * above (`resolveSyndicationRelayUrl` + `syndicationRelayJwksUrl`). This
 * verbatim mirror exercises the exact same precedence — explicit override →
 * `NEUTRON_AUTH_JWKS_URL` → relay-derived JWKS → `auth.<baseDomain>` default
 * — over those real Open building blocks, with no Managed import edge.
 */
function resolveAuthJwksUrl(
  override: string | undefined,
  baseDomain: string,
): string {
  if (override !== undefined && override !== '') return override
  const env = process.env['NEUTRON_AUTH_JWKS_URL']
  if (env !== undefined && env !== '') return env
  const relay = resolveSyndicationRelayUrl(process.env)
  if (relay !== undefined) return syndicationRelayJwksUrl(relay)
  return `https://auth.${baseDomain}/.well-known/jwks.json`
}

describe('resolveSyndicationRelayUrl', () => {
  test('returns undefined when unset / blank', () => {
    expect(resolveSyndicationRelayUrl({})).toBeUndefined()
    expect(resolveSyndicationRelayUrl({ [SYNDICATION_RELAY_URL_ENV]: '' })).toBeUndefined()
    expect(resolveSyndicationRelayUrl({ [SYNDICATION_RELAY_URL_ENV]: '   ' })).toBeUndefined()
  })

  test('resolves + strips trailing slash, trimmed', () => {
    expect(resolveSyndicationRelayUrl({ [SYNDICATION_RELAY_URL_ENV]: ` ${RELAY}/ ` })).toBe(RELAY)
  })
})

describe('syndication relay derivers', () => {
  test('JWKS URL targets the relay host (non-subdomain authority)', () => {
    expect(syndicationRelayJwksUrl(RELAY)).toBe(
      'https://connect.myorg.example/.well-known/jwks.json',
    )
  })
  test('workspace base-URL template is relay-prefixed with a {slug} placeholder', () => {
    expect(syndicationRelayInstanceTemplate(RELAY)).toBe(
      'https://connect.myorg.example/{slug}',
    )
  })
})

describe('open-workspace base-URL template — relay fallback', () => {
  test('explicit NEUTRON_OPEN_INSTANCE_BASE_URL still wins', () => {
    expect(
      readOpenInstanceBaseUrlTemplate({
        NEUTRON_OPEN_INSTANCE_BASE_URL: 'https://{slug}.neutron.example',
        [SYNDICATION_RELAY_URL_ENV]: RELAY,
      }),
    ).toBe('https://{slug}.neutron.example')
  })

  test('derives the template from the relay when the explicit var is unset', () => {
    const template = readOpenInstanceBaseUrlTemplate({ [SYNDICATION_RELAY_URL_ENV]: RELAY })
    expect(template).toBe('https://connect.myorg.example/{slug}')
    // …and the resolver produces a reachable non-subdomain-authority base URL.
    expect(resolveOpenInstanceBaseUrl('acme', { template: template! })).toBe(
      'https://connect.myorg.example/acme',
    )
  })

  test('unchanged when neither var is set (returns undefined)', () => {
    expect(readOpenInstanceBaseUrlTemplate({})).toBeUndefined()
  })
})

describe('resolveAuthJwksUrl — relay fallback (issuer de-hardcode)', () => {
  const saved: Record<string, string | undefined> = {}
  afterEach(() => {
    for (const k of ['NEUTRON_AUTH_JWKS_URL', SYNDICATION_RELAY_URL_ENV]) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })
  const setEnv = (k: string, v: string | undefined): void => {
    if (!(k in saved)) saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }

  test('explicit override wins over everything', () => {
    setEnv('NEUTRON_AUTH_JWKS_URL', undefined)
    setEnv(SYNDICATION_RELAY_URL_ENV, RELAY)
    expect(resolveAuthJwksUrl('https://explicit.example/jwks', 'neutron.example')).toBe(
      'https://explicit.example/jwks',
    )
  })

  test('NEUTRON_AUTH_JWKS_URL env beats the relay derivation', () => {
    setEnv('NEUTRON_AUTH_JWKS_URL', 'https://env.example/.well-known/jwks.json')
    setEnv(SYNDICATION_RELAY_URL_ENV, RELAY)
    expect(resolveAuthJwksUrl(undefined, 'neutron.example')).toBe(
      'https://env.example/.well-known/jwks.json',
    )
  })

  test('derives from the relay when override + NEUTRON_AUTH_JWKS_URL are unset', () => {
    setEnv('NEUTRON_AUTH_JWKS_URL', undefined)
    setEnv(SYNDICATION_RELAY_URL_ENV, RELAY)
    expect(resolveAuthJwksUrl(undefined, 'neutron.example')).toBe(
      'https://connect.myorg.example/.well-known/jwks.json',
    )
  })

  test('unchanged subdomain-authority default when nothing is set', () => {
    setEnv('NEUTRON_AUTH_JWKS_URL', undefined)
    setEnv(SYNDICATION_RELAY_URL_ENV, undefined)
    expect(resolveAuthJwksUrl(undefined, 'neutron.example')).toBe(
      'https://auth.neutron.example/.well-known/jwks.json',
    )
  })
})
