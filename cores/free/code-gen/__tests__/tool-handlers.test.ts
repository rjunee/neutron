import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CodegenToolContext } from '../src/substrate-runtime.ts'
import {
  bashScopedFactory,
  DEFAULT_ARGUS_BASH_ALLOWLIST,
  editFileScoped,
  globScoped,
  grepScoped,
  readFileScoped,
  writeFileScoped,
} from '../src/tool-handlers.ts'

let tmp: string

beforeEach(() => {
  // realpathSync resolves any symlinks (macOS /var → /private/var) so
  // path comparisons against `pwd` output line up.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'codegen-test-')))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function ctx(): CodegenToolContext {
  return {
    worktree_path: tmp,
    instance_key: 't-1',
    parent_task_id: 'task-1',
  }
}

describe('readFileScoped', () => {
  test('resolves files inside worktree', async () => {
    const file = join(tmp, 'hello.txt')
    await writeFile(file, 'hello world', 'utf8')
    const out = await readFileScoped({ file: 'hello.txt' }, ctx())
    expect(out.is_error).toBeUndefined()
    expect(out.content).toBe('hello world')
  })

  test('rejects ../etc/passwd', async () => {
    const out = await readFileScoped({ file: '../etc/passwd' }, ctx())
    expect(out.is_error).toBe(true)
    expect(out.content).toContain('escapes worktree')
  })

  test('rejects absolute path', async () => {
    const out = await readFileScoped({ file: '/etc/passwd' }, ctx())
    expect(out.is_error).toBe(true)
    expect(out.content).toContain('escapes worktree')
  })

  test('supports offset and limit', async () => {
    const file = join(tmp, 'lines.txt')
    await writeFile(file, 'a\nb\nc\nd\ne', 'utf8')
    const out = await readFileScoped(
      { file: 'lines.txt', offset: 2, limit: 2 },
      ctx(),
    )
    expect(out.content).toBe('b\nc')
  })
})

describe('writeFileScoped', () => {
  test('creates parent dir', async () => {
    const out = await writeFileScoped(
      { file: 'nested/deep/file.txt', content: 'hi' },
      ctx(),
    )
    expect(out.is_error).toBeUndefined()
    expect(existsSync(join(tmp, 'nested/deep/file.txt'))).toBe(true)
    expect(readFileSync(join(tmp, 'nested/deep/file.txt'), 'utf8')).toBe('hi')
  })

  test('rejects escape path', async () => {
    const out = await writeFileScoped(
      { file: '../outside.txt', content: 'nope' },
      ctx(),
    )
    expect(out.is_error).toBe(true)
  })
})

describe('editFileScoped', () => {
  test('replaces single occurrence', async () => {
    const file = join(tmp, 'a.txt')
    await writeFile(file, 'foo bar foo', 'utf8')
    const out = await editFileScoped(
      { file: 'a.txt', old: 'foo', new: 'baz' },
      ctx(),
    )
    expect(out.is_error).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe('baz bar foo')
  })

  test('replace_all=true replaces multiple', async () => {
    const file = join(tmp, 'a.txt')
    await writeFile(file, 'foo bar foo baz foo', 'utf8')
    const out = await editFileScoped(
      { file: 'a.txt', old: 'foo', new: 'X', replace_all: true },
      ctx(),
    )
    expect(out.is_error).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe('X bar X baz X')
  })

  test('returns is_error when old not found', async () => {
    const file = join(tmp, 'a.txt')
    await writeFile(file, 'foo', 'utf8')
    const out = await editFileScoped(
      { file: 'a.txt', old: 'missing', new: 'x' },
      ctx(),
    )
    expect(out.is_error).toBe(true)
    expect(out.content).toContain('not found')
  })
})

describe('bashScopedFactory', () => {
  test('null allowlist (Forge) runs in worktree cwd', async () => {
    const handler = bashScopedFactory(null)
    const out = await handler({ command: 'pwd' }, ctx())
    expect(out.is_error).toBeUndefined()
    expect(out.content.trim()).toBe(tmp)
  })

  test('allowlist rejects rm -rf', async () => {
    const handler = bashScopedFactory(DEFAULT_ARGUS_BASH_ALLOWLIST)
    const out = await handler({ command: 'rm -rf /' }, ctx())
    expect(out.is_error).toBe(true)
    expect(out.content).toContain('not allowed')
  })

  test('allowlist accepts bun test prefix', async () => {
    const handler = bashScopedFactory(DEFAULT_ARGUS_BASH_ALLOWLIST)
    // `bun test --no-such-flag` will exit non-zero, but the command
    // itself must pass the allowlist check (no "not allowed" error).
    const out = await handler(
      { command: 'bun test --version', timeout_ms: 10_000 },
      ctx(),
    )
    expect(out.content).not.toContain('not allowed')
  })

  test('allowlist accepts ls', async () => {
    await mkdir(join(tmp, 'sub'), { recursive: true })
    const handler = bashScopedFactory(DEFAULT_ARGUS_BASH_ALLOWLIST)
    const out = await handler({ command: 'ls' }, ctx())
    expect(out.is_error).toBeUndefined()
    expect(out.content).toContain('sub')
  })
})

describe('grepScoped', () => {
  test('finds pattern in worktree', async () => {
    await writeFile(join(tmp, 'a.txt'), 'first line\nneedle here\nlast', 'utf8')
    const out = await grepScoped({ pattern: 'needle' }, ctx())
    expect(out.is_error).toBeUndefined()
    expect(out.content).toContain('needle here')
  })

  test('returns empty when no match', async () => {
    await writeFile(join(tmp, 'a.txt'), 'hello', 'utf8')
    const out = await grepScoped({ pattern: 'zzzz' }, ctx())
    // rg exits 1 on no match — we treat that as a clean empty result.
    expect(out.is_error).toBeUndefined()
    expect(out.content.trim()).toBe('')
  })
})

describe('globScoped', () => {
  test('lists matching files', async () => {
    await writeFile(join(tmp, 'a.ts'), '// a', 'utf8')
    await writeFile(join(tmp, 'b.ts'), '// b', 'utf8')
    await writeFile(join(tmp, 'c.md'), '# c', 'utf8')
    const out = await globScoped({ pattern: '*.ts' }, ctx())
    expect(out.is_error).toBeUndefined()
    const lines = out.content.split('\n').filter((l) => l.length > 0)
    expect(lines.sort()).toEqual(['a.ts', 'b.ts'])
  })
})
