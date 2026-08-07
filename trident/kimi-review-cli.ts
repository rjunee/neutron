/**
 * The subprocess entry point the review workflow shells into.
 *
 * The workflow cannot reach a non-Anthropic model through `agent({model})` — that
 * resolves against Claude Code's own endpoint — so the Kimi panelist is a thin
 * Claude agent that runs this and reads the exit code, exactly as `argus:codex`
 * runs `trident/codex-review.sh`. Same shape, same contract, so the two
 * cross-model peers behave identically from the panel's point of view.
 *
 * THE KEY NEVER ENTERS THE WORKFLOW. The workflow is threaded a BOOLEAN
 * (`kimiConfigured`); the credential is read here, in a fresh process, from the
 * environment. Nothing that reaches a prompt, a log line, or a chat message ever
 * holds it. This is also why the credential is read at INVOCATION rather than
 * cached: each review is its own process, so there is no long-lived copy to go
 * stale (the composition-time-credential problem recorded in the Decisions Log
 * for 2026-08-07).
 *
 * Exit codes deliberately mirror `codex-review.sh` so the panelist prompts can be
 * near-identical:
 *
 *   0   connected     — review text on stdout
 *   10  not_connected — no credential; the GRACEFUL path, never blocking
 *   3   deferred      — configured but failed/timed out/answerless. BLOCKS.
 *
 * Usage: bun run trident/kimi-review-cli.ts <diff-file> [task...]
 */

import { readFileSync } from 'node:fs'

import { reviewWithKimi } from './kimi-review.ts'

const EXIT_CONNECTED = 0
const EXIT_USAGE = 2
const EXIT_DEFERRED = 3
const EXIT_NOT_CONNECTED = 10

async function main(): Promise<number> {
  const [diffFile, ...taskParts] = process.argv.slice(2)
  if (diffFile === undefined || diffFile.length === 0) {
    process.stderr.write('usage: bun run trident/kimi-review-cli.ts <diff-file> [task...]\n')
    return EXIT_USAGE
  }

  let diff: string
  try {
    diff = readFileSync(diffFile, 'utf8')
  } catch (err) {
    // An unreadable diff is DEFERRED, not not_connected: the reviewer was asked
    // to run and could not, which must block rather than read as "not set up".
    process.stderr.write(`could not read diff file: ${err instanceof Error ? err.message : String(err)}\n`)
    return EXIT_DEFERRED
  }

  const apiKey = process.env['KIMI_API_KEY'] ?? null
  const result = await reviewWithKimi({
    diff,
    task: taskParts.join(' '),
    apiKey: apiKey !== null && apiKey.length > 0 ? apiKey : null,
    ...(process.env['KIMI_MODEL'] !== undefined ? { model: process.env['KIMI_MODEL'] } : {}),
  })

  if (result.status === 'connected') {
    process.stdout.write(result.text)
    return EXIT_CONNECTED
  }
  // The reason goes to stderr so the panelist can quote it as evidence without
  // it being mistaken for review text on stdout.
  process.stderr.write(`${result.reason ?? result.status}\n`)
  return result.status === 'not_connected' ? EXIT_NOT_CONNECTED : EXIT_DEFERRED
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // Never exit 0 on an unexpected throw — that would read as a clean review.
    process.stderr.write(`kimi-review-cli crashed: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(EXIT_DEFERRED)
  },
)
