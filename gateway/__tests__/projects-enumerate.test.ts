/**
 * Argus r1 MINOR #5 — shared `enumerateOwnerProjects` helper.
 *
 * Both `gateway/index.ts` (scheduler) and
 * `gateway/http/app-admin-surface.ts` (Backup sub-tab list endpoint)
 * call the same enumerator. This file tests the canonical helper.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  defaultEnumerateProjects,
  enumerateOwnerProjects,
} from '../projects/enumerate.ts'

let owner_home = ''

beforeEach(() => {
  owner_home = mkdtempSync(join(tmpdir(), 'enumerate-projects-'))
})

afterEach(() => {
  rmSync(owner_home, { recursive: true, force: true })
})

describe('enumerateOwnerProjects', () => {
  it('returns [] when <owner_home>/Projects/ does not exist', async () => {
    expect(await enumerateOwnerProjects(owner_home)).toEqual([])
  })

  it('returns directory names under Projects/, sorted', async () => {
    const root = join(owner_home, 'Projects')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(root, 'zeta'))
    mkdirSync(join(root, 'alpha'))
    mkdirSync(join(root, 'bravo'))
    expect(await enumerateOwnerProjects(owner_home)).toEqual([
      'alpha',
      'bravo',
      'zeta',
    ])
  })

  it('filters out regular files (only dirs count as projects)', async () => {
    const root = join(owner_home, 'Projects')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(root, 'real-project'))
    writeFileSync(join(root, 'stray.txt'), 'noise')
    expect(await enumerateOwnerProjects(owner_home)).toEqual(['real-project'])
  })

  it('rejects names that violate the project_id grammar', async () => {
    const root = join(owner_home, 'Projects')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(root, 'ok-project'))
    mkdirSync(join(root, '.hidden')) // leading dot — invalid
    mkdirSync(join(root, 'has space')) // space — invalid
    const out = await enumerateOwnerProjects(owner_home)
    expect(out).toEqual(['ok-project'])
  })

  it('accepts dots, underscores, dashes inside the name', async () => {
    const root = join(owner_home, 'Projects')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(root, 'a.b_c-d'))
    expect(await enumerateOwnerProjects(owner_home)).toEqual(['a.b_c-d'])
  })

  it('caps name length at 64 chars', async () => {
    const root = join(owner_home, 'Projects')
    mkdirSync(root, { recursive: true })
    const ok = 'a'.repeat(64) // exactly 64 → fits the {0,63} after leading char
    const tooLong = 'a'.repeat(65)
    mkdirSync(join(root, ok))
    mkdirSync(join(root, tooLong))
    expect(await enumerateOwnerProjects(owner_home)).toEqual([ok])
  })
})

describe('defaultEnumerateProjects', () => {
  it('returns a zero-arg function bound to the supplied owner_home', async () => {
    const root = join(owner_home, 'Projects')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(root, 'p1'))
    const fn = defaultEnumerateProjects(owner_home)
    expect(typeof fn).toBe('function')
    expect(await fn()).toEqual(['p1'])
  })
})
