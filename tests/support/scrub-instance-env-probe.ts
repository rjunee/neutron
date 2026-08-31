/**
 * Child-process probe for `scrub-instance-env.test.ts`.
 *
 * NOT a test file — the name deliberately does not match `*.test.*` so neither
 * bun's discovery nor `scripts/run-tests.sh` ever picks it up as a suite file.
 * It is spawned by the self-test with a deliberately POISONED live-instance
 * env, imports the preload, and asserts the post-scrub state from inside a
 * process whose environment nothing else can mutate. Asserting the same thing
 * inline in a test would race: bun runs test files concurrently in ONE process
 * and `process.env` is process-global, so a neighbour's `createIsolatedHome`
 * could set NEUTRON_HOME/NEUTRON_DB_PATH mid-assertion.
 *
 * Prints `SCRUB_OK` and exits 0 on success; throws (nonzero exit) otherwise.
 */
// The scrub is a side-effect import and must be the FIRST module evaluated.
import './scrub-instance-env.ts'

import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveOpenDbPath } from '@neutronai/migrations/db-path.ts'

for (const key of [
  'NEUTRON_DB_PATH',
  'OWNER_HOME',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_IDENTITY_JWKS_URL',
]) {
  if (process.env[key] !== undefined) {
    throw new Error(`expected ${key} to be scrubbed, got ${String(process.env[key])}`)
  }
}

if (process.env['NEUTRON_TEST_SHARD'] !== 'sentinel-1/1') {
  throw new Error(
    `expected NEUTRON_TEST_SHARD to SURVIVE the scrub, got ${String(process.env['NEUTRON_TEST_SHARD'])}`,
  )
}

const home = process.env['NEUTRON_HOME']
if (!home) throw new Error('expected NEUTRON_HOME to be set to a scratch dir')
if (!home.includes('neutron-test-home-')) {
  throw new Error(`expected a neutron-test-home- scratch dir, got ${home}`)
}
if (!home.startsWith(tmpdir())) {
  throw new Error(`expected the scratch home under ${tmpdir()}, got ${home}`)
}
if (!statSync(home).isDirectory()) {
  throw new Error(`expected the scratch home to exist as a directory, got ${home}`)
}

const resolved = resolveOpenDbPath(process.env)
const expected = join(home, 'project.db')
if (resolved !== expected) {
  throw new Error(`expected the db to resolve to ${expected}, got ${resolved}`)
}

console.log('SCRUB_OK')
