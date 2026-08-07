/**
 * @neutronai/github — where the instance's GitHub token LIVES, and how a child
 * process is allowed to use it.
 *
 * Two jobs, deliberately in one small file because they share a single secret
 * and separating them would spread its handling across the tree.
 *
 * ── STORAGE ──────────────────────────────────────────────────────────────────
 * The token is an ordinary `SecretsStore` row: `kind: 'oauth_token'`,
 * `label: 'github'`. No new secret kind and no parallel table — `oauth_token`
 * already exists for exactly this (`auth/secrets-store.ts:119`), the store
 * already does envelope encryption, and a second credential store is how you end
 * up with one of them un-rotated and un-audited.
 *
 * ── HANDING IT TO GIT ────────────────────────────────────────────────────────
 * This is the part with a real security decision in it, so the reasoning is
 * here rather than in a commit message.
 *
 * `gh` reads `GH_TOKEN` from the environment, which is easy. Raw `git push` over
 * HTTPS does not — it wants a credential helper. The three obvious ways to give
 * it one are all worse than the fourth:
 *
 *   1. `git config --global credential.helper` — writes the token, or a path to
 *      it, into a config file that outlives the build. On a box that hosts an
 *      owner's real repos, a credential on disk with no expiry is the thing we
 *      spent the device-flow work avoiding.
 *   2. Embedding the token in the remote URL (`https://x-access-token:TOKEN@…`)
 *      — lands in `.git/config`, in `git remote -v`, and in any error message
 *      that echoes the URL. A credential in a log by a slightly different route.
 *   3. A GLOBAL credential helper via env — works, and hands the token to
 *      whatever host the child happens to contact. An agent loop that clones a
 *      dependency from some other origin would present the owner's GitHub token
 *      to it.
 *   4. What this does: a `github.com`-SCOPED helper injected through
 *      `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`, which git
 *      reads from the ENVIRONMENT ONLY. Nothing is written to any config file,
 *      the scoping means the token is offered to github.com and nowhere else,
 *      and when the process exits the credential is simply gone.
 *
 * The helper reads `$GH_TOKEN` at call time rather than interpolating the token
 * into the config value, so the secret appears in exactly one environment
 * variable instead of two — and `GIT_CONFIG_VALUE_0` is the one an error or a
 * `ps` listing is most likely to surface.
 */

import type { OwnerHandle } from '@neutronai/persistence/index.ts'
import type { SecretsStore } from '@neutronai/auth/secrets-store.ts'

/** The `SecretsStore` coordinates for the instance's GitHub token. */
export const GITHUB_SECRET_KIND = 'oauth_token' as const
export const GITHUB_SECRET_LABEL = 'github' as const

/** Store (or replace) the instance's GitHub token. */
export async function storeGitHubToken(
  store: Pick<SecretsStore, 'put'>,
  owner_handle: OwnerHandle,
  token: string,
): Promise<void> {
  if (token.length === 0) {
    // An empty token stored is worse than none: `readGitHubToken` would return
    // a falsy-but-present value and the env builder would emit a helper that
    // authenticates as nobody, turning a missing credential into a confusing
    // 403 instead of a clean "not connected".
    throw new Error('refusing to store an empty GitHub token')
  }
  await store.put({
    owner_handle,
    kind: GITHUB_SECRET_KIND,
    label: GITHUB_SECRET_LABEL,
    plaintext: token,
  })
}

/** Read it back, or `null` when GitHub has never been connected. */
export async function readGitHubToken(
  store: Pick<SecretsStore, 'get'>,
  owner_handle: OwnerHandle,
): Promise<string | null> {
  const token = await store.get({
    owner_handle,
    kind: GITHUB_SECRET_KIND,
    label: GITHUB_SECRET_LABEL,
  })
  // Normalise an empty string to null so every caller has ONE "not connected"
  // check rather than two.
  return token !== null && token.length > 0 ? token : null
}

/**
 * The git credential helper, scoped to github.com. Reads `$GH_TOKEN` from the
 * environment at invocation rather than baking the secret into the value.
 *
 * `x-access-token` is GitHub's documented username for token auth; the password
 * field carries the token.
 */
const GITHUB_CREDENTIAL_HELPER =
  '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'

/** Config key, kept next to the helper so the scoping is visible in one place. */
const GITHUB_CREDENTIAL_KEY = 'credential.https://github.com.helper'

/**
 * Environment for a child process that needs to reach GitHub.
 *
 * Returns an EMPTY object when the instance has no token, so a caller can spread
 * it unconditionally and an unconnected instance simply behaves as it does
 * today: public clones work, pushes fail with git's own message rather than a
 * half-configured helper's.
 */
export function githubProcessEnv(token: string | null): Record<string, string> {
  if (token === null || token.length === 0) return {}
  return {
    // `gh` reads this directly.
    GH_TOKEN: token,
    // …and so does the helper below, which is why the token is not repeated
    // into GIT_CONFIG_VALUE_0.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: GITHUB_CREDENTIAL_KEY,
    GIT_CONFIG_VALUE_0: GITHUB_CREDENTIAL_HELPER,
  }
}
