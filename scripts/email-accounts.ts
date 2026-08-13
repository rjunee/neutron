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
 * message, the same one `emails.account_id` keys on. An address is never the
 * identity — it is display only.
 *
 * `list` shows every mailbox the poller has DISCOVERED, on or off. Discovery is
 * what makes a fail-closed allow-list usable at all: nothing is polled until an
 * id is enabled, and nothing would reveal an id until something polled, so each
 * tick first enumerates the connected grants — reading no mail — and records
 * them as switched-off rows. A single-backend install has no ids to report and
 * appears under the `''` sentinel.
 *
 * `enable` therefore REFUSES an id discovery has not seen (the `''` sentinel
 * excepted). An allow-list row for a mailbox that does not exist is not a
 * harmless typo — it is a standing permission that would be honoured the day
 * something is issued that id.
 */

// By PACKAGE NAME, not a relative path. An earlier revision reached across as
// `../cores/free/email/...` and justified it as avoiding a dependency edge the
// CLI did not need — but the edge exists either way, and the repo's
// cross-workspace lint gate refuses the relative form precisely so it cannot be
// hidden behind a path.
import { openEmailPipelineStore } from '@neutronai/email-managed-core/pipeline/store'

const USAGE = `usage:
  bun scripts/email-accounts.ts list                            [--home <owner_home>]
  bun scripts/email-accounts.ts enable  <account_id> [address]  [--home <owner_home>]
  bun scripts/email-accounts.ts disable <account_id>            [--home <owner_home>]

  <account_id> is an id from 'list'. A single-backend install has none, and its
  one mailbox is the empty id — enable it with a literal empty argument: '' .
`

/** How the single-account sentinel is shown, since '' prints as nothing. */
const SOLE_ACCOUNT_LABEL = "''  (this install's only mailbox)"

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
        // NOTHING KNOWN YET, which is not the same as nothing connected. The
        // ids come from the poller's discovery pass, so an install whose cron
        // has not fired once has none to show — say which of the two it is,
        // otherwise "no accounts" reads as "you have no mailboxes".
        process.stdout.write(
          'no accounts are enabled — the pipeline polls NOTHING.\n' +
            'no mailboxes discovered yet either: the poller records the connected accounts on\n' +
            'its first run, so wait one poll interval and run this again to see their ids.\n',
        )
        return 0
      }
      for (const r of rows) {
        const when = r.enabled_at === null ? '' : ` since ${new Date(r.enabled_at).toISOString()}`
        const id = r.account_id === '' ? SOLE_ACCOUNT_LABEL : r.account_id
        process.stdout.write(
          `${r.enabled === 1 ? 'ON ' : 'off'}  ${id}  ${r.account_email ?? '(address unknown)'}${when}\n`,
        )
      }
      const on = rows.filter((r) => r.enabled === 1).length
      if (on === 0) {
        process.stdout.write(
          '\nevery account is OFF — the pipeline polls nothing. enable one by its id above.\n',
        )
      }
      process.stdout.write(
        `\nonly the accounts marked ON are polled; anything else here is off.\n`,
      )
      return 0
    }

    if (command === 'enable' || command === 'disable') {
      // ABSENT, not EMPTY. `''` is the single-account sentinel and is a real,
      // enable-able id — rejecting it as "missing" would leave a single-backend
      // install with a fail-closed pipeline and no way to open it.
      if (account_id === undefined) {
        process.stderr.write(USAGE)
        return 2
      }
      const enable = command === 'enable'
      // A `disable typo` needs no guard under an opt-in default: an id nobody
      // enabled is already off, so the mistake changes nothing and is reported
      // as changing nothing. (It DID need one while absence meant "poll
      // everything" — the first row flipped the pipeline into allow-list mode
      // and silenced every real mailbox. That hazard is gone with the default.)
      const shown = account_id === '' ? SOLE_ACCOUNT_LABEL : account_id
      const prior = store.getAccountSetting(account_id)
      const was_on = prior !== null && prior.enabled === 1

      // ENABLE ONLY WHAT DISCOVERY HAS SEEN. `enable` used to create a row for
      // any string handed to it, which quietly broke the fail-closed guarantee
      // twice over: a typo was reported as an enabled mailbox (so the owner
      // believed a mailbox was on that was not), and the junk row SURVIVED —
      // if a later grant were ever issued that id, it would be polled without
      // anyone having decided to poll it. An allow-list entry for an account
      // that does not exist is a standing permission, not a no-op.
      //
      // The sentinel is the one exemption. A single-backend install has no ids
      // at all and its mailbox IS `''`, so before the first tick has recorded
      // anything there is nothing to match against; refusing it would restore
      // the lock-with-no-key that discovery exists to remove.
      if (enable && prior === null && account_id !== '') {
        process.stderr.write(
          `unknown account id ${JSON.stringify(account_id)} — nothing was enabled.\n` +
            `ids come from 'list', which shows the mailboxes the poller has discovered.\n` +
            `if 'list' is empty, the poller has not run yet: wait one poll interval.\n`,
        )
        return 2
      }
      if (enable || was_on) store.setAccountEnabled(account_id, enable, address ?? null)
      const after = store.getAccountSetting(account_id)

      if (enable && !was_on) {
        process.stdout.write(
          `enabled ${shown}.\n` +
            `its existing mail will be marked as history (no chat posts, no labels, no archiving)\n` +
            `and only mail arriving after ${new Date(after?.enabled_at ?? Date.now()).toISOString()} can escalate.\n`,
        )
      } else if (enable) {
        process.stdout.write(`${shown} was already enabled — nothing changed.\n`)
      } else if (!was_on) {
        // ALREADY OFF, whether or not a row exists. Discovery writes a row for
        // every connected mailbox, so "no row" no longer means "unknown id" —
        // but both cases have the same answer, and reporting a disable that did
        // not happen is how an operator comes to believe they turned something
        // off. No row is written for an id nobody enabled either, which keeps
        // `list` free of the owner's typos.
        process.stdout.write(
          `${shown} was already off — nothing changed. (run 'list' to see the ids.)\n`,
        )
      } else {
        process.stdout.write(
          `disabled ${shown}. it will not be polled, classified, escalated or labelled.\n` +
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
