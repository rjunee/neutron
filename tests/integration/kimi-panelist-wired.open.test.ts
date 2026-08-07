/**
 * KIMI K3 PANELIST — the DONE-MEANS-WIRED test.
 *
 * The reviewer module has its own unit tests and the workflow has its own source
 * assertions, and neither proves the panelist ever runs. The chain is four links
 * long — composer → composition input → `build-core-modules` → orchestrator →
 * workflow args — and a break at ANY link leaves `kimiConfigured` false forever,
 * which is indistinguishable from "no key configured": the graceful path. So the
 * failure mode is silent by design, and the only thing that catches it is
 * asserting on what the PRODUCTION COMPOSER actually emits (Decisions Log
 * 2026-08-01).
 *
 * The per-launch property is asserted too. The resolver must read the
 * environment when CALLED, not when composed — a key added after boot has to take
 * effect on the next run rather than the next restart, the same rule the GitHub
 * credential follows (Decisions Log 2026-08-07).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createIsolatedHome, type IsolatedHome } from '../support/test-isolation.ts'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'

const SLUG = 'owner'

let home: IsolatedHome

beforeEach(() => {
  home = createIsolatedHome({
    extraEnvKeys: [
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'NOTIFY_SOCKET',
      'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
      'KIMI_API_KEY',
    ],
    env: {
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-test-secret-0123456789',
      // A non-null LLM pool is what makes the composer emit `trident` at all.
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-kimi-wired',
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      NOTIFY_SOCKET: undefined,
      KIMI_API_KEY: undefined,
    },
  })
})

afterEach(() => {
  home.restore()
})

async function resolverFromComposer(): Promise<() => boolean> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const composition = await buildOpenGraphComposer({ env: process.env })({
    db,
    project_slug: SLUG,
  })
  const wiring = (composition as { trident?: { resolve_kimi_configured?: unknown } }).trident
  if (wiring === undefined || typeof wiring.resolve_kimi_configured !== 'function') {
    throw new Error(
      'composer did not supply trident.resolve_kimi_configured — the Kimi panelist can NEVER run',
    )
  }
  return wiring.resolve_kimi_configured as () => boolean
}

describe('the Kimi cross-model panelist is reachable from the production composer', () => {
  test('the composer supplies the resolver at all', async () => {
    const resolve = await resolverFromComposer()
    expect(typeof resolve).toBe('function')
  })

  test('with no key the panelist is OFF — the graceful, never-blocking path', async () => {
    const resolve = await resolverFromComposer()
    expect(resolve()).toBe(false)
  })

  test('a key added AFTER composition turns the panelist ON — no restart', async () => {
    const resolve = await resolverFromComposer()
    expect(resolve()).toBe(false)

    // The operator sets the key after the gateway booted. Read-at-call is what
    // makes this take effect on the next run instead of the next restart.
    process.env['KIMI_API_KEY'] = 'sk-kimi-set-after-boot'
    expect(resolve()).toBe(true)

    // And removing it turns the panelist back off, rather than latching on.
    delete process.env['KIMI_API_KEY']
    expect(resolve()).toBe(false)
  })

  test('an EMPTY key counts as not configured, not as configured-with-nothing', async () => {
    // An empty string would otherwise reach the CLI, which would report
    // not_connected anyway — but resolving it as "configured" would spawn a whole
    // panelist agent to discover that, on every single run.
    const resolve = await resolverFromComposer()
    process.env['KIMI_API_KEY'] = ''
    expect(resolve()).toBe(false)
  })
})
