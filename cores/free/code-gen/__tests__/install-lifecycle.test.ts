import { asOwnerHandle } from '@neutronai/persistence/index.ts'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildBundledRegistry,
  installCore,
  uninstallCore,
} from '@neutronai/cores-runtime'
import {
  NoopPrompter,
  copyCoreIntoFixture,
  createInstallLifecycleEnv,
  destroyInstallLifecycleEnv,
  type InstallLifecycleEnv,
} from '@neutronai/cores-runtime/testkit/install-lifecycle.ts'

import {
  CORE_PACKAGE_NAME,
  CORE_SLUG,
  READ_CAPABILITY,
  WRITE_CAPABILITY,
  loadManifest,
} from '../src/manifest.ts'

/**
 * The Code-Gen Core source on disk lives at
 * `<repo-root>/cores/free/code-gen/`. Tests need to install the Core
 * via the runtime lifecycle, which reads from a
 * `<coreDir>/package.json`. We copy the Core directory into a tmp
 * fixture so each test runs against an isolated rootDir the
 * bundled-Core registry can walk.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const CODEGEN_SRC_DIR = join(HERE, '..')

let env: InstallLifecycleEnv

beforeEach(() => {
  env = createInstallLifecycleEnv('codegen-install-')
})

afterEach(() => {
  destroyInstallLifecycleEnv(env)
})

function copyCodegenIntoFixture(
  fixtureRoot: string,
  mountedAs = 'code-gen',
): string {
  return copyCoreIntoFixture(CODEGEN_SRC_DIR, fixtureRoot, mountedAs)
}

describe('install lifecycle — Code-Gen Core round-trip', () => {
  test('installCore: validates manifest, records core_installations row, no secrets prompted', async () => {
    const coreDir = copyCodegenIntoFixture(env.tmp)
    const prompter = new NoopPrompter()
    const result = await installCore({
      owner_slug: asOwnerHandle('owner_a'),
      coreDir,
      projectDb: env.projectDb,
      dataDir: env.dataDir,
      secretsStore: env.secretsStore,
      audit: env.audit,
      installations: env.installations,
      prompter,
    })

    expect(result.core.slug).toBe(CORE_SLUG)
    expect(result.core.package_name).toBe(CORE_PACKAGE_NAME)
    // Code-Gen declares `.tasks`-suffixed top-level capabilities (not
    // `.db`), so the runtime's `decideDataLayout` falls through to the
    // `tables` layout for instance-level Core-installations bookkeeping.
    // S1 introduces a per-project sidecar at
    // `<OWNER_HOME>/Projects/<id>/code-gen/code-gen.db` — that
    // sidecar is opened lazily by the `CodegenSidecarResolver` (not
    // by the install pipeline), so the install lifecycle still
    // resolves to `tables`.
    expect(result.namespace.layout).toBe('tables')
    expect(result.installation.uninstalled_at).toBeNull()
    expect(result.installation.data_layout).toBe('tables')

    // Code-Gen declares zero secrets — no secrets prompts must fire.
    const rows = await env.audit.list({
      owner_slug: asOwnerHandle('owner_a'),
      core_slug: CORE_SLUG,
    })
    expect(rows.filter((r) => r.op === 'put')).toHaveLength(0)
  })

  test('installCore + uninstallCore round-trip marks the row uninstalled', async () => {
    const coreDir = copyCodegenIntoFixture(env.tmp)
    const prompter = new NoopPrompter()
    await installCore({
      owner_slug: asOwnerHandle('owner_b'),
      coreDir,
      projectDb: env.projectDb,
      dataDir: env.dataDir,
      secretsStore: env.secretsStore,
      audit: env.audit,
      installations: env.installations,
      prompter,
    })

    await uninstallCore({
      owner_slug: asOwnerHandle('owner_b'),
      core_slug: CORE_SLUG,
      projectDb: env.projectDb,
      dataDir: env.dataDir,
      secretsStore: env.secretsStore,
      audit: env.audit,
      installations: env.installations,
    })

    const after = await env.installations.get('owner_b', CORE_SLUG)
    expect(after).not.toBeNull()
    expect(after?.uninstalled_at).not.toBeNull()
  })
})

describe('bundled registry — Code-Gen Core discovery', () => {
  test('buildBundledRegistry against a single-root layout discovers Code-Gen', () => {
    const root = env.tmp
    copyCodegenIntoFixture(root)

    const reg = buildBundledRegistry({ rootDir: root })
    const slugs = reg.list().map((c) => c.slug).sort()
    expect(slugs).toContain(CORE_SLUG)
    const codegen = reg.get(CORE_SLUG)
    expect(codegen?.package_name).toBe(CORE_PACKAGE_NAME)
    expect(codegen?.manifest.capabilities).toContain(READ_CAPABILITY)
    expect(codegen?.manifest.capabilities).toContain(WRITE_CAPABILITY)
  })
})

describe('loadManifest pulls the package.json shipped on disk', () => {
  test('the shipped package.json validates clean against the runtime loader', () => {
    expect(() => loadManifest()).not.toThrow()
  })
})
