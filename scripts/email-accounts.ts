#!/usr/bin/env bun
/**
 * scripts/email-accounts.ts — read and change PER-ACCOUNT enablement for the
 * email pipeline.
 *
 * The setting is owner data and lives in the instance sidecar
 * (`<owner_home>/email/pipeline.db`), never in the tree. This script is the
 * operator surface for it until the in-app settings pane lands; it does exactly
 * three things and touches nothing else.
 *
 *   bun scripts/email-accounts.ts list
 *   bun scripts/email-accounts.ts enable  <account_id> [address]
 *   bun scripts/email-accounts.ts disable <account_id>
 *
 * `--home <path>` overrides the owner home; otherwise `OWNER_HOME` is used.
 *
 * ── WHY IT PRINTS THE CONSEQUENCE ────────────────────────────────────────────
 * Enabling a mailbox schedules a backlog sweep of it, and the sweep's boundary
 * is the moment of the enable. That is the difference between "your history
 * stays quiet" and "your history arrives in chat", so the command says which
 * one just happened rather than printing `ok`.
 *
 * ── ACCOUNT IDS ──────────────────────────────────────────────────────────────
 * `account_id` is the stable id the multi-account fan-out stamps on every
 * message, the same one `emails.account_id` keys on. `list` shows the ids the
 * pipeline has already seen, with the address it recorded as a label. An
 * address is never the identity — it is display only.
 */

// Relative, not by package name: `scripts/` is not a workspace package and has
// no dependency on the email Core. Reaching in directly keeps the operator tool
// from adding a dependency edge that only exists to run a CLI.
import { openEmailPipelineStore } from '../cores/free/email/src/pipeline/store.ts'

const USAGE = `usage:
  bun scripts/email-accounts.ts list                            [--home <owner_home>]
  bun scripts/email-accounts.ts enable  <account_id> [address]  [--home <owner_home>]
  bun scripts/email-accounts.ts disable <account_id>            [--home <owner_home>]
`

function main(): number {
  const argv = process.argv.slice(2)
  const homeFlag = argv.indexOf('--home')
  const owner_home =
    homeFlag >= 0 ? argv[homeFlag + 1] : (process.env['OWNER_HOME'] ?? undefined)
  const args = homeFlag >= 0 ? [...argv.slice(0, homeFlag), ...argv.slice(homeFlag + 2)] : argv
  const [command, account_id, address] = args

  if (owner_home === undefined || owner_home.length === 0) {
    process.stderr.write('no owner home: pass --home <path> or set OWNER_HOME\n')
    return 2
  }
  if (command === undefined) {
    process.stderr.write(USAGE)
    return 2
  }

  const store = openEmailPipelineStore({ owner_home })
  try {
    if (command === 'list') {
      const rows = store.listAccountSettings()
      if (rows.length === 0) {
        // The allow-list is empty, so the pipeline is doing NOTHING. Say that
        // outright: an operator reading "no settings" would reasonably assume
        // the default is on, and the whole point of opting in is that it isn't.
        process.stdout.write(
          'no accounts are enabled — the pipeline polls NOTHING.\n' +
            'enable a mailbox to switch it on; anything not enabled stays invisible to it.\n',
        )
        return 0
      }
      for (const r of rows) {
        const when = r.enabled_at === null ? '' : ` since ${new Date(r.enabled_at).toISOString()}`
        process.stdout.write(
          `${r.enabled === 1 ? 'ON ' : 'off'}  ${r.account_id}  ${r.account_email ?? '(address unknown)'}${when}\n`,
        )
      }
      const on = rows.filter((r) => r.enabled === 1).length
      if (on === 0) {
        process.stdout.write('\nevery account is OFF — the pipeline polls nothing.\n')
      }
      process.stdout.write(
        `\nonly the accounts marked ON are polled; any connected mailbox not listed above is off.\n`,
      )
      return 0
    }

    if (command === 'enable' || command === 'disable') {
      if (account_id === undefined || account_id.length === 0) {
        process.stderr.write(USAGE)
        return 2
      }
      const enable = command === 'enable'
      // A `disable typo` needs no guard under an opt-in default: an id nobody
      // enabled is already off, so the mistake changes nothing and is reported
      // as changing nothing. (It DID need one while absence meant "poll
      // everything" — the first row flipped the pipeline into allow-list mode
      // and silenced every real mailbox. That hazard is gone with the default.)
      const prior = store.getAccountSetting(account_id)
      const was_on = prior !== null && prior.enabled === 1
      if (enable || prior !== null) store.setAccountEnabled(account_id, enable, address ?? null)
      const after = store.getAccountSetting(account_id)

      if (enable && !was_on) {
        process.stdout.write(
          `enabled ${account_id}.\n` +
            `its existing mail will be marked as history (no chat posts, no labels, no archiving)\n` +
            `and only mail arriving after ${new Date(after?.enabled_at ?? Date.now()).toISOString()} can escalate.\n`,
        )
      } else if (enable) {
        process.stdout.write(`${account_id} was already enabled — nothing changed.\n`)
      } else if (prior === null) {
        // Absence already means disabled in an allow-list, so writing a row for
        // an id nobody has ever enabled adds a fact that changes nothing and
        // clutters `list` with the owner's typos.
        process.stdout.write(
          `${account_id} was not on the list — nothing changed. (run 'list' to see the ids.)\n`,
        )
      } else {
        process.stdout.write(
          `disabled ${account_id}. it will not be polled, classified, escalated or labelled.\n` +
            `its existing rows are kept.\n`,
        )
      }
      return 0
    }

    process.stderr.write(USAGE)
    return 2
  } finally {
    store.close()
  }
}

process.exit(main())
