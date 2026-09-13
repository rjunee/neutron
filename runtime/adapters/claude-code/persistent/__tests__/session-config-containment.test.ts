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
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { replSessionConfigPaths } from '../session-config-paths.ts'
import { ReplSession, unlinkSessionConfigs } from '../repl-session.ts'
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


describe('cleanup checks the FILESYSTEM, because the lexical check cannot see a symlink', () => {
  /**
   * ARGUS r28. `replSessionConfigPaths` resolves textually and checks the prefix — a real
   * question ("could this string ever name something outside the temp dir") and only that
   * one. `/tmp/neutron-repl-<32hex>` passes every lexical test while BEING A SYMLINK to
   * somewhere else, and `unlinkSessionConfigs` is the site that follows it.
   *
   * The check belongs at the destructive site, not in the builder: the builder runs at
   * SPAWN time, before the directory exists, so a `realpath` there would throw on a
   * legitimate first spawn. Here the directory exists and the question is answerable.
   */
  const dirs: string[] = []
  /** Directories deliberately created OUTSIDE `tmpdir()`, removed by the cleanup case. */
  const outsideDirs: string[] = []
  /** A session carrying exactly the paths cleanup would unlink. */
  const sessionWith = (paths: string[]): ReplSession => {
    const s = new ReplSession('k', 'gen', 'aaaaaaaa-1111-2222-3333-444444444444', GENERATED, '/tmp')
    s.configPaths = paths
    return s
  }

  it('REFUSES to unlink through a symlinked directory, and the target survives', () => {
    // The victim: a directory GENUINELY OUTSIDE the temp tree, holding a file with the
    // name cleanup deletes. Built for real — a mocked fs would prove only that a mock was
    // called.
    //
    // UNDER THE HOME DIRECTORY, NOT A SCRATCH DIR. The first version of this case put the
    // victim in `mkdtempSync(join(tmpdir(), …))` and the case failed: on this box the
    // worktree itself lives under `/tmp`, so a "scratch" directory is INSIDE `tmpdir()`
    // and the containment check correctly allowed the delete. A fixture meant to be
    // outside a boundary has to be outside it on the machine the test runs on.
    const victimRoot = mkdtempSync(join(homedir(), '.neutron-539-victim-'))
    outsideDirs.push(victimRoot)
    const victim = join(victimRoot, 'victim')
    mkdirSync(victim, { recursive: true })
    const victimFile = join(victim, 'session-mcp.json')
    writeFileSync(victimFile, '{"credential":"do not delete me"}')

    // The attack: a session directory inside tmpdir() whose name is perfectly conforming
    // and which IS a symlink to the victim.
    const linkDir = join(tmpdir(), `neutron-repl-${GENERATED}-r28`)
    rmSync(linkDir, { recursive: true, force: true })
    symlinkSync(victim, linkDir)
    dirs.push(linkDir)

    // The lexical layer is satisfied — this is exactly the gap.
    const linked = join(linkDir, 'session-mcp.json')
    expect(resolve(linked).startsWith(resolve(tmpdir()) + sep)).toBe(true)

    unlinkSessionConfigs(sessionWith([linked]))

    // THE ASSERTION THAT CARRIES IT: the stranger's file is still there.
    expect(existsSync(victimFile)).toBe(true)
  })

  it('a file directly under the TEMP ROOT survives cleanup — the two layers agree on equality', () => {
    // ARGUS r34. The cleanup guard read `real !== root && !real.startsWith(root + sep)`, so
    // a directory resolving to the temp ROOT satisfied neither disjunct and the unlink ran
    // — while `replSessionConfigPaths` explicitly refuses that same equality. The stricter
    // check was the one that only builds paths; the looser one the one that deletes.
    //
    // THE FIXTURE PUTS THE FILE AT THE ROOT ITSELF, not one level down. A file in
    // `mkdtempSync(join(tmpdir(), …))` is NESTED and would be deleted correctly by either
    // version — the same mistake as round twenty-eight's "outside" victim that was
    // actually inside, one level in rather than one level out.
    const atRoot = join(tmpdir(), `session-mcp-r34-${process.pid}.json`)
    writeFileSync(atRoot, '{"credential":"loose in the temp root"}')
    // The premise: its directory really IS tmpdir(), not a subdirectory of it.
    expect(resolve(dirname(atRoot))).toBe(resolve(tmpdir()))

    unlinkSessionConfigs(sessionWith([atRoot]))

    expect(existsSync(atRoot)).toBe(true)
    rmSync(atRoot, { force: true })
  })

  it('THE POSITIVE CONTROL: an ordinary real directory under tmpdir IS cleaned up', () => {
    // Second job: without this, a check that refused everything would satisfy the case
    // above while leaving every real child's plaintext credential file on disk forever.
    const real = join(tmpdir(), `neutron-repl-${GENERATED}-r28-real`)
    rmSync(real, { recursive: true, force: true })
    mkdirSync(real, { recursive: true })
    dirs.push(real)
    const f = join(real, 'session-mcp.json')
    writeFileSync(f, '{}')
    expect(existsSync(f)).toBe(true)

    unlinkSessionConfigs(sessionWith([f]))

    expect(existsSync(f)).toBe(false)
  })

  it('cleanup: scratch dirs', () => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    for (const d of outsideDirs.splice(0)) rmSync(d, { recursive: true, force: true })
    expect(dirs).toEqual([])
    expect(outsideDirs).toEqual([])
  })
})
