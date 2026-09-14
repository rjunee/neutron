import { describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const here = import.meta.dir
const gitBin = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
function git(root: string, ...args: string[]) {
  return execFileSync(gitBin, ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function put(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'git-history-'))
  const origin = join(root, 'origin')
  mkdirSync(origin)
  git(origin, 'init', '-q', '-b', 'main')
  git(origin, 'config', 'user.name', 'Fixture')
  git(origin, 'config', 'user.email', 'fixture')
  put(origin, 'docs/AS_BUILT.md', '# History\n\nFROZEN as of 2026-09-12\n')
  git(origin, 'add', '.')
  const tree0 = git(origin, 'write-tree')
  const commit = (tree: string, label: string, ...parents: string[]) =>
    git(origin, '-c', 'commit.gpgsign=false', 'commit-tree', tree, ...parents.flatMap(p => ['-p', p]), '-m', label)
  const r = commit(tree0, 'R')
  put(origin, 'docs/AS_BUILT.md', '# History\n\nFROZEN as of 2026-09-12\nMain update\n')
  git(origin, 'add', '.')
  const tree = git(origin, 'write-tree')
  const a = commit(tree, 'A', r)
  const b = commit(tree, 'B', a)
  const c = commit(tree, 'C', a)
  const s = commit(tree0, 'S', r)
  const m = commit(tree, 'M', b, s)
  for (const [name, sha] of Object.entries({ main: c, branch: m, boundary: b })) git(origin, 'update-ref', `refs/heads/${name}`, sha)
  git(origin, 'reset', '--hard', 'main')
  return { root, origin, r, a, b, c, m }
}
function run(root: string, script: string, env: Record<string, string> = {}) {
  return spawnSync('bash', [join(here, script)], {
    encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: '', ...env, AS_BUILT_GUARD_ROOT: root },
  })
}
function instrument(root: string, fault = '') {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const log = join(root, 'commands')
  writeFileSync(log, '')
  put(bin, 'git', `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$COMMAND_LOG"\n${fault}\nexec "$REAL_GIT" "$@"\n`)
  chmodSync(join(bin, 'git'), 0o755)
  return { PATH: `${bin}:${process.env.PATH}`, REAL_GIT: gitBin, COMMAND_LOG: log }
}

describe('measured Git history', () => {
  test('missing base fetch preserves a complete clone and exact ancestry', () => {
    const f = fixture()
    try {
      const work = join(f.root, 'work')
      git(f.root, 'clone', '-q', '--single-branch', '--branch', 'main', `file://${f.origin}`, work)
      expect(spawnSync(gitBin, ['-C', work, 'cat-file', '-e', f.b]).status).toBe(1)
      expect(git(work, 'rev-parse', '--is-shallow-repository')).toBe('false')
      const env = instrument(f.root)
      const result = run(work, 'as-built-write-guard.sh', { ...env, GUARD_BASE_SHA: f.b, GUARD_HEAD_SHA: f.c })
      expect(result.status).toBe(0)
      expect(git(work, 'rev-parse', '--is-shallow-repository')).toBe('false')
      expect(git(work, 'merge-base', f.b, f.c)).toBe(f.a)
      expect(git(work, 'rev-list', '--count', 'origin/main')).toBe('3')
      expect(readFileSync(env.COMMAND_LOG, 'utf8').split('\n').filter(l => l.includes(' fetch '))).toEqual([
        `-C ${work} fetch --quiet origin ${f.b}`,
      ])
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  test('linked graft returns the wrong commit successfully; guard restores the exact base', () => {
    const f = fixture()
    try {
      const work = join(f.root, 'work')
      const linked = join(f.root, 'linked')
      git(f.root, 'clone', '-q', `file://${f.origin}`, work)
      expect(git(work, 'merge-base', f.c, f.m)).toBe(f.a)
      git(work, 'fetch', '--depth=1', 'origin', f.b)
      git(work, 'worktree', 'add', '--detach', linked, f.m)
      expect(git(linked, 'rev-parse', '--is-shallow-repository')).toBe('true')
      expect(git(linked, 'merge-base', f.c, f.m)).toBe(f.r)
      const result = run(linked, 'as-built-write-guard.sh', { GUARD_BASE_SHA: f.c, GUARD_HEAD_SHA: f.m })
      expect(result.status).toBe(0)
      expect(git(linked, 'rev-parse', '--is-shallow-repository')).toBe('false')
      expect(git(linked, 'merge-base', f.c, f.m)).toBe(f.a)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  test('still shallow after successful fetch refuses before a plausible wrong diff', () => {
    const f = fixture()
    try {
      const work = join(f.root, 'work')
      git(f.root, 'clone', '-q', `file://${f.origin}`, work)
      git(work, 'fetch', '--depth=1', 'origin', f.b)
      expect(git(work, 'merge-base', f.c, f.m)).toBe(f.r)
      const env = instrument(f.root, 'if [[ " $* " == *" fetch "* ]]; then exit 0; fi')
      const result = run(work, 'as-built-write-guard.sh', { ...env, GUARD_BASE_SHA: f.c, GUARD_HEAD_SHA: f.m })
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('remains SHALLOW')
      expect(readFileSync(env.COMMAND_LOG, 'utf8')).not.toContain(' diff ')
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  test('genuine shallow clone fetches depth 1 and fallback deepens by exactly 200', () => {
    const f = fixture()
    try {
      const work = join(f.root, 'work')
      git(f.root, 'clone', '-q', '--depth=1', `file://${f.origin}`, work)
      expect(git(work, 'rev-parse', '--is-shallow-repository')).toBe('true')
      const env = instrument(f.root, 'if [[ " $* " == *" --unshallow "* ]]; then exit 1; fi')
      const result = run(work, 'as-built-write-guard.sh', { ...env, GUARD_BASE_SHA: f.a, GUARD_HEAD_SHA: f.c })
      expect(result.status).toBe(0)
      expect(git(work, 'rev-parse', '--is-shallow-repository')).toBe('false')
      expect(git(work, 'merge-base', f.a, f.c)).toBe(f.a)
      expect(readFileSync(env.COMMAND_LOG, 'utf8').split('\n').filter(l => l.includes(' fetch '))).toEqual([
        `-C ${work} fetch --quiet --depth=1 origin ${f.a}`,
        `-C ${work} fetch --quiet --unshallow origin`,
        `-C ${work} fetch --quiet --deepen=200 origin`,
      ])
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })

  for (const name of ['composition-field', 'depcruise', 'route-slot']) {
    for (const shallow of [true, false]) {
      test(`${name} linked diagnostic measures shallow=${shallow}`, () => {
        const f = fixture()
        try {
          const work = join(f.root, 'work')
          const linked = join(f.root, 'linked')
          git(f.root, 'clone', '-q', ...(shallow ? ['--depth=1'] : []), `file://${f.origin}`, work)
          git(work, 'worktree', 'add', '--detach', linked, 'HEAD')
          put(linked, '.dependency-cruiser-known-violations.json', '[]')
          put(linked, 'open/__tests__/composition-field-coverage-inventory.ts', 'export const WIRED_FIELDS = []')
          put(linked, 'open/__tests__/declared-composition-fields.ts', 'export const fields = []')
          put(linked, 'open/__tests__/route-slot-coverage-inventory.ts', 'export const MOUNTED_SLOTS = []')
          put(linked, 'gateway/http/route-slots.ts', 'export const slots = []')
          expect(git(linked, 'rev-parse', '--is-shallow-repository')).toBe(String(shallow))
          const prefix = name.replaceAll('-', '_').toUpperCase()
          const result = run(linked, `${name}-ratchet-guard.sh`, {
            [`${prefix}_RATCHET_ROOT`]: linked, [`${prefix}_RATCHET_MAIN_REF`]: 'missing-main',
          })
          expect(result.status).toBe(0)
          expect(result.stderr.includes('checkout is SHALLOW')).toBe(shallow)
          const env = instrument(f.root, 'if [[ " $* " == *" --is-shallow-repository "* ]] && [[ "$(grep -c -- --is-shallow-repository "$COMMAND_LOG")" == 2 ]]; then exit 1; fi')
          const unknown = run(linked, `${name}-ratchet-guard.sh`, {
            ...env, [`${prefix}_RATCHET_ROOT`]: linked, [`${prefix}_RATCHET_MAIN_REF`]: 'missing-main',
          })
          expect(unknown.status).toBe(2)
          expect(unknown.stderr).toContain('UNKNOWN')
          const fetchEnv = instrument(f.root)
          const refreshed = run(linked, `${name}-ratchet-guard.sh`, {
            ...fetchEnv, [`${prefix}_RATCHET_ROOT`]: linked,
          })
          expect(refreshed.status).toBe(0)
          expect(git(linked, 'rev-parse', '--is-shallow-repository')).toBe(String(shallow))
          expect(git(linked, 'rev-list', '--count', 'origin/main')).toBe(shallow ? '1' : '3')
          expect(readFileSync(fetchEnv.COMMAND_LOG, 'utf8').split('\n').filter(l => l.includes(' fetch '))).toEqual([
            `-C ${linked} fetch ${shallow ? '--depth=1 ' : ''}origin main`,
          ])
        } finally { rmSync(f.root, { recursive: true, force: true }) }
      })
    }
  }

  for (const stage of ['before-fetch', 'after-fetch']) {
    test(`as-built propagates UNKNOWN ${stage}`, () => {
      const f = fixture()
      try {
        const work = join(f.root, 'work')
        git(f.root, 'clone', '-q', '--single-branch', `file://${f.origin}`, work)
        if (stage === 'after-fetch') git(work, 'fetch', '--depth=1', 'origin', f.b)
        const count = stage === 'before-fetch' ? 1 : 2
        const env = instrument(f.root, `if [[ " $* " == *" --is-shallow-repository "* ]] && [[ "$(grep -c -- --is-shallow-repository "$COMMAND_LOG")" == ${count} ]]; then exit 1; fi`)
        const result = run(work, 'as-built-write-guard.sh', { ...env, GUARD_BASE_SHA: f.b, GUARD_HEAD_SHA: f.c })
        expect(result.status).toBe(2)
        expect(result.stderr).toContain('UNKNOWN')
        expect(result.stderr).not.toContain('remains SHALLOW')
        const commands = readFileSync(env.COMMAND_LOG, 'utf8')
        expect(commands).not.toContain(' diff ')
        if (stage === 'before-fetch') expect(commands).not.toContain(' fetch ')
      } finally { rmSync(f.root, { recursive: true, force: true }) }
    })
  }

  for (const name of ['composition-field', 'depcruise', 'route-slot', 'as-built']) {
    for (const fault of ['exit 1', 'echo invalid; exit 0', 'echo false; exit 1']) {
      test(`${name} refuses UNKNOWN (${fault}) before fetch or diff`, () => {
        const f = fixture()
        try {
          put(f.origin, '.dependency-cruiser-known-violations.json', '[]')
          put(f.origin, 'open/__tests__/composition-field-coverage-inventory.ts', 'export const WIRED_FIELDS = []')
          put(f.origin, 'open/__tests__/declared-composition-fields.ts', 'export const fields = []')
          put(f.origin, 'open/__tests__/route-slot-coverage-inventory.ts', 'export const MOUNTED_SLOTS = []')
          put(f.origin, 'gateway/http/route-slots.ts', 'export const slots = []')
          const env = instrument(f.root, `if [[ " $* " == *" --is-shallow-repository "* ]]; then ${fault}; fi`)
          const result = run(f.origin, name === 'as-built' ? 'as-built-write-guard.sh' : `${name}-ratchet-guard.sh`, {
            ...env, GUARD_BASE_SHA: f.c, GUARD_HEAD_SHA: f.m,
            [`${name.replaceAll('-', '_').toUpperCase()}_RATCHET_ROOT`]: f.origin,
          })
          expect(result.status).toBe(2)
          expect(result.stderr).toContain('UNKNOWN')
          const commands = readFileSync(env.COMMAND_LOG, 'utf8')
          expect(commands).toContain('--is-shallow-repository')
          expect(commands).not.toContain(' fetch ')
          expect(commands).not.toContain(' diff ')
        } finally { rmSync(f.root, { recursive: true, force: true }) }
      })
    }
  }
})
