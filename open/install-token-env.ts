/**
 * Production side effects for the Open install-token handoff: persist the
 * captured OAuth token to the code-dir `.env` and ask the supervisor to
 * respawn the process so the composer re-resolves a LIVE substrate.
 *
 * Kept out of `install-token-handoff.ts` so the route logic stays pure and
 * unit-testable; the composer injects these as `persistToken` / `requestRestart`.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
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

/** The operator override env var for where the install token is persisted. */
const INSTALL_TOKEN_ENV_PATH_VAR = 'NEUTRON_INSTALL_TOKEN_ENV_PATH'

/**
 * Resolve WHERE the captured install token is persisted / restored.
 *
 * Default (single-owner install): `<cwd>/.env` — the owner runs the process out
 * of their own writable code dir, and Bun auto-loads that file at boot. UNCHANGED.
 *
 * Override (`NEUTRON_INSTALL_TOKEN_ENV_PATH`): a per-instance writable path. An
 * operator who runs MULTIPLE isolated instances against ONE shared, read-only
 * code checkout (so cwd is not writable by the per-instance user) points each
 * instance at its own writable env file. This is a plain override path, not a
 * feature flag: when the var is unset the default behavior is byte-for-byte the
 * same, so single-owner installs are 100% unaffected.
 */
export function resolveInstallTokenEnvFilePath(): string {
  const override = process.env[INSTALL_TOKEN_ENV_PATH_VAR]
  if (typeof override === 'string' && override.trim().length > 0) return override.trim()
  return defaultEnvFilePath()
}

/**
 * Write `CLAUDE_CODE_OAUTH_TOKEN=<token>` into `.env`, replacing any existing
 * (possibly `export`-prefixed) line, else appending. Mirrors install.sh's
 * `persist_oauth_token_to_env`. Synchronous + atomic-ish (single writeFileSync).
 */
export function persistOauthTokenToEnv(
  token: string,
  envFilePath = resolveInstallTokenEnvFilePath(),
): void {
  const existing = existsSync(envFilePath) ? readFileSync(envFilePath, 'utf8') : ''
  const lines = existing.length > 0 ? existing.split('\n') : []
  const kept = lines.filter((l) => !TOKEN_LINE_RE.test(l))
  // Drop a single trailing empty element from a file that ended in '\n' so we
  // don't accumulate blank lines on repeated writes.
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  kept.push(`CLAUDE_CODE_OAUTH_TOKEN=${token}`)
  writeFileSync(envFilePath, kept.join('\n') + '\n', { mode: 0o600 })
  // `mode` on writeFileSync only applies when CREATING the file — an existing
  // `.env` (e.g. 0644 from a template or manual setup) keeps its old perms. We
  // are writing a long-lived OAuth secret, so force 0600 regardless of prior
  // mode (Codex review P2). Best-effort: a chmod failure (e.g. exotic FS) must
  // not abort the handoff — the token is already persisted.
  try {
    chmodSync(envFilePath, 0o600)
  } catch {
    /* non-fatal */
  }
}

/**
 * Restore a previously-persisted OAuth token into `process.env` at boot.
 *
 * Bun auto-loads `<cwd>/.env` at startup, so on a single-owner install the token
 * is already in `process.env` before this runs and the file/`process.env`
 * fast-path below no-ops harmlessly. But when an operator has pointed
 * `NEUTRON_INSTALL_TOKEN_ENV_PATH` at a writable file OUTSIDE cwd (an isolated
 * instance against a shared read-only checkout), Bun's cwd-relative auto-load
 * never sees it — so a freshly-booted process would resolve NO substrate even
 * though a token was captured on a prior boot. This closes that gap: it resolves
 * the SAME path `persistOauthTokenToEnv` writes to, parses a
 * `CLAUDE_CODE_OAUTH_TOKEN=` line, and seeds `process.env` from it.
 *
 * NEVER clobbers an already-set `CLAUDE_CODE_OAUTH_TOKEN` — an explicitly
 * provided credential (operator env, Bun's own cwd auto-load) always wins; this
 * is purely a fallback restore. Best-effort: a missing/unreadable file is a
 * no-op (the box simply boots credential-less and the handoff gate renders).
 *
 * Call this EARLY at boot, before the composer resolves the LLM substrate.
 */
export function loadPersistedInstallToken(): void {
  if (
    typeof process.env['CLAUDE_CODE_OAUTH_TOKEN'] === 'string' &&
    process.env['CLAUDE_CODE_OAUTH_TOKEN'].length > 0
  ) {
    return // an explicit credential is already present — never override it.
  }
  const envFilePath = resolveInstallTokenEnvFilePath()
  let contents: string
  try {
    if (!existsSync(envFilePath)) return
    contents = readFileSync(envFilePath, 'utf8')
  } catch {
    return // unreadable → boot credential-less; the handoff gate handles it.
  }
  for (const raw of contents.split('\n')) {
    if (!TOKEN_LINE_RE.test(raw)) continue
    const eq = raw.indexOf('=')
    if (eq < 0) continue
    // Strip an optional surrounding pair of quotes; the token itself has none.
    const value = raw.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    if (value.length > 0) process.env['CLAUDE_CODE_OAUTH_TOKEN'] = value
    return
  }
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
