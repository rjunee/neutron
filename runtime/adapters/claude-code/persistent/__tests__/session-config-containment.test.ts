/**
 * session-config-containment.test.ts — #539: a persisted channel name is a path input.
 *
 * THE CHAIN THIS PINS. `isMinimalRecord` accepted any string as `channelName`;
 * `replSessionConfigPaths` builds `join(tmpdir(), 'neutron-repl-' + channelName)` with no
 * containment check; adoption feeds it the PERSISTED value; and the child-exit path
 * UNLINKS what those paths point at. So a row carrying a parent-traversal name turned
 * "the registry is garbage" into "files outside the temp directory get deleted".
 *
 * Newly reachable via this branch: before adoption, the channel name was always one
 * `spawn.ts` had generated in-process moments earlier. Adoption is the first caller that
 * takes it from disk.
 *
 * TWO LAYERS, ASKING DIFFERENT QUESTIONS. The containment check in
 * `replSessionConfigPaths` makes the property TRUE for every caller including ones that do
 * not exist yet; the shape check in the registry makes a bad value visible early and
 * specific. Neither is sufficient alone, and both are pinned here.
 */

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { replSessionConfigPaths } from '../session-config-paths.ts'
import { loadRegistry } from '../repl-registry.ts'

/** The form `spawn.ts` emits: `neutron-` + randomBytes(16).toString('hex'). */
const GENERATED = `neutron-${'ab12cd34'.repeat(4)}`
/** The same shape the registry enforces, restated here so the case can assert it. */
const GENERATED_FORM = /^neutron-[0-9a-f]{32}$/

describe('replSessionConfigPaths refuses a name that escapes the temp directory', () => {
  const escapes: ReadonlyArray<readonly [string, string]> = [
    ['parent traversal', 'x/../../../some/dir'],
    ['many levels up', '../../../../../../etc'],
  ]

  for (const [label, name] of escapes) {
    it(`refuses ${label}`, () => {
      expect(() => replSessionConfigPaths(name)).toThrow(/outside the temp directory/)
    })
  }

  it('refuses the temp root itself', () => {
    // A name that resolves back up to exactly tmpdir() is not a session directory either,
    // and the equality case is easy to miss with a prefix test alone.
    expect(() => replSessionConfigPaths('../..')).toThrow(/outside the temp directory/)
  })

  it('PERMITS names that are odd but CONTAINED — which is why the shape check also exists', () => {
    // These were in the escape list on the first writing and they do not escape:
    // `join(tmpdir(), 'neutron-repl-' + name)` keeps all three under the temp directory,
    // so the containment check correctly allows them. My expectation was wrong, not the
    // code — and correcting it is the clearest demonstration of the coordinator's point
    // that the two layers answer DIFFERENT questions. Containment asks "could this delete
    // something outside the temp dir"; the registry's shape check asks "could this row
    // have been produced by this system at all". Only the second rejects these.
    for (const name of [`x${sep}y`, '../evil', `${sep}etc`]) {
      const root = resolve(tmpdir())
      expect(resolve(replSessionConfigPaths(name).dir).startsWith(root + sep)).toBe(true)
      // ...and the registry refuses them, which is the layer that actually stops them.
      expect(GENERATED_FORM.test(name)).toBe(false)
    }
  })

  it('THE POSITIVE CONTROL: a generated name still yields paths under the temp dir', () => {
    // Second job, and it is the one that matters: "reject everything" would satisfy every
    // case above while leaving every real child's credential files on disk forever,
    // because the exit path would no longer have paths to unlink.
    const paths = replSessionConfigPaths(GENERATED)
    const root = resolve(tmpdir())
    expect(resolve(paths.dir).startsWith(root + sep)).toBe(true)
    expect(paths.mcpConfigPath.endsWith('session-mcp.json')).toBe(true)
    expect(paths.settingsPath.endsWith('session-settings.json')).toBe(true)
    expect(paths.toolsManifestPath.endsWith('session-tools.json')).toBe(true)
  })
})

describe('the registry drops a row whose channel name is not the generated form', () => {
  const dirs: string[] = []
  const write = (rows: Record<string, unknown>): string => {
    const d = mkdtempSync(join(tmpdir(), 'neutron-539-chan-'))
    dirs.push(d)
    const p = join(d, 'repl-registry.json')
    writeFileSync(p, JSON.stringify(rows))
    return p
  }
  const row = (channelName: string): Record<string, unknown> => ({
    sessionKey: 'k',
    sessionId: 'aaaaaaaa-1111-2222-3333-444444444444',
    cwd: '/tmp',
    channelName,
    has_session: true,
  })

  const bad: ReadonlyArray<readonly [string, string]> = [
    ['a traversal', 'x/../../../some/dir'],
    ['a separator', `a${sep}b`],
    ['an embedded space', 'neutron- abc'],
    ['the wrong length', 'neutron-abcd'],
    ['uppercase hex', `neutron-${'AB12CD34'.repeat(4)}`],
    ['not generated at all', 'persisted-channel'],
  ]
  for (const [label, name] of bad) {
    it(`drops a row carrying ${label}`, () => {
      const p = write({ k: row(name) })
      expect(loadRegistry(p)['k']).toBeUndefined()
    })
  }

  it('THE POSITIVE CONTROL: a generated name is kept', () => {
    const p = write({ k: row(GENERATED) })
    expect(loadRegistry(p)['k']?.channelName).toBe(GENERATED)
  })

  it('and a bad row does not take its neighbours with it', () => {
    const p = write({ bad: row('x/../evil'), good: { ...row(GENERATED), sessionKey: 'good' } })
    expect(loadRegistry(p)['bad']).toBeUndefined()
    expect(loadRegistry(p)['good']).toBeDefined()
  })

  it('CLEANUP NEVER SEES IT: the escaping name cannot produce paths to unlink', () => {
    // The two layers composing. The row is dropped, so adoption reads `unreadable` (round
    // twenty) and refuses rather than reading absence — and even if a caller obtained the
    // name another way, the path builder refuses it. The deletion is unreachable from
    // both directions.
    const p = write({ k: row('x/../../../some/dir') })
    expect(loadRegistry(p)['k']).toBeUndefined()
    expect(() => replSessionConfigPaths('x/../../../some/dir')).toThrow()
  })

  it('cleanup: temp dirs', () => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    expect(dirs).toEqual([])
  })
})
