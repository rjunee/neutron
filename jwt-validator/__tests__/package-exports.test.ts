/**
 * package-exports.test.ts — the export map is a COMPATIBILITY SURFACE, and this
 * is the thing that measures it (#592).
 *
 * `"./*": "./*"` published every file in this package: `resolve-key.ts` and
 * `validator.ts` — the key-fetching and verification internals of
 * security-relevant code — were importable by any consumer, and therefore
 * something we could not change without breaking one.
 *
 * WHY THIS IS A TEST AND NOT A `package.json` SCRIPT. The narrowing shipped with
 * its proof in `npm run test:jwt-validator-exports`, a script that appears in no
 * workflow and in no `scripts/run-tests.sh` line — so after the merge nothing
 * would ever have run it again, and restoring the wildcard would have been
 * silent. A guard nothing executes is not a guard.
 *
 * BOTH DIRECTIONS, AND THE SECOND IS THE POINT. Asserting only that the
 * sanctioned entry still resolves cannot tell a narrowed map from the wildcard it
 * replaced — the wildcard satisfies that assertion too. So the internals must be
 * REFUSED, and the refusal must be a RESOLUTION refusal: `ERR_MODULE_NOT_FOUND`
 * naming the specifier, not merely "something threw", which a module that fails
 * to evaluate would also satisfy. (Measured: under `"./*": "./*"` these same
 * imports RESOLVE, so the catch below is about the map and nothing else.)
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
) as { exports: Record<string, string>; types?: string; typesVersions?: unknown }

describe('@neutronai/jwt-validator package exports', () => {
  // THE CONTROL THAT MUST SURVIVE. Every consumer in this repository imports one
  // of these two; a narrowing that broke them would be caught here rather than at
  // the call sites.
  test.each(['index.ts', 'claims.ts'])('the sanctioned entry point ./%s still resolves', async (file) => {
    const mod = await import(`@neutronai/jwt-validator/${file}`)
    expect(mod).toBeDefined()
  })

  test('the bare package specifier still resolves', async () => {
    expect(await import('@neutronai/jwt-validator')).toBeDefined()
  })

  test.each(['resolve-key.ts', 'validator.ts'])('the internal module ./%s is NOT importable', async (file) => {
    const specifier = `@neutronai/jwt-validator/${file}`
    const error = await import(specifier).then(() => null, (cause: unknown) => cause)
    expect(error).not.toBeNull()
    expect((error as { code?: string }).code).toBe('ERR_MODULE_NOT_FOUND')
    expect(String((error as Error).message)).toContain(specifier)
  })

  // A WILDCARD IN THE TYPES MAP WOULD RE-PUBLISH WHAT THE RUNTIME MAP DROPPED.
  // This package declares neither `types` nor `typesVersions` — consumers read
  // the `.ts` sources directly — so there is no second map to disagree with the
  // first. Pinned so that adding one later has to come past this.
  test('no map republishes the tree by wildcard', () => {
    expect(Object.keys(manifest.exports).filter((key) => key.includes('*'))).toEqual([])
    expect(Object.values(manifest.exports).filter((value) => value.includes('*'))).toEqual([])
    expect(manifest.typesVersions).toBeUndefined()
  })
})
