/**
 * Where the Kimi K3 API key comes from — env, or the owner's stored credential.
 *
 * WHY THIS EXISTS. The K3 cross-model reviewer only ever read
 * `process.env.KIMI_API_KEY`, which means a self-hoster could not turn it on at
 * all: there is no supported way to set a gateway env var from inside the product,
 * so the second model family in the review panel was reachable only by whoever
 * could edit the service unit. The owner asked for the key to be enterable in
 * Open's settings before cutover (SPEC Decisions Log 2026-08-07). Settings already
 * stores arbitrary per-service credentials; nothing read one for Kimi.
 *
 * ENV WINS, deliberately. An existing install that exports `KIMI_API_KEY` keeps
 * behaving exactly as before — the store is consulted only when the env var is
 * absent or empty, so this can never change which key a working deployment uses.
 *
 * THE KEY IS NEVER RETURNED INTO A PROMPT. `resolve_kimi_configured` converts it
 * to a BOOLEAN before it crosses into the workflow, and the reviewer subprocess
 * reads the value from its own environment. That property is the reason the
 * plumbing looks indirect, and it must survive any change here: a key in an
 * `agent()` prompt is a key in a transcript, a log line, and a chat message.
 */

/** The credential-store service id an owner files their Kimi key under. */
export const KIMI_CREDENTIAL_SERVICE = 'kimi'

/** The environment variable the reviewer subprocess reads. */
export const KIMI_API_KEY_ENV = 'KIMI_API_KEY'

/**
 * The stored-credential lookup, narrowed to the one call this needs so the
 * resolver stays testable without a database. Returns the decrypted key, or null.
 */
export interface KimiKeyLookup {
  (): string | null
}

/**
 * Resolve the key: environment first, stored credential second, else null.
 *
 * A whitespace-only or empty value counts as ABSENT at every layer — an env var
 * exported as `""` is the most common way a key is "set" and useless, and letting
 * it win would mask a perfectly good stored credential.
 */
export function resolveKimiApiKey(
  envValue: string | undefined | null,
  lookup: KimiKeyLookup | null,
): string | null {
  const fromEnv = typeof envValue === 'string' ? envValue.trim() : ''
  if (fromEnv.length > 0) return fromEnv
  if (lookup === null) return null
  let stored: string | null
  try {
    stored = lookup()
  } catch {
    // A store read must never take down a review launch. An unreadable credential
    // is "not configured", which is the graceful path the panel already handles.
    return null
  }
  const fromStore = typeof stored === 'string' ? stored.trim() : ''
  return fromStore.length > 0 ? fromStore : null
}

/**
 * Resolve the key AND make sure the reviewer subprocess can see it, returning
 * whether K3 is configured at all.
 *
 * THE SIDE EFFECT IS THE POINT, and it is why this is not just `resolveKimiApiKey`
 * at the call site. `trident/kimi-review-cli.ts` runs in its own process and reads
 * `KIMI_API_KEY` from ITS environment — that indirection is what keeps the key out
 * of prompt text. A key that lives only in the credential store would therefore
 * resolve to `configured: true` and then fail in the child with "no key", which is
 * a worse outcome than not being configured at all: a deferred reviewer BLOCKS the
 * verdict, so every review would come back REQUEST_CHANGES for a reason the owner
 * cannot see. Exporting it here closes that gap at the one moment the answer is
 * needed.
 *
 * Called PER LAUNCH rather than at boot, so a key entered in settings takes effect
 * on the next run instead of the next restart.
 */
export function ensureKimiKeyExported(
  env: Record<string, string | undefined>,
  lookup: KimiKeyLookup | null,
): boolean {
  const key = resolveKimiApiKey(env[KIMI_API_KEY_ENV], lookup)
  if (key === null) return false
  // Only write when it differs: a no-op assignment on every launch is noise, and
  // an env var the operator set by hand should keep its exact value.
  if (env[KIMI_API_KEY_ENV] !== key) env[KIMI_API_KEY_ENV] = key
  return true
}
