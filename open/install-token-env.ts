/**
 * Production side effects for the Open install-token handoff: persist the
 * captured OAuth token to the code-dir `.env` and ask the supervisor to
 * respawn the process so the composer re-resolves a LIVE substrate.
 *
 * Kept out of `install-token-handoff.ts` so the route logic stays pure and
 * unit-testable; the composer injects these as `persistToken` / `requestRestart`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN_LINE_RE = /^[\t ]*(?:export[\t ]+)?CLAUDE_CODE_OAUTH_TOKEN=/

/**
 * Default `.env` path = `<cwd>/.env`. The launchd/systemd unit sets
 * `WorkingDirectory=<code dir>` and Bun auto-loads `.env` from cwd at boot, so
 * the cwd `.env` is exactly the file the NEXT boot reads.
 */
export function defaultEnvFilePath(): string {
  return join(process.cwd(), '.env')
}

/**
 * Write `CLAUDE_CODE_OAUTH_TOKEN=<token>` into `.env`, replacing any existing
 * (possibly `export`-prefixed) line, else appending. Mirrors install.sh's
 * `persist_oauth_token_to_env`. Synchronous + atomic-ish (single writeFileSync).
 */
export function persistOauthTokenToEnv(token: string, envFilePath = defaultEnvFilePath()): void {
  const existing = existsSync(envFilePath) ? readFileSync(envFilePath, 'utf8') : ''
  const lines = existing.length > 0 ? existing.split('\n') : []
  const kept = lines.filter((l) => !TOKEN_LINE_RE.test(l))
  // Drop a single trailing empty element from a file that ended in '\n' so we
  // don't accumulate blank lines on repeated writes.
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  kept.push(`CLAUDE_CODE_OAUTH_TOKEN=${token}`)
  writeFileSync(envFilePath, kept.join('\n') + '\n', { mode: 0o600 })
}

/**
 * Ask the supervisor (launchd `KeepAlive` / systemd `Restart=always`) to
 * respawn this process. We exit cleanly a beat AFTER the `/complete` response
 * has flushed; the supervisor relaunches within ~5–10s and the new process
 * reads the freshly-persisted token from `.env`.
 *
 * `delayMs` gives the 204 time to reach the bash one-liner before the socket
 * closes. Best-effort: if the box is run UN-supervised (a bare `bun` dev run),
 * the process simply exits and the operator restarts it manually — the handoff
 * page surfaces that fallback in copy.
 */
export function requestSupervisorRestart(delayMs = 300): void {
  setTimeout(() => {
    // eslint-disable-next-line n/no-process-exit
    process.exit(0)
  }, delayMs).unref?.()
}
