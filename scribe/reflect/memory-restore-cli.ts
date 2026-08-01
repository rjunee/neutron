/**
 * @neutronai/scribe — `neutron memory-restore`: undo a wrong auto-merge.
 *
 * The consolidation pass fuses near-duplicate memory pages and removes the
 * loser. That judgement is a heuristic and can be wrong, so the loser's exact
 * bytes are archived first (`./merge-archive.ts`). This is the surface that
 * makes that archive USABLE by someone who does not read code:
 *
 *   neutron memory-restore                 list every page merged away
 *   neutron memory-restore <slug>          put that page back
 *   neutron memory-restore <slug> --force  put it back over a live page
 *
 * Read-only with no argument. Prints plain text; exits non-zero only when a
 * requested restore did not happen.
 */

import { resolveNeutronHome } from '@neutronai/migrations/db-path.ts'
import {
  mergeArchiveRoot,
  readMergeLedger,
  restoreArchivedPage,
  type ArchivedMerge,
} from './merge-archive.ts'

function formatRow(e: ArchivedMerge): string {
  const when = e.archived_at.slice(0, 16).replace('T', ' ')
  return `  ${e.slug.padEnd(28)} ${e.kind.padEnd(9)} merged into ${e.merged_into.padEnd(28)} ${when}Z`
}

export async function runMemoryRestoreCli(argv: readonly string[]): Promise<number> {
  const force = argv.includes('--force')
  const slug = argv.find((a) => !a.startsWith('-'))
  const ownerDataDir = resolveNeutronHome(process.env)
  const archiveDir = mergeArchiveRoot(ownerDataDir)

  if (slug === undefined) {
    const ledger = await readMergeLedger(ownerDataDir)
    if (ledger.length === 0) {
      console.info('No memory pages have been merged away.')
      console.info(`(archive: ${archiveDir})`)
      return 0
    }
    console.info(`Memory pages merged away (newest last) — archive: ${archiveDir}\n`)
    for (const e of ledger) console.info(formatRow(e))
    console.info('\nRestore one with:  neutron memory-restore <slug>')
    return 0
  }

  const result = await restoreArchivedPage({ ownerDataDir, slug, overwrite: force })
  if (!result.restored) {
    if (result.reason === 'not_found') {
      console.error(`No archived page for "${slug}". Run \`neutron memory-restore\` to list what is available.`)
    } else if (result.reason === 'live_page_exists') {
      console.error(
        `A live page already exists at ${result.path ?? ''}.\n` +
          'Move it aside, or re-run with --force to replace it with the archived copy.',
      )
    } else {
      console.error(`The archived copy for "${slug}" is missing from ${archiveDir}.`)
    }
    return 1
  }

  console.info(`Restored ${result.entry.kind}/${result.entry.slug} → ${result.path}`)
  console.info(`It was merged into "${result.entry.merged_into}" on ${result.entry.archived_at}.`)
  console.info(
    `\nNext: open the "${result.entry.merged_into}" page and delete the "## Merged" section holding ` +
      'this page\'s text — otherwise the two are still near-duplicates and the next consolidation ' +
      'pass will merge them again.',
  )
  return 0
}

if (import.meta.main) {
  process.exit(await runMemoryRestoreCli(process.argv.slice(2)))
}
