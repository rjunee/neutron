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

import { openEmailPipelineStore } from '@neutronai/email-managed-core/pipeline/store'

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

/**
 * Stand in for the poller's discovery pass. `enable` only accepts ids that
 * discovery has recorded, so every arm that enables a real account has to have
 * been through one tick first — which is the actual operator sequence.
 */
function discover(...accounts: readonly (readonly [string, string | null])[]): void {
  const store = openEmailPipelineStore({ owner_home: home })
  try {
    for (const [id, address] of accounts) store.recordDiscoveredAccount(id, address)
  } finally {
    store.close()
  }
}

/**
 * Same subprocess harness, but with the home passed EXPLICITLY rather than
 * appended — the blank arms need to control that flag's value, and `run` always
 * supplies a real one.
 */
async function runWithHome(home_: string, ...args: string[]): Promise<{ code: number; err: string }> {
  const proc = Bun.spawn(['bun', SCRIPT, ...args, '--home', home_], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  return { code, err }
}

describe('email-accounts CLI', () => {
  test('a blank --home is REFUSED, not treated as a directory', async () => {
    // BLANK IS UNSET — the rule `effectiveOwnerHome` (`config/index.ts`)
    // documents for this same variable. The guard was `length === 0`, which
    // accepts `'   '`: the CLI then opened a project DB under a directory named
    // three spaces, relative to the CWD, and reported an empty mailbox list for
    // an install that has mailboxes. The operator is told the wrong thing, which
    // is exactly the failure class this file exists to pin.
    //
    // Pinned here because the trim was previously asserted by a comment and by
    // nothing else — reverting it left every suite green.
    for (const blank of ['', '   ', '\t\n']) {
      const r = await runWithHome(blank, 'list')
      expect(r.code).toBe(2)
      expect(r.err).toContain('no owner home')
    }
  })

  test('a REAL --home passes the same guard — the control for the arm above', async () => {
    // Without this, the assertions above would also pass for a CLI that refused
    // EVERY home, which is a different and louder bug. `list` with no command
    // would exit 2 as well, so the distinguishing signal is WHICH message the
    // operator gets: usage, never "no owner home".
    const r = await runWithHome(home)
    expect(r.code).toBe(2)
    expect(r.err).not.toContain('no owner home')
    expect(r.err).toContain('usage:')
  })

  test('a mistyped disable on a fresh install is inert — it changes nothing', async () => {
    const r = await run('disable', 'typo')

    expect(r.code).toBe(0)
    expect(r.out).toContain('was already off')
    // Under the opt-in default an id nobody enabled is ALREADY off, so the typo
    // has nothing to do — and it must not leave a junk row behind either.
    expect(settings()).toEqual([])
  })

  test('list on a fresh install says the pipeline polls NOTHING', async () => {
    const r = await run('list')
    expect(r.code).toBe(0)
    expect(r.out).toContain('polls NOTHING')
    // …and WHY there is nothing to enable yet. The ids come from the poller's
    // discovery pass, so an install whose cron has not fired has none to show —
    // "no accounts" alone reads as "you have no mailboxes".
    expect(r.out).toContain('no mailboxes discovered yet')
  })

  test('enable records the account and reports the boundary it just drew', async () => {
    discover(['acct-1', 'owner@example.com'])
    const r = await run('enable', 'acct-1', 'owner@example.com')

    expect(r.code).toBe(0)
    expect(r.out).toContain('enabled acct-1')
    expect(r.out).toContain('only mail arriving after')
    const rows = settings()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.enabled).toBe(1)
    expect(rows[0]?.enabled_at).not.toBeNull()
  })

  test('a mistyped ENABLE is refused, not silently granted', async () => {
    // The dangerous half of the typo. An allow-list row for an id that does not
    // exist is a STANDING PERMISSION: it reports success now, and the day
    // anything is issued that id it is polled without the owner deciding to.
    discover(['acct-1', 'owner@example.com'])
    const r = await run('enable', 'acct-typo')

    expect(r.code).toBe(2)
    expect(r.err).toContain('unknown account id')
    expect(r.err).toContain("ids come from 'list'")
    // Nothing written, and the real account left exactly as it was — still off,
    // because refusing the typo must not be mistaken for enabling anything.
    const rows = settings()
    expect(rows.map((x) => x.account_id)).toEqual(['acct-1'])
    expect(rows[0]?.enabled).toBe(0)
  })

  test('once a list exists, disabling an id that is not on it changes nothing', async () => {
    discover(['acct-1', 'owner@example.com'])
    await run('enable', 'acct-1', 'owner@example.com')
    const r = await run('disable', 'acct-typo')

    expect(r.code).toBe(0)
    expect(r.out).toContain('was already off')
    // No junk row for the typo, and the real account is untouched.
    const rows = settings()
    expect(rows.map((x) => x.account_id)).toEqual(['acct-1'])
    expect(rows[0]?.enabled).toBe(1)
  })

  test('disabling the only enabled account IS allowed — that is a real decision', async () => {
    discover(['acct-1', 'owner@example.com'])
    await run('enable', 'acct-1', 'owner@example.com')
    const r = await run('disable', 'acct-1')

    expect(r.code).toBe(0)
    expect(r.out).toContain('disabled acct-1')
    const rows = settings()
    expect(rows[0]?.enabled).toBe(0)
    // `enabled_at` SURVIVES the disable, because it is the sweep's history
    // boundary: turning the account back on must not re-draw the line at
    // whenever that happened without a fresh sweep deciding it.
    expect(rows[0]?.enabled_at).not.toBeNull()

    const listed = await run('list')
    expect(listed.out).toContain('every account is OFF')
  })

  test("a single-backend install can enable its one mailbox — the '' sentinel", async () => {
    // A single-account install has no ids to name, so its mailbox IS the empty
    // id. Rejecting an empty argument as "missing" would leave exactly those
    // installs with a fail-closed pipeline and no way to open it.
    const r = await run('enable', '')

    expect(r.code).toBe(0)
    expect(r.out).toContain('only mail arriving after')
    const rows = settings()
    expect(rows.map((x) => x.account_id)).toEqual([''])
    expect(rows[0]?.enabled).toBe(1)

    // …and it is listed legibly rather than as a blank column.
    const listed = await run('list')
    expect(listed.out).toContain("this install's only mailbox")
  })
})
