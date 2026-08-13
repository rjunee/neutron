/**
 * Which credential is the box ACTUALLY dispatching with, and can it be measured?
 *
 * `resolveOpenLlmPool` (`open/composer.ts`) answers the first half for the turn
 * path, but it deliberately does not carry a token for its lowest tier: the
 * `'ambient'` credential's secret is the empty string by contract
 * (`runtime/credential-pool.ts:30-35`) because the spawned `claude` child
 * authenticates itself. That is correct for dispatch and useless for
 * measurement — you cannot ask Anthropic about a credential you are not holding.
 *
 * So this module walks the SAME precedence and resolves the ambient tier one
 * step further, to the token on disk:
 *
 *   1. `CLAUDE_CODE_OAUTH_TOKEN`      — a subscription token, measurable.
 *   2. `ANTHROPIC_API_KEY`            — per-token billing. There is no 5-hour or
 *                                       weekly ceiling to be near, so there is
 *                                       nothing to draw.
 *   3. `<CLAUDE_CONFIG_DIR|~>/.claude/.credentials.json` — where the `claude`
 *                                       CLI keeps a subscription login on Linux.
 *                                       Measurable.
 *   4. nothing                        — fresh install, pre-onboarding.
 *
 * STEP 3 IS WHY THE METER WORKS ON A HOSTED INSTANCE TOO, with no hosting-side
 * code at all. A hosting layer that manages several credentials installs the
 * currently-chosen one into exactly that file and swaps it there when it
 * rotates; the `claude` binary re-reads it per turn. Reading the same file is
 * therefore the literal definition of "the credential we are actively using" —
 * if the host swaps it, the next tick measures the new one, and no pooling or
 * multi-account concept has to exist in this repo.
 *
 * ON macOS a `claude` login lives in the Keychain rather than this file. Prying
 * it out means a `security` invocation that can prompt the user, which is not
 * something a background tick loop gets to do. That box reports "unsupported"
 * and shows no meter — an honest gap, not a fabricated zero.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { UsageUnavailableReason } from '@neutronai/contracts/credential-usage.ts'

import { readCredentialLabel } from './credential-label.ts'

export type ActiveCredential =
  /** A subscription token we hold and can therefore measure. */
  | {
      kind: 'measurable'
      token: string
      /**
       * Which account this token belongs to, when a sidecar names it and its
       * fingerprint matches. Resolved HERE, in the same call as the token, so a
       * reading can never be stamped with a different credential's label than the
       * one it measured — see `credential-label.ts`.
       */
      account_label: string | null
    }
  /** Something is configured, or nothing is, but either way there is no bar. */
  | { kind: 'unmeasurable'; reason: UsageUnavailableReason }

export interface ActiveCredentialDeps {
  /** Injected so tests never depend on the runner's real home directory. */
  readFile?: (path: string) => string
  /**
   * Reads the account-label sidecar. Injected as a whole function rather than as
   * another `readFile`, because the two files are read from different paths and a
   * test that stubs one must not silently answer for the other.
   */
  readLabel?: (token: string) => string | null
}

/**
 * Where the `claude` CLI persists a subscription login. `CLAUDE_CONFIG_DIR`
 * wins when set — the adapter already isolates per-instance config there
 * (`runtime/adapters/claude-code/persistent/spawn.ts:233`), so a box using an
 * isolated config dir must be measured through the same dir it dispatches with.
 */
export function claudeCredentialsPath(env: NodeJS.ProcessEnv): string {
  const configDir = env['CLAUDE_CONFIG_DIR']
  if (typeof configDir === 'string' && configDir.length > 0) {
    return join(configDir, '.credentials.json')
  }
  const home =
    typeof env['HOME'] === 'string' && env['HOME'].length > 0 ? env['HOME'] : homedir()
  return join(home, '.claude', '.credentials.json')
}

/**
 * Pull `claudeAiOauth.accessToken` out of a credentials blob, or `undefined`
 * when the file is absent, unreadable, or not the shape we expect. Never throws:
 * a malformed credentials file must degrade to "no meter", never to a boot or
 * tick failure.
 */
export function readClaudeCredentialsToken(
  env: NodeJS.ProcessEnv,
  deps: ActiveCredentialDeps = {},
): string | undefined {
  const read = deps.readFile ?? ((p: string): string => readFileSync(p, 'utf8'))
  let raw: string
  try {
    raw = read(claudeCredentialsPath(env))
  } catch {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const oauth = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth
    if (typeof oauth !== 'object' || oauth === null) return undefined
    const token = (oauth as { accessToken?: unknown }).accessToken
    if (typeof token !== 'string' || token.length === 0) return undefined
    return token
  } catch {
    return undefined
  }
}

/**
 * Resolve the credential the box is dispatching with, in a form the usage probe
 * can either measure or explain away. Cheap enough to call on every tick, which
 * is what makes a rotated token visible within one tick rather than one restart.
 */
export function resolveActiveCredential(
  env: NodeJS.ProcessEnv,
  deps: ActiveCredentialDeps = {},
): ActiveCredential {
  const credentialsPath = claudeCredentialsPath(env)
  // Deliberately does NOT inherit `deps.readFile`: the two files live at different
  // paths, and a stub that answered for both would let a test "pass" by feeding the
  // credentials blob to the label parser. A test that wants a label injects
  // `readLabel`; one that does not gets the real reader, which finds no sidecar.
  const label = deps.readLabel ?? ((t): string | null => readCredentialLabel(credentialsPath, t))
  const envToken = env['CLAUDE_CODE_OAUTH_TOKEN']
  if (typeof envToken === 'string' && envToken.length > 0) {
    return { kind: 'measurable', token: envToken, account_label: label(envToken) }
  }
  const apiKey = env['ANTHROPIC_API_KEY']
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    return { kind: 'unmeasurable', reason: 'unsupported_credential' }
  }
  const fileToken = readClaudeCredentialsToken(env, deps)
  if (fileToken !== undefined) {
    return { kind: 'measurable', token: fileToken, account_label: label(fileToken) }
  }
  return { kind: 'unmeasurable', reason: 'no_credential' }
}
