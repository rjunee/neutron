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
 *
 * AND THE SETTINGS PATH (2026-08-09). Reading env alone meant a self-hoster could
 * not enable the second model family AT ALL — there is no supported way to set a
 * gateway env var from inside the product, so K3 was reachable only by whoever
 * could edit the service unit. A key filed in settings under the `kimi` service now
 * counts, with env still winning so an existing deployment is unchanged. The
 * subprocess property is asserted too: the reviewer reads `KIMI_API_KEY` from ITS
 * OWN environment, so a stored key that never reaches the environment would report
 * configured and then defer in the child — and a deferred reviewer BLOCKS the
 * verdict, which is strictly worse than being unconfigured.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createIsolatedHome, type IsolatedHome } from '../support/test-isolation.ts'

import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import { buildOpenGraphComposer } from '@neutronai/open/composer.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import { KIMI_CREDENTIAL_SERVICE } from '@neutronai/trident/kimi-key.ts'
import { openMigratedDbAt } from '../support/migrated-db.ts'

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

/** File a key under the `kimi` service exactly as the settings pane does. */
async function storeKimiKeyInSettings(value: string): Promise<void> {
  const db = openMigratedDbAt(process.env['NEUTRON_DB_PATH']!)
  const secrets = new SecretsStore({ data_dir: process.env['NEUTRON_HOME']!, db })
  const creds = new ProjectCredentialStore(db, { crypto: secrets })
  await creds.set(asOwnerHandle(SLUG), {
    service: KIMI_CREDENTIAL_SERVICE,
    plaintext: value,
    scope: 'global',
  })
  db.close()
}

async function resolverFromComposer(): Promise<() => boolean> {
  const db = openMigratedDbAt(process.env['NEUTRON_DB_PATH']!)
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

    // The owner saves the key in settings after the gateway booted. Read-at-call
    // is what makes this take effect on the next run instead of the next restart.
    // REWRITTEN 2026-08-09: this used to set the ENV VAR, which no longer feeds
    // resolution at all — the store is the only source now.
    await storeKimiKeyInSettings('sk-kimi-set-after-boot')
    expect(resolve()).toBe(true)
  })

  test('an EMPTY key counts as not configured, not as configured-with-nothing', async () => {
    // An empty string would otherwise reach the CLI, which would report
    // not_connected anyway — but resolving it as "configured" would spawn a whole
    // panelist agent to discover that, on every single run.
    const resolve = await resolverFromComposer()
    process.env['KIMI_API_KEY'] = ''
    expect(resolve()).toBe(false)
  })

  test('a key entered in SETTINGS turns the panelist on, with no env var at all', async () => {
    // The whole point: a self-hoster who can reach the settings pane and nothing
    // else can now use the K3 reviewer.
    await storeKimiKeyInSettings('sk-kimi-from-settings')
    const resolve = await resolverFromComposer()
    expect(resolve()).toBe(true)
  })

  test('the stored key reaches the ENVIRONMENT, because the reviewer is a subprocess', async () => {
    // `trident/kimi-review-cli.ts` reads KIMI_API_KEY from its own process env —
    // that indirection is what keeps the key out of prompt text. Resolving
    // `configured: true` without exporting it would spawn a panelist that defers,
    // and a deferred cross-model reviewer BLOCKS the verdict: every review would
    // come back REQUEST_CHANGES for a reason the owner cannot see.
    await storeKimiKeyInSettings('sk-kimi-must-reach-the-child')
    const resolve = await resolverFromComposer()
    expect(resolve()).toBe(true)
    expect(process.env['KIMI_API_KEY']).toBe('sk-kimi-must-reach-the-child')
  })

  test('INVERTED 2026-08-09: the STORE wins over an env var — the settings screen is the truth', async () => {
    // This used to assert the OPPOSITE ("ENV WINS — an existing deployment is
    // unchanged"), as a compatibility guarantee. The owner removed it: an env var
    // that beats the store is a second resolution path, and it fails in the
    // direction nobody checks — the owner pastes a new key, settings reports it
    // saved, and every review keeps using the shell's one with nothing reporting a
    // conflict.
    //
    // Inverted rather than deleted, so the reversal stays legible in history.
    await storeKimiKeyInSettings('sk-kimi-stored')
    process.env['KIMI_API_KEY'] = 'sk-kimi-stale-from-env'
    const resolve = await resolverFromComposer()
    expect(resolve()).toBe(true)
    // The exported value is the STORED one: the env var is now purely the channel
    // the resolved key travels to the child on, never a source.
    expect(process.env['KIMI_API_KEY']).toBe('sk-kimi-stored')
  })

  test('an env var ALONE no longer configures anything', async () => {
    // The other half. With nothing in the store, an exported key is not a
    // configuration — and the stale value is CLEARED rather than left for the
    // child to inherit.
    process.env['KIMI_API_KEY'] = 'sk-kimi-env-only'
    const resolve = await resolverFromComposer()
    expect(resolve()).toBe(false)
    expect(process.env['KIMI_API_KEY']).toBeUndefined()
  })
})
