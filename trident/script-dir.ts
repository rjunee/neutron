/**
 * @neutronai/trident — WHERE TRIDENT'S OWN SCRIPTS ARE, resolved once.
 *
 * `inner-workflow.mjs`, `codex-build.sh`, `checkpoint.sh`, `stage-stamp.sh`,
 * `codex-review.sh`, `worktree-cleanup.sh` and `gh-authed.ts` are siblings of
 * this file, so this directory is where all of them live: the REPOSITORY during
 * dev and test, and the DEPLOYED tree in production. Nothing else about the
 * running system tells you which — the build's cwd is the repo being BUILT, and
 * it need not contain `trident/` at all.
 *
 * It is its own module, rather than a constant inside `inner-loop.ts`, so the
 * spawn confinement that decides what a launcher may READ can import it without
 * pulling in the whole inner loop. Both halves must agree, and the only way to
 * guarantee that is for both to come from here: #734 confined the trident
 * substrates to their cwd, `import.meta.url` resolves inside the repo in every
 * test, and on the one instance where the deployed tree differs the launcher was
 * refused the script it exists to fire — three dispatches on 2026-09-14, each
 * answered `scriptPath must be a script path this tool returned, or a file you
 * can already read`, with every unit test green.
 */
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TRIDENT_SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
