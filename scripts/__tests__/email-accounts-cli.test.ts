/**
 * scripts/email-accounts.ts — the operator surface for per-account enablement.
 *
 * The arm that matters is the DESTRUCTIVE TYPO. The pipeline polls every
 * connected account until the owner enables one; the first settings row is what
 * flips it into allow-list mode. So a mistyped `disable` on a fresh install
 * would create that first row with nothing enabled — reporting that one
 * imaginary account had been turned off while actually silencing every real
 * mailbox. A CLI whose worst outcome is invisible is worse than no CLI.
 *
 * These run the script as a subprocess rather than importing it, because the
 * behaviour under test includes the exit code and what the owner is told.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openEmailPipelineStore } from '../../cores/free/email/src/pipeline/store.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'email-accounts.ts')

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'email-accounts-cli-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(['bun', SCRIPT, ...args, '--home', home], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { code, out, err }
}

function settings(): ReturnType<ReturnType<typeof openEmailPipelineStore>['listAccountSettings']> {
  const store = openEmailPipelineStore({ owner_home: home })
  try {
    return store.listAccountSettings()
  } finally {
    store.close()
  }
}

describe('email-accounts CLI', () => {
  test('a mistyped disable on a fresh install REFUSES instead of silencing everything', async () => {
    const r = await run('disable', 'typo')

    expect(r.code).toBe(2)
    expect(r.err).toContain('nothing is enabled yet')
    // The assertion the blocker was really about: no row was written, so the
    // pipeline is still in its unconfigured "poll everything" state.
    expect(settings()).toEqual([])
  })

  test('list on a fresh install says the pipeline polls EVERYTHING, not nothing', async () => {
    const r = await run('list')
    expect(r.code).toBe(0)
    expect(r.out).toContain('EVERY connected account')
  })

  test('enable records the account and reports the boundary it just drew', async () => {
    const r = await run('enable', 'acct-1', 'owner@example.com')

    expect(r.code).toBe(0)
    expect(r.out).toContain('enabled acct-1')
    expect(r.out).toContain('only mail arriving after')
    const rows = settings()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.enabled).toBe(1)
    expect(rows[0]?.enabled_at).not.toBeNull()
  })

  test('once a list exists, disabling an id that is not on it changes nothing', async () => {
    await run('enable', 'acct-1', 'owner@example.com')
    const r = await run('disable', 'acct-typo')

    expect(r.code).toBe(0)
    expect(r.out).toContain('was not on the list')
    // No junk row for the typo, and the real account is untouched.
    const rows = settings()
    expect(rows.map((x) => x.account_id)).toEqual(['acct-1'])
    expect(rows[0]?.enabled).toBe(1)
  })

  test('disabling the only enabled account IS allowed — that is a real decision', async () => {
    await run('enable', 'acct-1', 'owner@example.com')
    const r = await run('disable', 'acct-1')

    expect(r.code).toBe(0)
    expect(r.out).toContain('disabled acct-1')
    const rows = settings()
    expect(rows[0]?.enabled).toBe(0)
    // `enabled_at` SURVIVES the disable: it is what tells the pipeline this
    // list was curated deliberately rather than created by a typo.
    expect(rows[0]?.enabled_at).not.toBeNull()

    const listed = await run('list')
    expect(listed.out).toContain('every account is OFF')
  })
})
