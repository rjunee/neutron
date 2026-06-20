/**
 * ISSUE #30 — PersonaPromptLoader unit tests.
 *
 * Surfaces under test:
 *   - reads all three persona files from <owner_home>/persona/*.md
 *   - missing-file skip (logs at info, returns empty block)
 *   - empty-file skip (trim()==='' logs + returns empty block)
 *   - mtime-keyed cache: first call reads, second call cache-hits, an
 *     out-of-band mtime advance triggers a fresh read.
 *   - invalidate(filename) drops one entry; invalidate() drops all
 *
 * Time-dependent contract: tests advance mtime explicitly via fs.utimes
 * (Date.now()-relative) so the suite survives across wall-clock weeks
 * per the "no hardcoded ISO" rule (internal design notes
 * watchdog-test-data-rot-stale-hardcoded-dates.md).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { stat, utimes, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PersonaPromptLoader, PERSONA_FILENAMES } from '../persona-loader.ts'

let tmpRoot: string
let personaDir: string

const SOUL_BODY = 'You are the agent. Be calm. Be direct.'
const USER_BODY = '- Name: Sam\n- TZ: PT'
const PMAP_BODY = 'P0 → drop everything\nP1 → today'

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'persona-loader-test-'))
  personaDir = join(tmpRoot, 'persona')
  mkdirSync(personaDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

function seed(filename: string, body: string): void {
  writeFileSync(join(personaDir, filename), body, 'utf8')
}

describe('load()', () => {
  test('returns empty string when persona/ dir is empty', async () => {
    const loader = new PersonaPromptLoader({ owner_home: tmpRoot, log: () => {} })
    const out = await loader.load()
    expect(out).toBe('')
  })

  test('returns empty string when owner_home has no persona/ dir', async () => {
    rmSync(personaDir, { recursive: true })
    const loader = new PersonaPromptLoader({ owner_home: tmpRoot, log: () => {} })
    const out = await loader.load()
    expect(out).toBe('')
  })

  test('concatenates all three files in SOUL → USER → priority-map order', async () => {
    seed('SOUL.md', SOUL_BODY)
    seed('USER.md', USER_BODY)
    seed('priority-map.md', PMAP_BODY)
    const loader = new PersonaPromptLoader({ owner_home: tmpRoot, log: () => {} })
    const out = await loader.load()
    expect(out).toContain(SOUL_BODY)
    expect(out).toContain(USER_BODY)
    expect(out).toContain(PMAP_BODY)
    // Order: SOUL first, USER second, priority-map last
    expect(out.indexOf(SOUL_BODY)).toBeLessThan(out.indexOf(USER_BODY))
    expect(out.indexOf(USER_BODY)).toBeLessThan(out.indexOf(PMAP_BODY))
  })

  test('wraps each file in <persona_file name="…"> tags', async () => {
    seed('SOUL.md', SOUL_BODY)
    seed('USER.md', USER_BODY)
    seed('priority-map.md', PMAP_BODY)
    const loader = new PersonaPromptLoader({ owner_home: tmpRoot, log: () => {} })
    const out = await loader.load()
    expect(out).toContain('<persona_file name="SOUL.md">')
    expect(out).toContain('<persona_file name="USER.md">')
    expect(out).toContain('<persona_file name="priority-map.md">')
    expect(out).toContain('</persona_file>')
  })

  test('skips missing files (logs at info) and returns blocks for present ones', async () => {
    seed('SOUL.md', SOUL_BODY)
    // USER.md missing
    seed('priority-map.md', PMAP_BODY)
    const logged: Array<{ level: string; msg: string; meta?: Record<string, unknown> }> = []
    const loader = new PersonaPromptLoader({
      owner_home: tmpRoot,
      log: (level, msg, meta) => logged.push({ level, msg, ...(meta !== undefined ? { meta } : {}) }),
    })
    const out = await loader.load()
    expect(out).toContain(SOUL_BODY)
    expect(out).toContain(PMAP_BODY)
    expect(out).not.toContain('USER.md')
    const missingLog = logged.find((l) => l.msg.includes("'USER.md' missing"))
    expect(missingLog).toBeDefined()
    expect(missingLog?.level).toBe('info')
  })

  test("skips empty files (trim()==='') with an info log line", async () => {
    seed('SOUL.md', SOUL_BODY)
    seed('USER.md', '   \n\t  \n') // all whitespace → trim() === ''
    seed('priority-map.md', PMAP_BODY)
    const logged: Array<{ level: string; msg: string }> = []
    const loader = new PersonaPromptLoader({
      owner_home: tmpRoot,
      log: (level, msg) => logged.push({ level, msg }),
    })
    const out = await loader.load()
    expect(out).toContain(SOUL_BODY)
    expect(out).toContain(PMAP_BODY)
    // The whitespace-only USER block must NOT appear under any wrapper.
    expect(out).not.toContain('<persona_file name="USER.md">')
    const emptyLog = logged.find((l) => l.msg.includes("'USER.md' is empty"))
    expect(emptyLog).toBeDefined()
    expect(emptyLog?.level).toBe('info')
  })

  test('returns empty string when every file is missing/empty', async () => {
    seed('SOUL.md', '')
    seed('USER.md', '   ')
    // priority-map missing
    const loader = new PersonaPromptLoader({ owner_home: tmpRoot, log: () => {} })
    const out = await loader.load()
    expect(out).toBe('')
  })
})

describe('mtime-keyed cache', () => {
  test('first load reads, second load (same mtime) returns identical content from cache', async () => {
    seed('SOUL.md', SOUL_BODY)
    const loader = new PersonaPromptLoader({ owner_home: tmpRoot, log: () => {} })
    const first = await loader.load()
    expect(first).toContain(SOUL_BODY)
    // Overwrite the file body but DO NOT advance the mtime — cache must
    // still return the original body on the next call (it trusts mtime).
    const target = join(personaDir, 'SOUL.md')
    const st = await stat(target)
    writeFileSync(target, 'STALE_NEW_BODY', 'utf8')
    // Force the mtime back to the original so the cache hit fires.
    await utimes(target, st.atime, st.mtime)
    const second = await loader.load()
    expect(second).toBe(first)
    expect(second).not.toContain('STALE_NEW_BODY')
  })

  test('mtime advance triggers a fresh read on the next load', async () => {
    seed('SOUL.md', SOUL_BODY)
    const loader = new PersonaPromptLoader({ owner_home: tmpRoot, log: () => {} })
    const first = await loader.load()
    expect(first).toContain(SOUL_BODY)
    // Rewrite + advance mtime by 5s into the future (Date.now()-relative
    // so this test doesn't rot — `now + 5s` always > original mtime).
    const target = join(personaDir, 'SOUL.md')
    writeFileSync(target, 'NEW_SOUL_BODY', 'utf8')
    const future = new Date(Date.now() + 5000)
    await utimes(target, future, future)
    const second = await loader.load()
    expect(second).toContain('NEW_SOUL_BODY')
    expect(second).not.toContain(SOUL_BODY)
  })

  test('invalidate(filename) drops the single entry; next load re-reads from disk', async () => {
    seed('SOUL.md', SOUL_BODY)
    const loader = new PersonaPromptLoader({ owner_home: tmpRoot, log: () => {} })
    const first = await loader.load()
    expect(first).toContain(SOUL_BODY)
    // Rewrite the file but keep the original mtime — without invalidate
    // the cache would return the stale body.
    const target = join(personaDir, 'SOUL.md')
    const st = await stat(target)
    writeFileSync(target, 'INVALIDATED_BODY', 'utf8')
    await utimes(target, st.atime, st.mtime)
    loader.invalidate('SOUL.md')
    const second = await loader.load()
    // Re-read from disk picks up the new body even though mtime is same.
    const onDisk = await readFile(target, 'utf8')
    expect(onDisk).toBe('INVALIDATED_BODY')
    expect(second).toContain('INVALIDATED_BODY')
  })

  test('invalidate() with no args drops every entry', async () => {
    seed('SOUL.md', SOUL_BODY)
    seed('USER.md', USER_BODY)
    seed('priority-map.md', PMAP_BODY)
    const loader = new PersonaPromptLoader({ owner_home: tmpRoot, log: () => {} })
    await loader.load() // populate
    // Rewrite all three with new bodies but keep mtimes pinned.
    for (const fname of PERSONA_FILENAMES) {
      const target = join(personaDir, fname)
      const st = await stat(target)
      writeFileSync(target, `INVALIDATED_${fname}`, 'utf8')
      await utimes(target, st.atime, st.mtime)
    }
    loader.invalidate()
    const out = await loader.load()
    expect(out).toContain('INVALIDATED_SOUL.md')
    expect(out).toContain('INVALIDATED_USER.md')
    expect(out).toContain('INVALIDATED_priority-map.md')
  })

  test('invalidate(filename) for a missing entry is a no-op (does not throw)', () => {
    const loader = new PersonaPromptLoader({ owner_home: tmpRoot, log: () => {} })
    expect(() => loader.invalidate('SOUL.md')).not.toThrow()
    expect(() => loader.invalidate()).not.toThrow()
  })

  test('deleted file (post-cache) evicts the entry so a re-create cold-loads', async () => {
    seed('SOUL.md', SOUL_BODY)
    const loader = new PersonaPromptLoader({ owner_home: tmpRoot, log: () => {} })
    await loader.load() // populate cache
    rmSync(join(personaDir, 'SOUL.md'))
    const afterDelete = await loader.load()
    expect(afterDelete).not.toContain(SOUL_BODY)
    expect(afterDelete).toBe('')
    // Re-create with new body — the deleted-eviction means we cold-load.
    seed('SOUL.md', 'RESURRECTED_BODY')
    const afterResurrect = await loader.load()
    expect(afterResurrect).toContain('RESURRECTED_BODY')
  })
})

describe('symlink rejection (ISSUE #37)', () => {
  test('SOUL.md as symlink to outside-persona file → skipped + warn log + USER/priority-map load normally', async () => {
    // Sentinel attack target: a file outside <owner_home>/persona/ with
    // distinctive content that MUST NOT leak into the system prompt.
    const sentinel = join(tmpRoot, 'sentinel-attack-target.txt')
    writeFileSync(sentinel, 'ATTACK_PAYLOAD_DO_NOT_LEAK', 'utf8')

    symlinkSync(sentinel, join(personaDir, 'SOUL.md'))
    seed('USER.md', USER_BODY)
    seed('priority-map.md', PMAP_BODY)

    const logged: Array<{ level: string; msg: string }> = []
    const loader = new PersonaPromptLoader({
      owner_home: tmpRoot,
      log: (level, msg) => logged.push({ level, msg }),
    })
    const out = await loader.load()

    // Security: symlink target body must NOT reach the system prompt.
    expect(out).not.toContain('ATTACK_PAYLOAD_DO_NOT_LEAK')
    // SOUL.md block must be absent entirely (no wrapper either).
    expect(out).not.toContain('<persona_file name="SOUL.md">')
    // Other persona files still load.
    expect(out).toContain(USER_BODY)
    expect(out).toContain(PMAP_BODY)

    const rejectLog = logged.find((l) => l.msg.includes('rejected: symlink'))
    expect(rejectLog).toBeDefined()
    expect(rejectLog?.level).toBe('warn')
    expect(rejectLog?.msg).toContain('SOUL.md')
  })

  test('regular files are not false-positive-rejected as symlinks', async () => {
    seed('SOUL.md', SOUL_BODY)
    seed('USER.md', USER_BODY)
    seed('priority-map.md', PMAP_BODY)
    const logged: Array<{ level: string; msg: string }> = []
    const loader = new PersonaPromptLoader({
      owner_home: tmpRoot,
      log: (level, msg) => logged.push({ level, msg }),
    })
    const out = await loader.load()
    expect(out).toContain(SOUL_BODY)
    expect(out).toContain(USER_BODY)
    expect(out).toContain(PMAP_BODY)
    // No symlink-rejection log lines fired on the happy path.
    expect(logged.find((l) => l.msg.includes('rejected: symlink'))).toBeUndefined()
  })

  test('all three persona files as symlinks → entire block empty + 3 warn logs', async () => {
    const sentinel = join(tmpRoot, 'sentinel.txt')
    writeFileSync(sentinel, 'LEAK_ME', 'utf8')
    for (const fname of PERSONA_FILENAMES) {
      symlinkSync(sentinel, join(personaDir, fname))
    }
    const logged: Array<{ level: string; msg: string }> = []
    const loader = new PersonaPromptLoader({
      owner_home: tmpRoot,
      log: (level, msg) => logged.push({ level, msg }),
    })
    const out = await loader.load()
    expect(out).toBe('')
    expect(out).not.toContain('LEAK_ME')
    const rejectLogs = logged.filter((l) => l.msg.includes('rejected: symlink'))
    expect(rejectLogs.length).toBe(3)
    // Every rejection at warn level.
    for (const l of rejectLogs) expect(l.level).toBe('warn')
    // One rejection per persona filename.
    for (const fname of PERSONA_FILENAMES) {
      expect(rejectLogs.find((l) => l.msg.includes(fname))).toBeDefined()
    }
  })

  test('persona/ directory itself as symlink → entire block rejected + warn log (no escape via dir-level symlink)', async () => {
    // Codex P2 follow-up: closing only the file-level door leaves the
    // dir-level door open. An owner-writable `persona -> /elsewhere` would
    // otherwise let regular files inside the symlink target slip past
    // the per-file isSymbolicLink check.
    rmSync(personaDir, { recursive: true })
    // Build the attack: an outside dir with regular persona files inside.
    const attackTargetDir = join(tmpRoot, 'attack-target-dir')
    mkdirSync(attackTargetDir, { recursive: true })
    writeFileSync(join(attackTargetDir, 'SOUL.md'), 'SOUL_PLANTED_BY_ATTACKER', 'utf8')
    writeFileSync(join(attackTargetDir, 'USER.md'), 'USER_PLANTED_BY_ATTACKER', 'utf8')
    writeFileSync(join(attackTargetDir, 'priority-map.md'), 'PMAP_PLANTED_BY_ATTACKER', 'utf8')
    // Now symlink <owner_home>/persona → attack target.
    symlinkSync(attackTargetDir, personaDir)

    const logged: Array<{ level: string; msg: string }> = []
    const loader = new PersonaPromptLoader({
      owner_home: tmpRoot,
      log: (level, msg) => logged.push({ level, msg }),
    })
    const out = await loader.load()

    // Critical: none of the planted bodies reaches the prompt.
    expect(out).toBe('')
    expect(out).not.toContain('SOUL_PLANTED_BY_ATTACKER')
    expect(out).not.toContain('USER_PLANTED_BY_ATTACKER')
    expect(out).not.toContain('PMAP_PLANTED_BY_ATTACKER')

    // One warn log at the directory level (not three at the file level).
    const dirRejectLog = logged.find(
      (l) => l.msg.includes('rejected: symlink') && l.msg.includes('persona directory'),
    )
    expect(dirRejectLog).toBeDefined()
    expect(dirRejectLog?.level).toBe('warn')
  })

  test('persona/ as symlink invalidates cache (subsequent legit dir is cold-loaded)', async () => {
    // Cache must not survive a hostile-dir rejection — otherwise a
    // restart-from-scratch admin flow that removes the hostile symlink
    // and writes a real persona/ dir would still serve stale content.
    seed('SOUL.md', SOUL_BODY)
    const loader = new PersonaPromptLoader({ owner_home: tmpRoot, log: () => {} })
    const warm = await loader.load()
    expect(warm).toContain(SOUL_BODY)

    // Now hostile the persona dir.
    rmSync(personaDir, { recursive: true })
    const attackTargetDir = join(tmpRoot, 'attack-target-dir-2')
    mkdirSync(attackTargetDir, { recursive: true })
    writeFileSync(join(attackTargetDir, 'SOUL.md'), 'PLANTED', 'utf8')
    symlinkSync(attackTargetDir, personaDir)
    const rejected = await loader.load()
    expect(rejected).toBe('')

    // Now restore a legit persona dir.
    rmSync(personaDir, { recursive: false })
    mkdirSync(personaDir, { recursive: true })
    seed('SOUL.md', 'REAL_SOUL_AFTER_RECOVERY')
    const recovered = await loader.load()
    expect(recovered).toContain('REAL_SOUL_AFTER_RECOVERY')
    expect(recovered).not.toContain(SOUL_BODY) // stale cache must NOT be served
  })

  test('symlink to a dangling target also rejected (lstat resolves, target does not)', async () => {
    // Target doesn't exist — lstat() still succeeds on the link itself
    // and reports isSymbolicLink() === true. The pre-fix stat()-based
    // code would have thrown ENOENT here and (incorrectly) emitted the
    // "missing" branch; this test pins the symlink-reject branch.
    const danglingTarget = join(tmpRoot, 'does-not-exist.txt')
    symlinkSync(danglingTarget, join(personaDir, 'SOUL.md'))
    seed('USER.md', USER_BODY)
    seed('priority-map.md', PMAP_BODY)

    const logged: Array<{ level: string; msg: string }> = []
    const loader = new PersonaPromptLoader({
      owner_home: tmpRoot,
      log: (level, msg) => logged.push({ level, msg }),
    })
    const out = await loader.load()
    expect(out).toContain(USER_BODY)
    expect(out).toContain(PMAP_BODY)
    expect(out).not.toContain('<persona_file name="SOUL.md">')
    const rejectLog = logged.find((l) => l.msg.includes('rejected: symlink'))
    expect(rejectLog).toBeDefined()
    expect(rejectLog?.level).toBe('warn')
  })
})
