/**
 * scripts/email-accounts.ts — the operator surface for per-account enablement.
 *
 * The arms that matter are the ones where the owner is TOLD THE WRONG THING.
 * The pipeline is opt-in per account and fails closed, so `list` on a fresh
 * install must say the pipeline is polling NOTHING rather than reporting an
 * empty settings table and letting the operator infer the default. Likewise
 * every mutation reports the consequence it just caused, not `ok`.
 *
 * (Under the earlier opt-out default a mistyped `disable` was DESTRUCTIVE: the
 * first settings row flipped the pipeline into allow-list mode, so `disable
 * typo` silenced every real mailbox while reporting it had turned off one
 * imaginary account. Failing closed removed the hazard; the arm below now pins
 * that the same typo is inert.)
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
  test('a mistyped disable on a fresh install is inert — it changes nothing', async () => {
    const r = await run('disable', 'typo')

    expect(r.code).toBe(0)
    expect(r.out).toContain('was not on the list')
    // Under the opt-in default an id nobody enabled is ALREADY off, so the typo
    // has nothing to do — and it must not leave a junk row behind either.
    expect(settings()).toEqual([])
  })

  test('list on a fresh install says the pipeline polls NOTHING', async () => {
    const r = await run('list')
    expect(r.code).toBe(0)
    expect(r.out).toContain('polls NOTHING')
    // The remedy in the same breath as the state: an operator told only "no
    // settings recorded" would reasonably assume the default is on.
    expect(r.out).toContain('enable a mailbox')
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
