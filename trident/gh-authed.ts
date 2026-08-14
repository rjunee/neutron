/**
 * `gh`, run WITH the instance's GitHub credential — the READ-side sibling of the
 * per-command credentialed host runner the outer publisher pushes with
 * (`open/composer.ts`, `makeLazyCredentialedHostRunner` +
 * `githubProcessEnv(await readGitHubToken(...))`).
 *
 * WHY IT EXISTS. The inner workflow's three GitHub READ probes (CI, review
 * readiness, PR-merged) are executed by a SUBAGENT'S BASH TOOL, which inherits
 * the warm trident-fire REPL's environment. That REPL has no `GH_TOKEN`, so on
 * 2026-08-14 every probe on this instance came back
 * `To get started with GitHub CLI, please run: gh auth login`, every review
 * deferred, and every build died recorded as REQUEST_CHANGES for code no review
 * seat ever read. The WRITES carried the credential; the READS got nothing.
 * This script is what the probes shell into instead of bare `gh`.
 *
 * ── THE INVARIANTS (the card's acceptance (a) + (b)) ─────────────────────────
 *
 *  1. RESOLVED PER INVOCATION. The token is read from the `SecretsStore` in THIS
 *     process, on THIS command. It is never cached, never captured at REPL boot,
 *     never baked into a workflow argument. An owner who connects GitHub after
 *     the gateway started is authenticated on the very next probe, and a
 *     disconnect takes effect on the very next probe too.
 *
 *  2. ENVIRONMENT ONLY, AND IT DIES WITH THE PROCESS. The secret exists in the
 *     `gh` child's environment and nowhere else. It is NEVER printed (not to
 *     stdout, not to stderr, not to a log line), NEVER placed in argv (a `ps`
 *     listing is a transcript), and NEVER written to any file.
 *
 *  3. NO ON-DISK CREDENTIAL — `gh auth login` / `~/.config/gh/hosts.yml` is the
 *     REFUSED design, not an oversight. `github/credential.ts` rejects an
 *     on-disk credential explicitly and at length (options 1–3: a global
 *     credential helper, a token in the remote URL, an unscoped env helper).
 *     A hosts.yml is option 1 by another route: a credential with no expiry
 *     sitting on a box that also hosts the owner's real repos.
 *
 *  4. NOT CONNECTED DEGRADES EXACTLY AS TODAY. `token === null` → `gh` is
 *     spawned with a plain `process.env`, mirroring `githubProcessEnv(null)`
 *     being `{}`. An instance that never connected GitHub behaves precisely as
 *     it did before this file existed.
 *
 *  5. A STORE ERROR IS LOUD. A failure like `key_missing_after_restore` writes
 *     its MESSAGE (which carries no secret) to stderr and exits 2. It does NOT
 *     silently fall back to an unauthenticated `gh` — that is how a credential
 *     problem gets misreported as a GitHub problem for a week.
 *
 * USAGE (composed by `inner-workflow.mjs`'s `ghReadCommand`, which threads the
 * absolute paths it was given in the workflow args — never a secret):
 *
 *   bun trident/gh-authed.ts --db <project.db> --data-dir <owner home> \
 *     --owner <handle> -- pr view 261 --json mergeable,statusCheckRollup
 *
 * Everything after `--` is handed to `gh` verbatim.
 */

import { ProjectDb, asOwnerHandle } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { readGitHubToken, githubProcessEnv } from '@neutronai/github/credential.ts'

const EXIT_USAGE = 2

const USAGE =
  'usage: bun trident/gh-authed.ts --db <project.db> --data-dir <owner home> --owner <handle> -- <gh args...>\n'

interface ParsedArgs {
  db: string
  data_dir: string
  owner: string
  rest: string[]
}

/** Parse the fixed flag set. Returns null when anything required is missing —
 *  including an empty `gh` tail, because a bare `gh` with no subcommand prints
 *  its help and exits 0, which would read as a successful probe. */
function parseArgs(argv: string[]): ParsedArgs | null {
  const sep = argv.indexOf('--')
  if (sep === -1) return null
  const flags = argv.slice(0, sep)
  const rest = argv.slice(sep + 1)
  if (rest.length === 0) return null
  let db: string | null = null
  let data_dir: string | null = null
  let owner: string | null = null
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i]
    const value = flags[i + 1]
    if (value === undefined) return null
    if (flag === '--db') db = value
    else if (flag === '--data-dir') data_dir = value
    else if (flag === '--owner') owner = value
    else return null
  }
  if (db === null || db.length === 0) return null
  if (data_dir === null || data_dir.length === 0) return null
  if (owner === null || owner.length === 0) return null
  return { db, data_dir, owner, rest }
}

/**
 * Resolve the credential and exec `gh` with it. Returns the child's exit code so
 * the caller's `___EXIT=$?` reports what `gh` actually did, never what this
 * wrapper thought of it.
 *
 * `spawnFn` is a test seam ONLY (the credential-arrival test injects a recorder
 * to read the env it built); production passes nothing and gets `Bun.spawn`.
 */
export async function runGhAuthed(argv: string[], spawnFn?: typeof Bun.spawn): Promise<number> {
  const parsed = parseArgs(argv)
  if (parsed === null) {
    process.stderr.write(USAGE)
    return EXIT_USAGE
  }

  const spawn = spawnFn ?? Bun.spawn
  // Read-only: this process only ever READS one secret row, and a read-only
  // handle cannot be the thing that disturbs a db a live gateway is writing.
  const db = ProjectDb.open(parsed.db, { readonly: true, create: false })
  let token: string | null
  try {
    const store = new SecretsStore({ data_dir: parsed.data_dir, db })
    token = await readGitHubToken(store, asOwnerHandle(parsed.owner))
  } catch (err) {
    db.close()
    // The MESSAGE only (it carries no secret) — and exit 2, so the caller sees a
    // credential fault rather than a GitHub one.
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return EXIT_USAGE
  }

  try {
    const child = spawn(['gh', ...parsed.rest], {
      // The token lives HERE and only here: one child environment, gone when the
      // child exits. `githubProcessEnv(null)` is `{}`, so an unconnected instance
      // spawns exactly the `gh` it spawns today.
      env: { ...process.env, ...githubProcessEnv(token) },
      stdout: 'inherit',
      stderr: 'inherit',
    })
    return await child.exited
  } finally {
    db.close()
  }
}

if (import.meta.main) {
  process.exit(await runGhAuthed(process.argv.slice(2)))
}
